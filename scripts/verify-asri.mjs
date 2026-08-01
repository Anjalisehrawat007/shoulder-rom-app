#!/usr/bin/env node
/**
 * verify-asri.mjs
 * ----------------------------------------------------------------------------
 * Synthetic checks for shared/asri/*, run against the REAL published config
 * files (config/asri-config.v2.json, config/reference-datasets.v1.json), not
 * a synthetic config -- so this exercises the actual weight/aggregation
 * setup a session would use, not just the engine's internal logic in
 * isolation.
 *
 * Confirms:
 *  1. Each category's aggregation strategy behaves as configured (ROM picks
 *     the best-across-tasks value; Compensation picks the worst; Movement
 *     Quality averages) -- verified via the engine's own contribution trace,
 *     which doubles as evidence the explainability trace is itself usable.
 *  2. Symmetry reports insufficient_data with no bilateral input (current
 *     capture protocol only tests one side).
 *  3. Confidence-aware scoring: an all-measured/high-confidence session
 *     reports meaningfully higher Overall Confidence % than an otherwise
 *     identical all-estimated/low-confidence session.
 *
 * NOT clinical validation -- see docs/asri.md §9 and shared/validation/README.md.
 * Run: node scripts/verify-asri.mjs
 * ----------------------------------------------------------------------------
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { VersionedConfigStore, AsriEngine } from "../shared/asri/asri-engine.js";
import { resolveReferenceDataset } from "../shared/asri/reference-datasets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const asriConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/asri-config.v2.json"), "utf8"));
const referenceConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/reference-datasets.v1.json"), "utf8"));

const store = new VersionedConfigStore();
store.publish(asriConfig);
const engine = new AsriEngine(store.getActive());
const referenceTargets = resolveReferenceDataset(referenceConfig, {}).targets; // no patient context -> "default"

let failures = 0;
function assertClose(label, actual, expected, tolerance = 1) {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tolerance;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ~${expected}, got ${actual} (diff ${diff.toFixed(2)})`);
  if (!ok) failures++;
}
function assertEqual(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ${expected}, got ${actual}`);
  if (!ok) failures++;
}
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}

function param(value, measurementType, confidence) {
  return { value, unit: "deg", measurementType, confidence, limitation: measurementType === "measured" ? "" : "synthetic test value" };
}

/** Build a full per-task parameter set; `overrides` patches specific keys for that task. */
function taskParams({ measurementType = "measured", confidence = "high", overrides = {} } = {}) {
  const base = {
    shoulderAbductionDeg: param(100, measurementType, confidence),
    shoulderFlexionDeg: param(100, measurementType, confidence),
    externalRotationDeg: param(60, measurementType, confidence),
    internalRotationDeg: param(50, measurementType, confidence),
    movementSmoothness: param(80, measurementType, confidence),
    movementSpeed: param(1.0, measurementType, confidence),
    trunkLateralLeanDeg: param(10, measurementType, confidence),
    trunkRotationDeg: param(10, measurementType, confidence),
    scapularTiltDeg: param(20, measurementType, confidence),
    scapularWingingFlag: param(false, measurementType, confidence),
  };
  return { ...base, ...overrides };
}

console.log("--- ROM: best-across-tasks ---");
{
  const perTaskParameters = {
    reach_head: taskParams({ overrides: { shoulderAbductionDeg: param(100, "measured", "high") } }),
    reach_mouth: taskParams({ overrides: { shoulderAbductionDeg: param(150, "measured", "high") } }),
    comb_hair: taskParams({ overrides: { shoulderAbductionDeg: param(120, "measured", "high") } }),
  };
  const result = engine.score({ perTaskParameters, referenceTargets, stage01: 0.5 });
  const contribution = result.categories.rom.contributions.find((c) => c.parameter === "shoulderAbductionDeg");
  assertClose("abduction normalizedScore picks best (150/170*100)", contribution.normalizedScore, (150 / 170) * 100, 0.5);
  assertEqual("abduction sourceTaskId is reach_mouth (the 150deg task)", contribution.sourceTaskId, "reach_mouth");
}

console.log("\n--- Movement Quality: average-across-tasks ---");
{
  const perTaskParameters = {
    reach_head: taskParams({ overrides: { movementSmoothness: param(90, "estimated", "low") } }),
    reach_mouth: taskParams({ overrides: { movementSmoothness: param(70, "estimated", "low") } }),
    comb_hair: taskParams({ overrides: { movementSmoothness: param(80, "estimated", "low") } }),
  };
  const result = engine.score({ perTaskParameters, referenceTargets, stage01: 0.5 });
  const contribution = result.categories.movementQuality.contributions.find((c) => c.parameter === "movementSmoothness");
  assertClose("smoothness normalizedScore is the average (90+70+80)/3", contribution.normalizedScore, (90 + 70 + 80) / 3, 0.5);
}

console.log("\n--- Compensation: worst (minimum normalized score) across tasks ---");
{
  const perTaskParameters = {
    reach_head: taskParams({ overrides: { trunkLateralLeanDeg: param(10, "measured", "moderate") } }),
    reach_mouth: taskParams({ overrides: { trunkLateralLeanDeg: param(10, "measured", "moderate") } }),
    comb_hair: taskParams({ overrides: { trunkLateralLeanDeg: param(30, "measured", "moderate") } }), // worst compensation
  };
  const result = engine.score({ perTaskParameters, referenceTargets, stage01: 0.5 });
  const contribution = result.categories.compensation.contributions.find((c) => c.parameter === "trunkLateralLeanDeg");
  assertEqual("worst-compensation task selected", contribution.sourceTaskId, "comb_hair");
  assertTrue("worst normalizedScore is lower than the other two tasks' would be", contribution.normalizedScore < 50, `got ${contribution.normalizedScore}`);
}

console.log("\n--- Symmetry: insufficient data without bilateral capture ---");
{
  const perTaskParameters = { reach_head: taskParams() };
  const result = engine.score({ perTaskParameters, referenceTargets, stage01: 0.5 });
  assertEqual("symmetry score is null", result.categories.symmetry.score, null);
  assertEqual("symmetry status", result.categories.symmetry.status, "insufficient_data");
}

console.log("\n--- Confidence-aware scoring: measured/high vs estimated/low ---");
{
  const fullTaskSet = (measurementType, confidence) => ({
    reach_head: taskParams({ measurementType, confidence }),
    reach_mouth: taskParams({ measurementType, confidence }),
    comb_hair: taskParams({ measurementType, confidence }),
    lift_arm: taskParams({ measurementType, confidence }),
  });
  const highConf = engine.score({ perTaskParameters: fullTaskSet("measured", "high"), referenceTargets, stage01: 0.5 });
  const lowConf = engine.score({ perTaskParameters: fullTaskSet("estimated", "low"), referenceTargets, stage01: 0.5 });
  assertTrue(
    "measured/high overall confidence is much higher than estimated/low",
    highConf.overallConfidencePct - lowConf.overallConfidencePct > 30,
    `high=${highConf.overallConfidencePct}%, low=${lowConf.overallConfidencePct}%`
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
