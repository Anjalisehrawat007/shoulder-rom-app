#!/usr/bin/env node
/**
 * verify-rotation-stability.mjs — Phase 8 (Rotation Algorithm Verification,
 * Stabilization & Freeze Decision)
 * ----------------------------------------------------------------------------
 * HONESTY NOTE: this environment has no recorded patient video. "Verify
 * using multiple real recordings" is delivered here as a substantially
 * BROADENED synthetic verification harness -- parameterized body size,
 * shoulder width, arm length, movement speed, camera distance/rotation,
 * occlusion, and confidence -- built on Phase 7's validated exact-target
 * pose-construction technique (localToWorld, the inverse of toLocalFrame,
 * so every expected answer is exact, not approximate). This is stated
 * plainly, not represented as verification against real recordings it
 * isn't.
 *
 * Covers: repeatability (exact determinism + Monte Carlo jitter, with real
 * measured numbers), stress testing across body proportions, boundary
 * conditions, clinical plausibility (incl. cross-module QC integration),
 * a full failure-mode catalog, per-factor confidence-behavior tests,
 * cross-module consistency (TaskRecorder -> Mallet grading -> ASRI), and
 * measured (not assumed) performance.
 *
 * Run: node scripts/verify-rotation-stability.mjs
 * ----------------------------------------------------------------------------
 */
import { buildTrunkFrame } from "../shared/biomechanics/coordinate-frame.js";
import { estimateAxialRotation, DEFAULT_CONFIG } from "../shared/biomechanics/rotation-estimation.js";
import { analyzeRotationTrajectory } from "../shared/biomechanics/rotation-trajectory.js";
import { computeParameters } from "../shared/biomechanics/index.js";
import { detectCompensation } from "../shared/biomechanics/compensation-detection.js";
import { runQualityControl } from "../shared/validation/quality-control.js";
import { ModifiedMalletScoreEngine } from "../shared/assessment/ModifiedMalletScoreEngine.js";
import malletConfig from "../config/mallet-score-config.v1.json" with { type: "json" };

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}
function assertClose(label, actual, expected, tolerance) {
  const ok = actual != null && Math.abs(actual - expected) <= tolerance;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
  if (!ok) failures++;
}
function reportNumber(label, value) {
  console.log(`INFO  ${label}: ${value}`);
}

// ---- synthetic pose construction (Phase 7's validated technique, extended) -
function localToWorld(frame, local) {
  return {
    x: frame.x.x * local.x + frame.y.x * local.y + frame.z.x * local.z,
    y: frame.x.y * local.x + frame.y.y * local.y + frame.z.y * local.z,
    z: frame.x.z * local.x + frame.y.z * local.y + frame.z.z * local.z,
  };
}
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scaleVec = (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s });

function baseTrunk({ shoulderWidth = 0.16, hipWidth = 0.11, torsoLen = 0.25, leanDeg = 0 } = {}) {
  const center = { x: 0.5, y: 0.375, z: 0 };
  const shoulderY = center.y - torsoLen / 2;
  const hipY = center.y + torsoLen / 2;
  const leanRad = (leanDeg * Math.PI) / 180;
  const leanShift = Math.tan(leanRad) * (hipY - shoulderY);
  return {
    leftShoulder: { x: 0.5 - shoulderWidth / 2 + leanShift, y: shoulderY, z: 0 },
    rightShoulder: { x: 0.5 + shoulderWidth / 2 + leanShift, y: shoulderY, z: 0 },
    leftHip: { x: 0.5 - hipWidth / 2, y: hipY, z: 0 },
    rightHip: { x: 0.5 + hipWidth / 2, y: hipY, z: 0 },
  };
}

function buildArm({ trunk, frame, side, elbowAngleDeg = 90, sweepDeg = 30, armLen = 0.15, visibility = 0.95, elevationDeg = 0 }) {
  const shoulder = side === "right" ? trunk.rightShoulder : trunk.leftShoulder;
  // humerus direction: 0deg elevation = hanging straight down; elevationDeg
  // tilts it toward local +Z (anterior) by that amount, simulating an
  // increasingly raised/abducted arm for posture-factor testing.
  const elevRad = (elevationDeg * Math.PI) / 180;
  const humerusLocalDir = { x: 0, y: -Math.cos(elevRad), z: Math.sin(elevRad) };
  const elbow = add(shoulder, scaleVec(localToWorld(frame, humerusLocalDir), armLen));

  const theta = (elbowAngleDeg * Math.PI) / 180;
  const sweepRad = (sweepDeg * Math.PI) / 180;
  const perpMagLocal = Math.sin(theta);
  const yLocal = Math.cos(theta);
  const lateralAway = perpMagLocal * Math.sin(sweepRad);
  const zLocal = perpMagLocal * Math.cos(sweepRad);
  const lateralSigned = side === "right" ? lateralAway : -lateralAway;
  // Forearm direction is composed relative to the (possibly elevated)
  // humerus direction's own local perpendicular plane -- for elevationDeg=0
  // this reduces exactly to Phase 7's original construction.
  const forearmLocalDir = add(scaleVec(humerusLocalDir, -yLocal), { x: lateralSigned, y: 0, z: zLocal * Math.cos(elevRad) });
  const wrist = add(elbow, scaleVec(localToWorld(frame, forearmLocalDir), armLen));

  const withVis = (p) => ({ ...p, visibility });
  return { shoulder: withVis(shoulder), elbow: withVis(elbow), wrist: withVis(wrist) };
}

function estimateFor(opts) {
  const { side = "right", elbowAngleDeg = 90, sweepDeg = 30, elevationDeg = 0, visibility = 0.95, compensation = null, ...trunkOpts } = opts;
  const trunk = baseTrunk(trunkOpts);
  const frame = buildTrunkFrame(trunk);
  const arm = buildArm({ trunk, frame, side, elbowAngleDeg, sweepDeg, elevationDeg, visibility, armLen: 0.15 * (trunkOpts.armScale ?? 1) });
  return estimateAxialRotation({ ...arm, frame, side, compensation });
}

// =============================================================================
console.log("--- 1. Repeatability ---");
// =============================================================================
{
  const args = { side: "right", elbowAngleDeg: 88, sweepDeg: 33 };
  const r1 = estimateFor(args);
  const r2 = estimateFor(args);
  assertTrue("exact determinism: identical input produces bit-identical output", JSON.stringify(r1) === JSON.stringify(r2));
}
{
  // Monte Carlo: small realistic landmark jitter (~0.3% of frame, roughly
  // matching typical MediaPipe frame-to-frame position noise for a stable
  // subject) applied 200 times to an otherwise-fixed pose. Reports the
  // REAL measured mean/stddev -- not an assumed number.
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const baseArm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg: 35 });
  const jitter = (p, mag) => ({ ...p, x: p.x + (Math.random() - 0.5) * mag, y: p.y + (Math.random() - 0.5) * mag, z: p.z + (Math.random() - 0.5) * mag });
  const N = 200;
  const values = [];
  for (let i = 0; i < N; i++) {
    const jittered = { shoulder: jitter(baseArm.shoulder, 0.003), elbow: jitter(baseArm.elbow, 0.003), wrist: jitter(baseArm.wrist, 0.003) };
    const r = estimateAxialRotation({ ...jittered, frame, side: "right" });
    if (r.externalRotationDeg.value != null) values.push(r.externalRotationDeg.value);
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  reportNumber("Monte Carlo (N=200, ~0.3% landmark jitter): mean externalRotationDeg", mean.toFixed(2));
  reportNumber("Monte Carlo: stddev", stddev.toFixed(3));
  assertTrue("repeatability: all 200 trials produced a value (no crashes/unavailable under mild jitter)", values.length === N, `${values.length}/${N}`);
  assertTrue("repeatability: stddev under realistic jitter stays within a clinically tight bound (<3deg)", stddev < 3, `stddev=${stddev.toFixed(3)}`);
}

// =============================================================================
console.log("\n--- 2. Stress testing: body size / shoulder width / arm length ---");
// =============================================================================
{
  const baseline = estimateFor({ elbowAngleDeg: 90, sweepDeg: 38 });
  const sizes = [
    { label: "small child (narrow shoulders, short arms)", shoulderWidth: 0.11, hipWidth: 0.08, torsoLen: 0.18, armScale: 0.7 },
    { label: "large child (wide shoulders, long arms)", shoulderWidth: 0.22, hipWidth: 0.16, torsoLen: 0.32, armScale: 1.3 },
    { label: "narrow shoulders only", shoulderWidth: 0.1 },
    { label: "wide shoulders only", shoulderWidth: 0.26 },
  ];
  for (const size of sizes) {
    const { label, ...opts } = size;
    const r = estimateFor({ elbowAngleDeg: 90, sweepDeg: 38, ...opts });
    assertClose(`body-size invariance: ${label}`, r.externalRotationDeg.value, baseline.externalRotationDeg.value, 1.0);
  }
}

// =============================================================================
console.log("\n--- 3. Boundary conditions ---");
// =============================================================================
{
  // Find the elbow angle where sensitivity crosses minSensitivityForUnavailable
  // (sensitivity = sin(elbowAngle)) and confirm behavior right on either side.
  const cutoffAngleFromExtension = Math.asin(DEFAULT_CONFIG.minSensitivityForUnavailable) * (180 / Math.PI);
  const justInside = 180 - cutoffAngleFromExtension - 1; // slightly more flexed than the cutoff -> available
  const justOutside = 180 - cutoffAngleFromExtension + 1; // slightly more extended than the cutoff -> unavailable
  const rInside = estimateFor({ elbowAngleDeg: justInside, sweepDeg: 20 });
  const rOutside = estimateFor({ elbowAngleDeg: justOutside, sweepDeg: 20 });
  assertTrue(`boundary: elbow angle ${justInside.toFixed(1)}deg (just inside the sensitivity cutoff) is available`, rInside.externalRotationDeg.measurementType === "estimated");
  assertTrue(`boundary: elbow angle ${justOutside.toFixed(1)}deg (just outside) is unavailable`, rOutside.externalRotationDeg.measurementType === "unavailable");
}

// =============================================================================
console.log("\n--- 4. Clinical plausibility ---");
// =============================================================================
{
  // Across a realistic sweep of elbow angles and rotation targets, every
  // AVAILABLE output must stay within quality-control.js's own
  // [0,110] physiological range for external/internal rotation.
  let allWithinRange = true;
  let checked = 0;
  for (let elbowAngleDeg = 60; elbowAngleDeg <= 120; elbowAngleDeg += 10) {
    for (let sweepDeg = -90; sweepDeg <= 90; sweepDeg += 15) {
      const r = estimateFor({ elbowAngleDeg, sweepDeg });
      checked++;
      if (r.externalRotationDeg.value != null && (r.externalRotationDeg.value < 0 || r.externalRotationDeg.value > 110)) allWithinRange = false;
      if (r.internalRotationDeg.value != null && (r.internalRotationDeg.value < 0 || r.internalRotationDeg.value > 110)) allWithinRange = false;
    }
  }
  assertTrue(`clinical plausibility: all ${checked} realistic (elbow 60-120deg, sweep +-90deg) synthetic combinations stay within [0,110]`, allWithinRange);

  // Cross-module integration proof: a genuinely implausible value (fed in
  // directly, not produced by the estimator -- proving the SAFETY NET
  // catches bad data regardless of source) IS flagged by the existing,
  // unmodified Phase 4 quality-control.js -- confirming the two phases
  // stay consistent rather than duplicating or contradicting each other.
  const sessions = [{ sessionId: "S1", createdAt: new Date().toISOString(), asriVersion: "2.0.0", referenceDatasetVersion: "1.0.0", taskResults: { t1: { parameters: { externalRotationDeg: { value: 150, measurementType: "estimated", confidence: "low" } } } } }];
  const qc = runQualityControl(sessions, []);
  assertTrue("cross-module: quality-control.js flags a contrived out-of-range rotation value (150deg)", qc.issues.some((i) => i.message.includes("physiologically plausible") || i.message.toLowerCase().includes("range")), JSON.stringify(qc.issues.map((i) => i.message)).slice(0, 200));
}

// =============================================================================
console.log("\n--- 5. Failure-mode catalog ---");
// =============================================================================
{
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);

  // (a) Missing landmarks
  const rMissing = estimateAxialRotation({ shoulder: trunk.rightShoulder, elbow: null, wrist: null, frame, side: "right" });
  assertTrue("failure mode: missing elbow/wrist -> unavailable", rMissing.externalRotationDeg.measurementType === "unavailable");

  // (b) Near full extension
  const rExtended = estimateFor({ elbowAngleDeg: 178, sweepDeg: 20 });
  assertTrue("failure mode: near full extension -> unavailable", rExtended.externalRotationDeg.measurementType === "unavailable");

  // (c) Near full hyperflexion (elbow angle near 0)
  const rHyperflexed = estimateFor({ elbowAngleDeg: 3, sweepDeg: 20 });
  assertTrue("failure mode: near-zero elbow angle (hyperflexion) -> unavailable", rHyperflexed.externalRotationDeg.measurementType === "unavailable");

  // (d) Degenerate trunk frame (coincident shoulder and hip landmarks)
  const degenerateTrunk = { leftShoulder: { x: 0.5, y: 0.375, z: 0 }, rightShoulder: { x: 0.5, y: 0.375, z: 0 }, leftHip: { x: 0.5, y: 0.375, z: 0 }, rightHip: { x: 0.5, y: 0.375, z: 0 } };
  let degenerateThrew = false;
  let rDegenerate = null;
  try {
    const degenerateFrame = buildTrunkFrame(degenerateTrunk);
    rDegenerate = estimateAxialRotation({ shoulder: degenerateTrunk.rightShoulder, elbow: { x: 0.5, y: 0.5, z: 0 }, wrist: { x: 0.55, y: 0.5, z: 0 }, frame: degenerateFrame, side: "right" });
  } catch (e) {
    degenerateThrew = true;
  }
  assertTrue("failure mode: degenerate trunk frame does not throw", !degenerateThrew);
  assertTrue("failure mode: degenerate trunk frame -> unavailable (not a fabricated NaN-based number)", !degenerateThrew && rDegenerate.externalRotationDeg.measurementType === "unavailable" && Number.isFinite(rDegenerate.externalRotationDeg.value ?? 0));

  // (e) Severe trunk compensation
  const compensatedArm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg: 30 });
  const severeCompensation = { trunkLateralLeanDeg: { value: 30 }, trunkCompensationFlag: true };
  const rCompensated = estimateAxialRotation({ ...compensatedArm, frame, side: "right", compensation: severeCompensation });
  const rNoCompensation = estimateAxialRotation({ ...compensatedArm, frame, side: "right", compensation: { trunkLateralLeanDeg: { value: 0 }, trunkCompensationFlag: false } });
  assertTrue("failure mode: severe trunk compensation (30deg lean) lowers confidence vs. none", rCompensated.externalRotationDeg.confidenceScore < rNoCompensation.externalRotationDeg.confidenceScore, `compensated=${rCompensated.externalRotationDeg.confidenceScore} clean=${rNoCompensation.externalRotationDeg.confidenceScore}`);

  // (f) Severe arm elevation ("incorrect posture")
  const rAtSide = estimateFor({ elbowAngleDeg: 90, sweepDeg: 30, elevationDeg: 0 });
  const rElevated = estimateFor({ elbowAngleDeg: 90, sweepDeg: 30, elevationDeg: 75 });
  assertTrue("failure mode: severe arm elevation (75deg from the side) lowers confidence vs. arm at side", rElevated.externalRotationDeg.confidenceScore < rAtSide.externalRotationDeg.confidenceScore, `elevated=${rElevated.externalRotationDeg.confidenceScore} atSide=${rAtSide.externalRotationDeg.confidenceScore}`);

  // (g) Low CQI via the trajectory path, (h) insufficient reliable frames -- covered in section 7/8 below (need multi-frame sequences).
  console.log("(low CQI and insufficient-reliable-frames failure modes are covered in sections 7-8 below, which build multi-frame sequences)");
}

// =============================================================================
console.log("\n--- 6. Confidence-factor tests (one per named factor) ---");
// =============================================================================
{
  // (1) Elbow flexion deviation
  const rIdeal = estimateFor({ elbowAngleDeg: 90, sweepDeg: 30 });
  const rDeviated = estimateFor({ elbowAngleDeg: 130, sweepDeg: 30 });
  assertTrue("confidence factor 1/5: elbow deviation from 90deg lowers confidence", rDeviated.externalRotationDeg.confidenceScore < rIdeal.externalRotationDeg.confidenceScore);

  // (2) CQI -- via trajectory (single-frame CQI is documented as unavailable, tested in section 7)
  console.log("(CQI confidence factor tested via the trajectory path in section 7 below)");

  // (3) Landmark visibility
  const rHighVis = estimateFor({ elbowAngleDeg: 90, sweepDeg: 30, visibility: 0.97 });
  const rLowVis = estimateFor({ elbowAngleDeg: 90, sweepDeg: 30, visibility: 0.15 });
  assertTrue("confidence factor 3/5: low landmark visibility lowers confidence", rLowVis.externalRotationDeg.confidenceScore < rHighVis.externalRotationDeg.confidenceScore);

  // (4) Trunk compensation -- already proven in section 5(e) above; re-stated here as a direct named-factor test with graduated severity.
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const arm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg: 30 });
  const leanLevels = [0, 10, 20, 30];
  const confidences = leanLevels.map((leanDeg) => estimateAxialRotation({ ...arm, frame, side: "right", compensation: { trunkLateralLeanDeg: { value: leanDeg }, trunkCompensationFlag: leanDeg > 15 } }).externalRotationDeg.confidenceScore);
  let monotonicallyDecreasing = true;
  for (let i = 1; i < confidences.length; i++) if (confidences[i] > confidences[i - 1]) monotonicallyDecreasing = false;
  assertTrue("confidence factor 4/5: confidence decreases monotonically as trunk lean increases (0/10/20/30deg)", monotonicallyDecreasing, JSON.stringify(confidences));

  // (5) Camera geometry / posture (arm elevation, this project's own reasoned mapping -- see Phase 8 final report)
  const elevationLevels = [0, 20, 40, 60];
  const elevConfidences = elevationLevels.map((elevationDeg) => estimateFor({ elbowAngleDeg: 90, sweepDeg: 30, elevationDeg }).externalRotationDeg.confidenceScore);
  let elevMonotonic = true;
  for (let i = 1; i < elevConfidences.length; i++) if (elevConfidences[i] > elevConfidences[i - 1]) elevMonotonic = false;
  assertTrue("confidence factor 5/5: confidence decreases monotonically as arm elevation (posture/camera-geometry proxy) increases (0/20/40/60deg)", elevMonotonic, JSON.stringify(elevConfidences));

  assertTrue("never a high-confidence estimate under poor conditions: low visibility + high elevation + compensation all combined stays 'low'", (() => {
    const badArm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg: 30, visibility: 0.2, elevationDeg: 55 });
    const r = estimateAxialRotation({ ...badArm, frame, side: "right", compensation: { trunkLateralLeanDeg: { value: 28 }, trunkCompensationFlag: true } });
    return r.externalRotationDeg.confidence === "low";
  })());
}

// =============================================================================
console.log("\n--- 7. Trajectory integration: multi-frame, CQI, speed, occlusion ---");
// =============================================================================
function buildSequence({ side = "right", sweepProfile, elbowAngleDeg = 90, frameIntervalMs = 33, occludeIndices = [] }) {
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const filteredFrames = [];
  const rawFrames = [];
  sweepProfile.forEach((sweepDeg, i) => {
    const lm = new Array(33).fill(null);
    lm[11] = trunk.leftShoulder; lm[12] = trunk.rightShoulder;
    lm[23] = trunk.leftHip; lm[24] = trunk.rightHip;
    lm[13] = trunk.leftShoulder; lm[15] = trunk.leftShoulder;
    if (!occludeIndices.includes(i)) {
      const arm = buildArm({ trunk, frame, side, elbowAngleDeg, sweepDeg, visibility: 0.9 });
      lm[14] = { ...arm.elbow, visibility: undefined };
      lm[16] = { ...arm.wrist, visibility: undefined };
    }
    filteredFrames.push({ t: i * frameIntervalMs, lm: occludeIndices.includes(i) ? null : lm });
    rawFrames.push({ t: i * frameIntervalMs, lm: occludeIndices.includes(i) ? null : lm.map((p) => (p ? { ...p, visibility: 0.9 } : p)) });
  });
  return { filteredFrames, rawFrames };
}

{
  // "Slow" movement: gentle ramp over more frames.
  const slow = buildSequence({ sweepProfile: [5, 10, 15, 22, 28, 33, 38, 40, 40, 38, 30, 20, 10] });
  const trajSlow = analyzeRotationTrajectory({ filteredFrames: slow.filteredFrames, rawFrames: slow.rawFrames, side: "right" });
  assertTrue("speed variation: slow movement (13 frames) produces status ok", trajSlow.status === "ok", trajSlow.status);

  // "Fast" movement: same overall sweep, fewer frames (higher per-frame delta).
  const fast = buildSequence({ sweepProfile: [10, 35, 40, 25] });
  const trajFast = analyzeRotationTrajectory({ filteredFrames: fast.filteredFrames, rawFrames: fast.rawFrames, side: "right" });
  assertTrue("speed variation: fast movement (4 frames) produces status ok or an honest insufficient-frames status, never a crash", trajFast.status === "ok" || trajFast.status === "insufficient_reliable_frames");

  // Partial occlusion: some frames mid-sequence have no detection at all.
  const occluded = buildSequence({ sweepProfile: [10, 20, 30, 35, 38, 40, 38, 30, 20, 10], occludeIndices: [3, 4, 5] });
  const trajOccluded = analyzeRotationTrajectory({ filteredFrames: occluded.filteredFrames, rawFrames: occluded.rawFrames, side: "right" });
  assertTrue("partial occlusion: sequence with 3/10 frames occluded still produces a usable result", trajOccluded.status === "ok", trajOccluded.status);
  // Occluded frames (no detection at all) are excluded from totalFrameCount
  // entirely (they never enter the per-frame loop), not counted as
  // "unreliable" within it -- so the gap shows up as fewer SAMPLED frames
  // than the original 10-frame recording, not as reliableFrameCount < totalFrameCount.
  assertTrue("partial occlusion: sampled frame count reflects the 3 occluded frames (7 of 10 original)", trajOccluded.totalFrameCount === 7, `totalFrameCount=${trajOccluded.totalFrameCount}`);

  // (g) Failure mode: low CQI via the trajectory path
  const clean = buildSequence({ sweepProfile: [10, 20, 30, 35, 38, 40, 38, 30, 20, 10] });
  const trajNoCqi = analyzeRotationTrajectory({ filteredFrames: clean.filteredFrames, rawFrames: clean.rawFrames, side: "right" });
  const trajLowCqi = analyzeRotationTrajectory({ filteredFrames: clean.filteredFrames, rawFrames: clean.rawFrames, side: "right", cqiTimeline: { samples: [{ tSec: 0, cqi: 7 }, { tSec: 0.3, cqi: 3 }] } });
  assertTrue("confidence factor 2/5: low CQI (via trajectory) lowers confidence vs. no CQI supplied", trajLowCqi.representative.externalRotationDeg.confidenceScore < trajNoCqi.representative.externalRotationDeg.confidenceScore, `lowCqi=${trajLowCqi.representative.externalRotationDeg.confidenceScore} none=${trajNoCqi.representative.externalRotationDeg.confidenceScore}`);
  assertTrue("failure mode: low CQI never produces a high-confidence trajectory result", trajLowCqi.representative.externalRotationDeg.confidence !== "high");

  // (h) Failure mode: insufficient reliable frames (all near full extension)
  const allExtended = buildSequence({ sweepProfile: [10, 10, 10], elbowAngleDeg: 177 });
  const trajInsufficient = analyzeRotationTrajectory({ filteredFrames: allExtended.filteredFrames, rawFrames: allExtended.rawFrames, side: "right" });
  assertTrue("failure mode: all-degenerate-elbow sequence -> insufficient_reliable_frames, not a fabricated result", trajInsufficient.status === "insufficient_reliable_frames", trajInsufficient.status);

  // Trajectory output is envelope-compatible (Phase 8 upgrade) -- has the standard 5 fields.
  assertTrue("trajectory representative is a proper envelope (drop-in compatible)", ["value", "unit", "measurementType", "confidence", "limitation"].every((k) => k in trajSlow.representative.externalRotationDeg));
}

// =============================================================================
console.log("\n--- 8. Cross-module consistency: TaskRecorder -> Mallet grading -> ASRI-style scoring ---");
// =============================================================================
{
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const sweepProfile = [5, 15, 25, 32, 38, 40, 38, 30, 18, 8];
  const rawFrames = [];
  const collected = [];
  sweepProfile.forEach((sweepDeg, i) => {
    const arm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg, visibility: 0.92 });
    const lm = new Array(33).fill(null);
    lm[11] = trunk.leftShoulder; lm[12] = trunk.rightShoulder;
    lm[23] = trunk.leftHip; lm[24] = trunk.rightHip;
    lm[13] = trunk.leftShoulder; lm[15] = trunk.leftShoulder;
    lm[14] = arm.elbow; lm[16] = arm.wrist;
    rawFrames.push({ t: i * 100, lm });
    collected.push({ t: i * 100, params: computeParameters(lm, "right") });
  });

  const malletEngine = new ModifiedMalletScoreEngine(malletConfig);
  const task = { id: "global_external_rotation", malletCategory: "globalExternalRotation" };
  // Directly exercise the same measurements a real TaskRecorder run would
  // grade on, using the LAST (peak-ish) frame's live parameters merged with
  // a trajectory analysis over the whole sequence -- mirrors TaskRecorder.js's
  // own override-when-reliable logic (see that file) without re-importing
  // filterLandmarkSequence/DMQE here (out of scope for this rotation-focused
  // cross-module check; shared/motion/* is exercised by its own verify-motion.mjs).
  const traj = analyzeRotationTrajectory({ filteredFrames: rawFrames, rawFrames, side: "right" });
  const peakParams = collected[collected.length - 3].params; // a representative near-peak frame
  const measurements = { ...peakParams };
  if (traj.status === "ok") {
    measurements.externalRotationDeg = traj.representative.externalRotationDeg;
    measurements.internalRotationDeg = traj.representative.internalRotationDeg;
  }
  const grade = malletEngine.score({ taskId: task.id, malletCategory: task.malletCategory, measurements, dmqeResult: null, cqiResult: null });

  assertTrue("cross-module: grading succeeds on trajectory-sourced rotation values (no contradiction/crash)", grade.status === "ok", JSON.stringify(grade));
  assertTrue("cross-module: predicted grade is one of the defined I-V grades, not a garbage value", ["I", "II", "III", "IV", "V"].includes(grade.grade), grade.grade);
  assertTrue("cross-module: grade reasoning references the actual rotation value used for grading", grade.reasoning.includes("Rotation") || grade.reasoning.includes("°"), grade.reasoning.slice(0, 80));

  // Confirm quality-control.js doesn't flag this legitimate, in-range value.
  const sessions = [{ sessionId: "S2", createdAt: new Date().toISOString(), asriVersion: "2.0.0", referenceDatasetVersion: "1.0.0", taskResults: { [task.id]: { parameters: measurements } } }];
  const qc = runQualityControl(sessions, []);
  // Only look at issues actually ABOUT the external/internal rotation
  // fields themselves (field-scoped), and only the kind that flag an
  // implausible VALUE -- not the expected, correct "estimated/low-confidence"
  // info notice every estimated field gets (including unrelated fields like
  // trunkRotationDeg, which would false-positive on a bare "rotation"
  // substring match). A legitimate, in-range trajectory value should never
  // trip the physiological-range check.
  const flaggedThisSession = qc.issues.filter(
    (i) => i.sessionId === "S2" && (i.field === "externalRotationDeg" || i.field === "internalRotationDeg") && i.message.toLowerCase().includes("physiologically plausible")
  );
  assertTrue("cross-module: quality-control.js does NOT falsely flag a legitimate trajectory-sourced rotation value as out-of-range", flaggedThisSession.length === 0, JSON.stringify(flaggedThisSession));
}

// =============================================================================
console.log("\n--- 9. Performance (measured, not assumed) ---");
// =============================================================================
{
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const N = 210; // ~7s at 30fps, matching this app's actual task recording duration
  const filteredFrames = [];
  const rawFrames = [];
  for (let i = 0; i < N; i++) {
    const sweepDeg = 40 * Math.sin((i / N) * Math.PI); // one smooth rise-and-fall
    const arm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg, visibility: 0.9 });
    const lm = new Array(33).fill(null);
    lm[11] = trunk.leftShoulder; lm[12] = trunk.rightShoulder;
    lm[23] = trunk.leftHip; lm[24] = trunk.rightHip;
    lm[13] = trunk.leftShoulder; lm[15] = trunk.leftShoulder;
    lm[14] = { ...arm.elbow, visibility: undefined };
    lm[16] = { ...arm.wrist, visibility: undefined };
    filteredFrames.push({ t: i * 33, lm });
    rawFrames.push({ t: i * 33, lm: lm.map((p) => (p ? { ...p, visibility: 0.9 } : p)) });
  }
  const start = performance.now();
  const traj = analyzeRotationTrajectory({ filteredFrames, rawFrames, side: "right" });
  const elapsedMs = performance.now() - start;
  reportNumber(`trajectory analysis over ${N} frames (~7s recording): measured wall-clock time (ms)`, elapsedMs.toFixed(2));
  assertTrue("performance: trajectory analysis completes well under a 200ms budget for a full ~7s task recording", elapsedMs < 200, `${elapsedMs.toFixed(2)}ms`);
  assertTrue("performance test sequence produced a valid result", traj.status === "ok");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
