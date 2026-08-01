/**
 * trajectory-analysis.js — Part 4: Trajectory Analysis
 * ----------------------------------------------------------------------------
 * Computes the full-sequence kinematic curves from a filtered landmark
 * sequence (landmark-filter.js) and segmentation result (segmentation.js):
 * elevation-angle curve, velocity/acceleration/jerk curves (by successive
 * numerical differentiation), 3D trajectory length, path-efficiency ratio,
 * and a per-frame compensation timeline. Reuses the Phase 1 Biomechanical
 * Engine (shared/biomechanics/*) for angle computation -- no duplicated
 * anatomical math.
 *
 * DIFFERENTIATION METHOD: central differences where both neighbors exist,
 * one-sided differences at sequence edges or around missing samples, using
 * ACTUAL elapsed time between samples (not an assumed fixed frame rate) --
 * correct under irregular timestamps / dropped frames (Part 10 requirement).
 *
 * CONFIDENCE DEGRADES WITH DERIVATIVE ORDER -- a well-known property of
 * numerical differentiation of a discrete, noisy signal: each differencing
 * pass divides a (still slightly noisy, even after Savitzky-Golay
 * smoothing) difference by a small dt, amplifying whatever noise remains.
 * Elevation angle keeps its Phase 1 rating (measured/moderate, unchanged by
 * filtering -- smoothing reduces noise but doesn't change what kind of
 * claim the measurement is). Velocity is estimated/moderate. Acceleration
 * and jerk are both estimated/low, with jerk explicitly documented as the
 * least reliable of the three (see JERK_LIMITATION below) rather than
 * silently presented at the same confidence as acceleration.
 * ----------------------------------------------------------------------------
 */
import { buildTrunkFrame, vec3 } from "../biomechanics/coordinate-frame.js";
import { computeShoulderAngles } from "../biomechanics/angle-computation.js";
import { detectCompensation } from "../biomechanics/compensation-detection.js";
import { LM } from "../biomechanics/index.js";
import { makeParameter } from "../biomechanics/parameter-schema.js";

const { v3, magnitude } = vec3;

const JERK_LIMITATION =
  "Third numerical derivative of a discrete, noisy angle signal -- even after Savitzky-Golay smoothing of the " +
  "source landmarks, jerk amplifies remaining noise more than acceleration or velocity. Treat trends (increasing " +
  "vs. decreasing jerk across a session) as more meaningful than the absolute value of any single point.";

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

/** Central-difference-preferred numerical derivative, dt-aware (handles
 *  irregular timestamps / frame drops correctly), null-propagating around
 *  missing samples. */
function differentiate(values, timesSec) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (values[i] == null) continue;
    const prev = i > 0 && values[i - 1] != null ? i - 1 : null;
    const next = i < n - 1 && values[i + 1] != null ? i + 1 : null;
    if (prev != null && next != null) {
      const dt = timesSec[next] - timesSec[prev];
      if (dt > 0) out[i] = (values[next] - values[prev]) / dt;
    } else if (next != null) {
      const dt = timesSec[next] - timesSec[i];
      if (dt > 0) out[i] = (values[next] - values[i]) / dt;
    } else if (prev != null) {
      const dt = timesSec[i] - timesSec[prev];
      if (dt > 0) out[i] = (values[i] - values[prev]) / dt;
    }
  }
  return out;
}

/**
 * @param {Array<{t:number, lm:object[]|null}>} filteredFrames
 * @param {{movementStart:number, peakMotion:number, movementEnd:number}} phases
 * @param {string} side - "left" | "right"
 */
function analyzeTrajectory(filteredFrames, phases, side) {
  const isRight = side === "right";
  const wristIdx = isRight ? LM.R_WRIST : LM.L_WRIST;
  const times = filteredFrames.map((f) => f.t / 1000);

  const windowFrames = filteredFrames.slice(phases.movementStart, phases.movementEnd + 1);
  const windowTimes = times.slice(phases.movementStart, phases.movementEnd + 1);

  const elevationValues = [];
  const compensationEntries = [];
  for (const f of windowFrames) {
    const lm = f.lm;
    const shoulder = lm?.[isRight ? LM.R_SHOULDER : LM.L_SHOULDER];
    const otherShoulder = lm?.[isRight ? LM.L_SHOULDER : LM.R_SHOULDER];
    const elbow = lm?.[isRight ? LM.R_ELBOW : LM.L_ELBOW];
    const wrist = lm?.[wristIdx];
    const leftShoulder = lm?.[LM.L_SHOULDER];
    const rightShoulder = lm?.[LM.R_SHOULDER];
    const leftHip = lm?.[LM.L_HIP];
    const rightHip = lm?.[LM.R_HIP];

    if (!shoulder || !otherShoulder || !elbow || !wrist || !leftShoulder || !rightShoulder || !leftHip || !rightHip) {
      elevationValues.push(null);
      compensationEntries.push(null);
      continue;
    }
    const frame = buildTrunkFrame({ leftShoulder, rightShoulder, leftHip, rightHip });
    const angles = computeShoulderAngles({ shoulder, elbow, wrist, frame });
    elevationValues.push(angles.shoulderElevationDeg.value);
    compensationEntries.push(detectCompensation({ frame, shoulder, otherShoulder }));
  }

  const velocityValues = differentiate(elevationValues, windowTimes);
  const accelerationValues = differentiate(velocityValues, windowTimes);
  const jerkValues = differentiate(accelerationValues, windowTimes);

  const curve = (values, measurementType, confidence, limitation) =>
    windowFrames.map((f, i) => ({ t: f.t, value: round1(values[i]) }));

  // 3D wrist trajectory length and straight-line path efficiency, computed over
  // movementStart..peakMotion (the reach phase, not the return) since efficiency
  // of the reach itself -- not the return trip -- is the clinically relevant question.
  const reachFrames = filteredFrames.slice(phases.movementStart, phases.peakMotion + 1);
  let trajectoryLength = 0;
  for (let i = 1; i < reachFrames.length; i++) {
    const a = reachFrames[i - 1].lm?.[wristIdx];
    const b = reachFrames[i].lm?.[wristIdx];
    if (a && b) trajectoryLength += magnitude(v3(a, b));
  }
  const startPos = reachFrames[0]?.lm?.[wristIdx];
  const peakPos = reachFrames[reachFrames.length - 1]?.lm?.[wristIdx];
  const straightLineDistance = startPos && peakPos ? magnitude(v3(startPos, peakPos)) : null;
  const pathEfficiency = straightLineDistance != null && trajectoryLength > 0 ? Math.min(1, straightLineDistance / trajectoryLength) : null;

  return {
    elevationCurve: makeParameter({
      value: curve(elevationValues),
      unit: "deg-over-time",
      measurementType: "measured",
      confidence: "moderate",
      limitation: "Per-frame elevation angle across the movement window; same confidence rationale as the single-frame Phase 1 measurement (filtering reduces noise, doesn't change measurement type).",
    }),
    velocityCurve: makeParameter({
      value: curve(velocityValues),
      unit: "deg/s-over-time",
      measurementType: "estimated",
      confidence: "moderate",
      limitation: "First numerical derivative of the elevation curve; dt-aware central differencing.",
    }),
    accelerationCurve: makeParameter({
      value: curve(accelerationValues),
      unit: "deg/s^2-over-time",
      measurementType: "estimated",
      confidence: "low",
      limitation: "Second numerical derivative -- amplifies remaining signal noise more than velocity.",
    }),
    jerkCurve: makeParameter({
      value: curve(jerkValues),
      unit: "deg/s^3-over-time",
      measurementType: "estimated",
      confidence: "low",
      limitation: JERK_LIMITATION,
    }),
    trajectoryLength: makeParameter({
      value: round1(trajectoryLength),
      unit: "landmark-units",
      measurementType: "estimated",
      confidence: "moderate",
      limitation: "Sum of inter-frame wrist displacement over the reach phase (movement start to peak); normalized landmark-space units, not calibrated to real-world distance.",
    }),
    pathEfficiency: makeParameter({
      value: pathEfficiency != null ? round1(pathEfficiency * 100) : null,
      unit: "score(0-100)",
      measurementType: "estimated",
      confidence: "moderate",
      limitation: "Straight-line start-to-peak distance divided by actual path length traveled, as a percentage (100 = perfectly direct path). Reach phase only, not the return.",
    }),
    compensationTimeline: makeParameter({
      value: windowFrames.map((f, i) => ({
        t: f.t,
        lateralLeanDeg: compensationEntries[i]?.trunkLateralLeanDeg?.value ?? null,
        trunkRotationDeg: compensationEntries[i]?.trunkRotationDeg?.value ?? null,
        flag: compensationEntries[i]?.trunkCompensationFlag ?? null,
      })),
      unit: "timeline",
      measurementType: "estimated",
      confidence: "low",
      limitation: "Per-frame re-application of Phase 1's compensation-detection.js across the movement window; inherits that module's estimated/low rating (depends on MediaPipe's weak monocular depth estimate).",
    }),
    symmetryTimeline: makeParameter({
      value: null,
      unit: "timeline",
      measurementType: "unavailable",
      limitation: "Requires bilateral capture (testing both arms in one session); not supported by the current capture flow -- same limitation as ASRI's Symmetry category (Phase 2).",
    }),
  };
}

export { analyzeTrajectory, differentiate };
