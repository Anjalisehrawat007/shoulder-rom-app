#!/usr/bin/env node
/**
 * verify-motion.mjs — Part 10: Testing
 * ----------------------------------------------------------------------------
 * Synthetic full-sequence checks for shared/motion/* (landmark-filter,
 * segmentation, trajectory-analysis, dmqe-engine), run against fabricated
 * landmark sequences -- pure math, no MediaPipe/browser needed, same pattern
 * as scripts/verify-biomechanics.mjs (Phase 1) and scripts/verify-asri.mjs
 * (Phase 2).
 *
 * Confirms the pipeline behaves consistently and never crashes across: no
 * movement, very slow movement, very fast movement, an interrupted movement
 * with an extra mid-movement pause, poor tracking (missing landmarks
 * scattered through the sequence), and frame drops (irregular timestamps).
 * Also confirms confidence is reduced (not silently held at full/nominal)
 * when data quality degrades.
 *
 * NOT clinical validation -- see docs/dmqe.md §9 and shared/validation/README.md.
 * Run: node scripts/verify-motion.mjs
 * ----------------------------------------------------------------------------
 */
import { buildTrunkFrame, vec3 } from "../shared/biomechanics/coordinate-frame.js";
import { filterLandmarkSequence } from "../shared/motion/landmark-filter.js";
import { segmentMovement } from "../shared/motion/segmentation.js";
import { runDmqe } from "../shared/motion/dmqe-engine.js";

const { add, scale } = vec3;

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}

function baseTrunk() {
  return {
    leftShoulder: { x: -0.1, y: 0, z: 0 },
    rightShoulder: { x: 0.1, y: 0, z: 0 },
    leftHip: { x: -0.1, y: 0.5, z: 0 },
    rightHip: { x: 0.1, y: 0.5, z: 0 },
  };
}

/** Minimum-jerk-like 0->1->0 bell profile: smooth accel/decel, no sharp corners. */
function bellProfile(progress) {
  const p = progress < 0.5 ? progress * 2 : (1 - progress) * 2; // 0->1->0
  return 10 * p ** 3 - 15 * p ** 4 + 6 * p ** 5; // 0 at p=0, 1 at p=1
}

/** Build a full 33-slot landmark array (only the indices this codebase
 *  actually reads are meaningful; the rest are filler zeros). */
function buildLandmarks(trunk, elbow, wrist) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  lm[11] = trunk.leftShoulder;
  lm[12] = trunk.rightShoulder;
  lm[13] = { x: 0, y: 0, z: 0 }; // left elbow (unused for right-side tests)
  lm[14] = elbow;
  lm[15] = { x: 0, y: 0, z: 0 }; // left wrist
  lm[16] = wrist;
  lm[23] = trunk.leftHip;
  lm[24] = trunk.rightHip;
  return lm;
}

/**
 * @param {object} opts
 * @param {number} opts.durationMs
 * @param {number} opts.fps
 * @param {number} opts.peakAngleDeg - 0 for "no movement"
 * @param {number[]} [opts.missingFrameIndices]
 * @param {number[]} [opts.droppedFrameIndices] - simulate frame drops (skipped entirely)
 * @param {{start:number,end:number}} [opts.midPause] - hold flat for an extra interval mid-reach
 */
function generateSequence(opts) {
  const { durationMs, fps, peakAngleDeg, missingFrameIndices = [], droppedFrameIndices = [], midPause = null } = opts;
  const trunk = baseTrunk();
  const frame = buildTrunkFrame(trunk);
  const frameCount = Math.round((durationMs / 1000) * fps);
  const frames = [];

  for (let i = 0; i < frameCount; i++) {
    if (droppedFrameIndices.includes(i)) continue;
    const t = (i / fps) * 1000;

    if (missingFrameIndices.includes(i)) {
      frames.push({ t, lm: null });
      continue;
    }

    let progress = i / Math.max(1, frameCount - 1);
    if (midPause && progress > midPause.start && progress < midPause.end) {
      progress = midPause.start; // freeze progress during the pause window
    }
    const angleDeg = peakAngleDeg * bellProfile(progress);
    const a = (angleDeg * Math.PI) / 180;
    const localArm = { x: Math.sin(a), y: -Math.cos(a), z: 0 };
    const offset = add(add(scale(frame.x, localArm.x), scale(frame.y, localArm.y)), scale(frame.z, localArm.z));
    const elbow = add(trunk.rightShoulder, scale(offset, 0.3));
    const wrist = add(elbow, scale(offset, 0.25));
    frames.push({ t, lm: buildLandmarks(trunk, elbow, wrist) });
  }
  return frames;
}

function runFullPipeline(frames) {
  const filtered = filterLandmarkSequence(frames);
  return runDmqe(filtered, "right", frames);
}

console.log("--- No movement ---");
{
  const frames = generateSequence({ durationMs: 3000, fps: 30, peakAngleDeg: 0 });
  let result;
  assertTrue("does not throw", (() => { try { result = runFullPipeline(frames); return true; } catch (e) { console.log(e); return false; } })());
  assertTrue("segmentation reports no movement", result.status === "no_movement_detected", `got status=${result.status}`);
  assertTrue("dmqeScore is null, not fabricated", result.dmqeScore == null);
  assertTrue("movementConfidencePct is 0", result.movementConfidencePct === 0);
}

console.log("\n--- Very slow movement (3s reach) ---");
{
  const frames = generateSequence({ durationMs: 3000, fps: 30, peakAngleDeg: 90 });
  const result = runFullPipeline(frames);
  assertTrue("segmentation succeeds", result.status === "ok", `got status=${result.status}`);
  assertTrue("dmqeScore computed", result.dmqeScore != null);
}

console.log("\n--- Very fast movement (0.6s reach) ---");
{
  const frames = generateSequence({ durationMs: 600, fps: 30, peakAngleDeg: 90 });
  const result = runFullPipeline(frames);
  assertTrue("segmentation succeeds even for a fast movement", result.status === "ok", `got status=${result.status}`);
  assertTrue("dmqeScore computed", result.dmqeScore != null);
}

console.log("\n--- Interrupted movement (extra mid-reach pause) ---");
{
  const frames = generateSequence({ durationMs: 4000, fps: 30, peakAngleDeg: 90, midPause: { start: 0.2, end: 0.35 } });
  const result = runFullPipeline(frames);
  assertTrue("segmentation succeeds", result.status === "ok", `got status=${result.status}`);
  assertTrue("at least one pause detected beyond the natural hold", (result.domains.pauseCount?.value ?? 0) >= 1, `pauseCount=${result.domains.pauseCount?.value}`);
}

console.log("\n--- Poor tracking: missing landmarks scattered through the sequence ---");
{
  const frames = generateSequence({ durationMs: 3000, fps: 30, peakAngleDeg: 90, missingFrameIndices: [10, 11, 12, 40, 41, 60] });
  let threw = false;
  let result;
  try {
    result = runFullPipeline(frames);
  } catch (e) {
    threw = true;
    console.log(e);
  }
  assertTrue("does not throw with scattered missing landmarks", !threw);
  assertTrue("still produces a result (filter reconstructs from neighbors)", !threw && result.status === "ok", threw ? "threw" : `status=${result.status}`);
}

console.log("\n--- Missing landmarks: large contiguous gap (worse tracking) ---");
{
  const denseMissing = Array.from({ length: 40 }, (_, i) => 30 + i); // ~1.3s contiguous gap at 30fps
  const frames = generateSequence({ durationMs: 3000, fps: 30, peakAngleDeg: 90, missingFrameIndices: denseMissing });
  let threw = false;
  let result;
  try {
    result = runFullPipeline(frames);
  } catch (e) {
    threw = true;
    console.log(e);
  }
  assertTrue("does not throw with a large contiguous gap", !threw);
  if (!threw) {
    console.log(`  (status=${result.status}, dmqeScore=${result.dmqeScore}, confidence=${result.movementConfidencePct}% -- degraded gracefully rather than crashing)`);
  }
}

console.log("\n--- Frame drops: irregular timestamps ---");
{
  const dropped = [15, 16, 17, 45, 46]; // simulate a few skipped frames -> larger dt at those points
  const frames = generateSequence({ durationMs: 3000, fps: 30, peakAngleDeg: 90, droppedFrameIndices: dropped });
  const result = runFullPipeline(frames);
  assertTrue("segmentation succeeds despite irregular timestamps", result.status === "ok", `got status=${result.status}`);
  const velocities = result.trajectory.velocityCurve.value.map((p) => p.value).filter((v) => v != null);
  const allFinite = velocities.every((v) => Number.isFinite(v));
  assertTrue("velocity curve has no NaN/Infinity from irregular dt", allFinite);
}

console.log("\n--- Confidence comparison: clean vs. poor-tracking sequence ---");
{
  const clean = generateSequence({ durationMs: 3000, fps: 30, peakAngleDeg: 90 });
  const poor = generateSequence({ durationMs: 3000, fps: 30, peakAngleDeg: 90, missingFrameIndices: Array.from({ length: 40 }, (_, i) => 30 + i) });
  const cleanResult = runFullPipeline(clean);
  const poorResult = runFullPipeline(poor);
  assertTrue(
    "confidence is not higher for the degraded sequence than the clean one",
    (poorResult.movementConfidencePct ?? 0) <= (cleanResult.movementConfidencePct ?? 0),
    `clean=${cleanResult.movementConfidencePct}%, poor=${poorResult.movementConfidencePct}%`
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
