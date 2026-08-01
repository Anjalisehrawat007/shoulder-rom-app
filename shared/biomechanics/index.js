/**
 * index.js — Biomechanical Engine orchestrator
 * ----------------------------------------------------------------------------
 * Single entry point for the full clinical parameter set. Wires the trunk
 * frame (coordinate-frame.js) into angle-computation.js,
 * scapular-estimation.js, and compensation-detection.js so callers (the
 * capture app) don't need to know about the anatomical frame directly. This
 * replaces the old PoseEngine.computeParameters()/computeMotionQuality()
 * methods; capture/pose-engine.js is now purely a MediaPipe/Landmark
 * Detection wrapper that delegates all computation here.
 * ----------------------------------------------------------------------------
 */
import { buildTrunkFrame } from "./coordinate-frame.js";
import { computeShoulderAngles } from "./angle-computation.js";
import { estimateScapularParameters } from "./scapular-estimation.js";
import { detectCompensation } from "./compensation-detection.js";
import { computeMotionQuality } from "./motion-quality.js";

const LM = {
  NOSE: 0,
  MOUTH_L: 9,
  MOUTH_R: 10,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
};

/** Compute the full clinical parameter set for one frame. `side` selects
 *  which arm is under test ("right" | "left"). */
function computeParameters(lm, side = "right") {
  const isRight = side === "right";
  const shoulder = lm[isRight ? LM.R_SHOULDER : LM.L_SHOULDER];
  const otherShoulder = lm[isRight ? LM.L_SHOULDER : LM.R_SHOULDER];
  const elbow = lm[isRight ? LM.R_ELBOW : LM.L_ELBOW];
  const wrist = lm[isRight ? LM.R_WRIST : LM.L_WRIST];

  const frame = buildTrunkFrame({
    leftShoulder: lm[LM.L_SHOULDER],
    rightShoulder: lm[LM.R_SHOULDER],
    leftHip: lm[LM.L_HIP],
    rightHip: lm[LM.R_HIP],
  });

  // Phase 8 note: compensation is computed BEFORE angles now (order flip
  // from Phase 1-7) so it can be threaded into computeShoulderAngles as an
  // optional confidence input for the rotation estimator (see
  // shared/biomechanics/rotation-estimation.js) -- trunk compensation was
  // identified during Phase 8 verification as a real gap: this phase's own
  // acceptance criteria require rotation confidence to decrease when trunk
  // compensation increases, which nothing previously wired up. Zero change
  // to compensation's own computation or output shape.
  const compensation = detectCompensation({ frame, shoulder, otherShoulder });
  const angles = computeShoulderAngles({ shoulder, elbow, wrist, frame, side, compensation });
  const scapular = estimateScapularParameters({ shoulder, otherShoulder });

  return { ...angles, ...scapular, ...compensation };
}

/** Compute wrist-trajectory speed/smoothness over a buffered landmark
 *  history. `history` is an array of {t, lm} frames. */
function computeMotion({ history, side = "right" }) {
  const wristIndex = side === "right" ? LM.R_WRIST : LM.L_WRIST;
  return computeMotionQuality({ history, wristIndex });
}

export { LM, computeParameters, computeMotion };
