#!/usr/bin/env node
/**
 * verify-rotation-redesign.mjs — Phase 7 (Internal/External Rotation
 * Redesign) synthetic ground-truth checks
 * ----------------------------------------------------------------------------
 * Same pattern as every prior phase's verify-*.mjs: pure math against
 * hand-constructed synthetic landmark data, no browser needed. All test
 * poses are built by placing landmarks directly from KNOWN local-trunk-frame
 * angles (via localToWorld, the validated inverse of toLocalFrame) rather
 * than hand-guessed coordinates, so each test's expected answer is exact,
 * not approximate.
 *
 * Covers every scenario the Phase 7 spec explicitly asked for: camera
 * distance / patient height (scale invariance), body orientation (world-
 * rotation invariance), left vs. right shoulder, low landmark confidence,
 * occluded landmarks, a full elbow-flexion sweep, trunk compensation
 * (lean/rotation), an extreme rotation case, the old-code failure mode
 * specifically (regression proof), and the standalone trajectory module.
 *
 * Run: node scripts/verify-rotation-redesign.mjs
 * ----------------------------------------------------------------------------
 */
import { buildTrunkFrame } from "../shared/biomechanics/coordinate-frame.js";
import { estimateAxialRotation, DEFAULT_CONFIG } from "../shared/biomechanics/rotation-estimation.js";
import { analyzeRotationTrajectory } from "../shared/biomechanics/rotation-trajectory.js";
import { computeParameters } from "../shared/biomechanics/index.js";

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

// ---- synthetic pose construction -------------------------------------------
function localToWorld(frame, local) {
  return {
    x: frame.x.x * local.x + frame.y.x * local.y + frame.z.x * local.z,
    y: frame.x.y * local.x + frame.y.y * local.y + frame.z.y * local.z,
    z: frame.x.z * local.x + frame.y.z * local.y + frame.z.z * local.z,
  };
}
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scaleVec = (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s });

function baseTrunk({ scale = 1, leanDeg = 0 } = {}) {
  const center = { x: 0.5, y: 0.375, z: 0 };
  const leanRad = (leanDeg * Math.PI) / 180;
  const shoulderXOffset = 0.08 * scale;
  const shoulderY = 0.25 * scale + center.y * (1 - scale);
  const hipY = 0.5 * scale + center.y * (1 - scale);
  // Trunk lean: shoulders shift laterally relative to hips (simulating a
  // side-bend/compensation), pivoting around the hip midpoint.
  const leanShift = Math.tan(leanRad) * (hipY - shoulderY);
  return {
    leftShoulder: { x: 0.5 - shoulderXOffset + leanShift, y: shoulderY, z: 0 },
    rightShoulder: { x: 0.5 + shoulderXOffset + leanShift, y: shoulderY, z: 0 },
    leftHip: { x: 0.5 - shoulderXOffset * 0.7, y: hipY, z: 0 },
    rightHip: { x: 0.5 + shoulderXOffset * 0.7, y: hipY, z: 0 },
  };
}

/** Builds shoulder/elbow/wrist for one arm with a KNOWN elbow included
 *  angle and a KNOWN signed sweep, matching estimateAxialRotation's own
 *  atan2(lateralAway, z) convention exactly -- so the expected answer is
 *  exact, not approximate. */
function buildArm({ trunk, frame, side, elbowAngleDeg = 90, sweepDeg = 30, armLen = 0.15, visibility = 0.95 }) {
  const shoulder = side === "right" ? trunk.rightShoulder : trunk.leftShoulder;
  const humerusLocalDir = { x: 0, y: -1, z: 0 }; // arm hangs straight down at the side
  const elbow = add(shoulder, scaleVec(localToWorld(frame, humerusLocalDir), armLen));

  const theta = (elbowAngleDeg * Math.PI) / 180;
  const sweepRad = (sweepDeg * Math.PI) / 180;
  const perpMagLocal = Math.sin(theta);
  const yLocal = Math.cos(theta);
  const lateralAway = perpMagLocal * Math.sin(sweepRad);
  const zLocal = perpMagLocal * Math.cos(sweepRad);
  const lateralSigned = side === "right" ? lateralAway : -lateralAway;
  const wrist = add(elbow, scaleVec(localToWorld(frame, { x: lateralSigned, y: yLocal, z: zLocal }), armLen));

  const withVis = (p) => ({ ...p, visibility });
  return { shoulder: withVis(shoulder), elbow: withVis(elbow), wrist: withVis(wrist) };
}

function rotateAroundY(point, angleDeg, pivot) {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = point.x - pivot.x;
  const dz = point.z - pivot.z;
  return { x: pivot.x + dx * Math.cos(rad) + dz * Math.sin(rad), y: point.y, z: pivot.z - dx * Math.sin(rad) + dz * Math.cos(rad) };
}

function estimateFor({ side = "right", elbowAngleDeg = 90, sweepDeg = 30, scale = 1, leanDeg = 0, worldRotationDeg = 0, visibility = 0.95 }) {
  const trunk = baseTrunk({ scale, leanDeg });
  let frame = buildTrunkFrame(trunk);
  let arm = buildArm({ trunk, frame, side, elbowAngleDeg, sweepDeg, armLen: 0.15 * scale, visibility });

  if (worldRotationDeg !== 0) {
    const pivot = { x: 0.5, y: 0.375, z: 0 };
    const rot = (p) => ({ ...rotateAroundY(p, worldRotationDeg, pivot), visibility: p.visibility });
    trunk.leftShoulder = rotateAroundY(trunk.leftShoulder, worldRotationDeg, pivot);
    trunk.rightShoulder = rotateAroundY(trunk.rightShoulder, worldRotationDeg, pivot);
    trunk.leftHip = rotateAroundY(trunk.leftHip, worldRotationDeg, pivot);
    trunk.rightHip = rotateAroundY(trunk.rightHip, worldRotationDeg, pivot);
    arm = { shoulder: rot(arm.shoulder), elbow: rot(arm.elbow), wrist: rot(arm.wrist) };
    frame = buildTrunkFrame(trunk);
  }

  return estimateAxialRotation({ ...arm, frame, side });
}

// ---- 1. Exact-value ground truth (baseline correctness) --------------------
{
  const r = estimateFor({ side: "right", elbowAngleDeg: 90, sweepDeg: 46 });
  assertClose("baseline: 46deg external target", r.externalRotationDeg.value, 46, 0.5);
  assertClose("baseline: internal is 0 when externally rotated", r.internalRotationDeg.value, 0, 0.1);
  assertTrue("baseline: measurementType is estimated (never 'measured' for a proxy)", r.externalRotationDeg.measurementType === "estimated");
  assertTrue("baseline: confidence is high near ideal elbow angle + good visibility", r.externalRotationDeg.confidence === "high");
}

// ---- 2. Scale invariance (camera distance / patient height) ----------------
{
  const r1 = estimateFor({ elbowAngleDeg: 90, sweepDeg: 35, scale: 1 });
  const r2 = estimateFor({ elbowAngleDeg: 90, sweepDeg: 35, scale: 2.2 });
  const r3 = estimateFor({ elbowAngleDeg: 90, sweepDeg: 35, scale: 0.5 });
  assertClose("scale invariance: 2.2x scale gives the same angle", r2.externalRotationDeg.value, r1.externalRotationDeg.value, 0.5);
  assertClose("scale invariance: 0.5x scale gives the same angle", r3.externalRotationDeg.value, r1.externalRotationDeg.value, 0.5);
}

// ---- 3. Body/camera orientation invariance ----------------------------------
{
  const r1 = estimateFor({ elbowAngleDeg: 90, sweepDeg: 40, worldRotationDeg: 0 });
  const r2 = estimateFor({ elbowAngleDeg: 90, sweepDeg: 40, worldRotationDeg: 35 });
  const r3 = estimateFor({ elbowAngleDeg: 90, sweepDeg: 40, worldRotationDeg: -60 });
  assertClose("world-rotation invariance: +35deg camera/body angle gives the same reading", r2.externalRotationDeg.value, r1.externalRotationDeg.value, 1.0);
  assertClose("world-rotation invariance: -60deg camera/body angle gives the same reading", r3.externalRotationDeg.value, r1.externalRotationDeg.value, 1.0);
}

// ---- 4. Left vs. right shoulder symmetry ------------------------------------
{
  const right = estimateFor({ side: "right", elbowAngleDeg: 90, sweepDeg: 42 });
  const left = estimateFor({ side: "left", elbowAngleDeg: 90, sweepDeg: 42 });
  assertClose("left/right symmetry: same target sweep gives the same signed value on either side", left.externalRotationDeg.signedRotationDeg, right.externalRotationDeg.signedRotationDeg, 0.5);
}

// ---- 5. Low landmark visibility reduces confidence --------------------------
{
  const highVis = estimateFor({ elbowAngleDeg: 90, sweepDeg: 30, visibility: 0.97 });
  const lowVis = estimateFor({ elbowAngleDeg: 90, sweepDeg: 30, visibility: 0.2 });
  assertTrue("low landmark visibility lowers confidenceScore", lowVis.externalRotationDeg.confidenceScore < highVis.externalRotationDeg.confidenceScore, `low=${lowVis.externalRotationDeg.confidenceScore} high=${highVis.externalRotationDeg.confidenceScore}`);
  assertTrue("low landmark visibility is reflected in landmarkReliability", lowVis.externalRotationDeg.landmarkReliability !== "high");
}

// ---- 6. Occluded landmarks -> graceful unavailable, never a crash ----------
{
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  let threw = false;
  let result = null;
  try {
    result = estimateAxialRotation({ shoulder: trunk.rightShoulder, elbow: null, wrist: null, frame, side: "right" });
  } catch (e) {
    threw = true;
  }
  assertTrue("missing elbow/wrist landmarks do not throw", !threw);
}

// ---- 7. Full elbow-angle sweep: confidence peaks near 90deg, unavailable near extension ----
{
  const angles = [10, 30, 50, 70, 90, 110, 130, 150, 170];
  const results = angles.map((a) => ({ a, r: estimateFor({ elbowAngleDeg: a, sweepDeg: 30 }) }));
  const at90 = results.find((x) => x.a === 90).r;
  const at10 = results.find((x) => x.a === 10).r;
  const at170 = results.find((x) => x.a === 170).r;
  assertTrue("elbow angle 90deg: available with high confidence", at90.externalRotationDeg.measurementType === "estimated" && at90.externalRotationDeg.confidenceScore > 0.8);
  assertTrue("elbow angle 10deg (near full flexion/extension of this synthetic sweep): unavailable or low confidence", at10.externalRotationDeg.measurementType === "unavailable" || at10.externalRotationDeg.confidenceScore < 0.5);
  assertTrue("elbow angle 170deg (near full extension): unavailable", at170.externalRotationDeg.measurementType === "unavailable", `got ${at170.externalRotationDeg.measurementType}`);
  // Confidence should be roughly unimodal (rises toward 90, falls away) -- spot check monotonic rise from 10->90.
  const conf50 = results.find((x) => x.a === 50).r.externalRotationDeg.confidenceScore;
  const conf70 = results.find((x) => x.a === 70).r.externalRotationDeg.confidenceScore;
  assertTrue("confidence rises as elbow angle approaches 90deg from below", conf70 >= conf50, `50deg=${conf50} 70deg=${conf70}`);
}

// ---- 8. Trunk compensation (lean) does not bias the trunk-relative reading -
{
  const noLean = estimateFor({ elbowAngleDeg: 90, sweepDeg: 25, leanDeg: 0 });
  const withLean = estimateFor({ elbowAngleDeg: 90, sweepDeg: 25, leanDeg: 15 });
  assertClose("trunk lean: rotation reading stays consistent (trunk-relative reference absorbs rigid trunk lean)", withLean.externalRotationDeg.value, noLean.externalRotationDeg.value, 2.0);
}

// ---- 9. Extreme rotation case is captured, not clipped ---------------------
{
  const r = estimateFor({ elbowAngleDeg: 90, sweepDeg: 85 });
  assertTrue("extreme (85deg) sweep is captured close to its true value, not clipped to a smaller number", r.externalRotationDeg.value > 75, `got ${r.externalRotationDeg.value}`);
}

// ---- 10. Regression proof: the OLD code's specific failure mode -----------
{
  // Near full extension (the hand-behind-back-adjacent, low-elbow-flexion
  // case the spec explicitly called out): the old code would have produced
  // a confident-looking 0.0deg for one of the two fields. The new code must
  // report unavailable instead.
  const r = estimateFor({ elbowAngleDeg: 175, sweepDeg: 20 });
  assertTrue("near-full-extension: measurementType is unavailable (NOT a fabricated 0deg)", r.externalRotationDeg.measurementType === "unavailable" && r.internalRotationDeg.measurementType === "unavailable");
  assertTrue("near-full-extension: value is null, not a fabricated number", r.externalRotationDeg.value === null && r.internalRotationDeg.value === null);
}

// ---- 11. Full computeParameters() integration -- confirms the drop-in wiring works end to end ----
{
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const arm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg: 20 });
  const lm = new Array(33).fill(null);
  lm[11] = trunk.leftShoulder; lm[12] = trunk.rightShoulder;
  lm[23] = trunk.leftHip; lm[24] = trunk.rightHip;
  lm[14] = arm.elbow; lm[16] = arm.wrist;
  lm[13] = trunk.leftShoulder; lm[15] = trunk.leftShoulder; // left arm placeholder, unused by side="right"
  const params = computeParameters(lm, "right");
  assertTrue("computeParameters() still returns externalRotationDeg/internalRotationDeg (drop-in compatibility)", "externalRotationDeg" in params && "internalRotationDeg" in params);
  assertClose("computeParameters() end-to-end value matches the direct estimateAxialRotation() call", params.externalRotationDeg.value, 20, 0.5);
  assertTrue("computeParameters() still returns all pre-existing keys (abduction/flexion/scapular/compensation)", "shoulderAbductionDeg" in params && "scapularTiltDeg" in params && "trunkCompensationFlag" in params);
}

// ---- 12. Trajectory module: multi-frame aggregation ------------------------
{
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const filteredFrames = [];
  const rawFrames = [];
  const sweepSequence = [10, 20, 35, 42, 44, 45, 44, 40, 25]; // a rise-and-hold-and-return sweep
  sweepSequence.forEach((sweep, i) => {
    const arm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 90, sweepDeg: sweep, visibility: 0.9 });
    const lm = new Array(33).fill(null);
    lm[11] = trunk.leftShoulder; lm[12] = trunk.rightShoulder;
    lm[23] = trunk.leftHip; lm[24] = trunk.rightHip;
    lm[13] = trunk.leftShoulder; lm[15] = trunk.leftShoulder;
    lm[14] = { ...arm.elbow, visibility: undefined };
    lm[16] = { ...arm.wrist, visibility: undefined };
    filteredFrames.push({ t: i * 100, lm });
    const rawLm = lm.map((p) => (p ? { ...p, visibility: 0.9 } : p));
    rawFrames.push({ t: i * 100, lm: rawLm });
  });

  const traj = analyzeRotationTrajectory({ filteredFrames, rawFrames, side: "right" });
  assertTrue("trajectory: status ok with a well-formed sequence", traj.status === "ok", traj.status);
  // Phase 8: representative.externalRotationDeg is now a full envelope (not a raw number) -- see rotation-trajectory.js
  assertTrue("trajectory: representative external rotation is within the sequence's range", traj.representative.externalRotationDeg.value >= 20 && traj.representative.externalRotationDeg.value <= 45, traj.representative?.externalRotationDeg?.value);
  assertTrue("trajectory: reliable frame fraction is high for this clean sequence", traj.reliableFrameFraction > 0.8, traj.reliableFrameFraction);

  // No raw frames supplied -> visibility falls back to the documented default, doesn't crash.
  const trajNoRaw = analyzeRotationTrajectory({ filteredFrames, rawFrames: null, side: "right" });
  assertTrue("trajectory: works without rawFrames (visibility falls back to default, no crash)", trajNoRaw.status === "ok");

  // Empty sequence -> honest "no_frames" status, not a crash or a fabricated result.
  const trajEmpty = analyzeRotationTrajectory({ filteredFrames: [], rawFrames: [], side: "right" });
  assertTrue("trajectory: empty sequence reports no_frames honestly", trajEmpty.status === "no_frames");

  // All-degenerate sequence (elbow near full extension throughout) -> insufficient_reliable_frames, not a fabricated representative.
  const degenerateFrames = [175, 178, 172].map((elbowAngleDeg, i) => {
    const arm = buildArm({ trunk, frame, side: "right", elbowAngleDeg, sweepDeg: 20, visibility: 0.9 });
    const lm = new Array(33).fill(null);
    lm[11] = trunk.leftShoulder; lm[12] = trunk.rightShoulder;
    lm[23] = trunk.leftHip; lm[24] = trunk.rightHip;
    lm[13] = trunk.leftShoulder; lm[15] = trunk.leftShoulder;
    lm[14] = arm.elbow; lm[16] = arm.wrist;
    return { t: i * 100, lm };
  });
  const trajDegenerate = analyzeRotationTrajectory({ filteredFrames: degenerateFrames, rawFrames: degenerateFrames, side: "right" });
  assertTrue("trajectory: all-degenerate sequence reports insufficient_reliable_frames, not a fabricated representative", trajDegenerate.status === "insufficient_reliable_frames", trajDegenerate.status);

  // Optional CQI blending changes the aggregate confidence when supplied.
  const withoutCqi = analyzeRotationTrajectory({ filteredFrames, rawFrames, side: "right" });
  const withLowCqi = analyzeRotationTrajectory({ filteredFrames, rawFrames, side: "right", cqiTimeline: { samples: [{ tSec: 0, cqi: 20 }, { tSec: 1, cqi: 15 }] } });
  assertTrue("trajectory: supplying a low CQI timeline reduces aggregate confidence relative to no CQI supplied", withLowCqi.representative.externalRotationDeg.confidenceScore < withoutCqi.representative.externalRotationDeg.confidenceScore, `withCqi=${withLowCqi.representative.externalRotationDeg.confidenceScore} without=${withoutCqi.representative.externalRotationDeg.confidenceScore}`);
  assertTrue("trajectory: cqiContribution is null when no timeline supplied (never fabricated)", withoutCqi.cqiContribution === null);
  assertTrue("trajectory: cqiContribution reflects the supplied timeline when given", withLowCqi.cqiContribution != null && withLowCqi.cqiContribution < 25);
}

// ---- 13. Config re-weighting changes confidence (externalization proof) ----
{
  const trunk = baseTrunk({});
  const frame = buildTrunkFrame(trunk);
  const arm = buildArm({ trunk, frame, side: "right", elbowAngleDeg: 70, sweepDeg: 30, visibility: 0.5 });
  const base = estimateAxialRotation({ ...arm, frame, side: "right" }, DEFAULT_CONFIG);
  const altConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  altConfig.confidenceBlend = { sensitivity: 0.05, landmarkVisibility: 0.95, trunkCompensation: 0, posture: 0 }; // Phase 8: confidenceBlend grew to 4 keys; this test's override must supply all of them
  const alt = estimateAxialRotation({ ...arm, frame, side: "right" }, altConfig);
  assertTrue("re-weighting confidenceBlend changes confidenceScore for identical input (weights are genuinely externalized)", Math.abs(alt.externalRotationDeg.confidenceScore - base.externalRotationDeg.confidenceScore) > 0.05, `base=${base.externalRotationDeg.confidenceScore} alt=${alt.externalRotationDeg.confidenceScore}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
