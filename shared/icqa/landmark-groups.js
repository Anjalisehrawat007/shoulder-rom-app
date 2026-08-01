/**
 * landmark-groups.js — MediaPipe BlazePose 33-point index map and body-part
 * groupings, local to the ICQA module family.
 * ----------------------------------------------------------------------------
 * shared/biomechanics/index.js's `LM` only names the ~10 landmarks the
 * Biomechanical Engine needs for joint angles (shoulders/elbows/wrists/hips).
 * ICQA needs the full 33-point set (head/feet/knees included) to judge
 * whether the WHOLE body is framed, so a separate, complete map lives here
 * rather than extending the Phase 1 map for a use case it was never scoped
 * for. Index numbering is the standard MediaPipe Pose topology (unchanged
 * since BlazePose's public spec).
 * ----------------------------------------------------------------------------
 */

const LM_FULL = {
  NOSE: 0,
  L_EYE_INNER: 1, L_EYE: 2, L_EYE_OUTER: 3,
  R_EYE_INNER: 4, R_EYE: 5, R_EYE_OUTER: 6,
  L_EAR: 7, R_EAR: 8,
  MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_PINKY: 17, R_PINKY: 18,
  L_INDEX: 19, R_INDEX: 20,
  L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT_INDEX: 31, R_FOOT_INDEX: 32,
};

/** Body-part groupings for visibility scoring. "feet" is deliberately broad
 *  (knee through toe) -- ICQA cares whether the *lower body* is in frame at
 *  all, not knee-vs-ankle-specific detail the clinical engine never uses. */
const BODY_PART_GROUPS = {
  head: [LM_FULL.NOSE, LM_FULL.L_EYE, LM_FULL.R_EYE, LM_FULL.L_EAR, LM_FULL.R_EAR, LM_FULL.MOUTH_L, LM_FULL.MOUTH_R],
  shoulders: [LM_FULL.L_SHOULDER, LM_FULL.R_SHOULDER],
  arms: [LM_FULL.L_ELBOW, LM_FULL.R_ELBOW, LM_FULL.L_WRIST, LM_FULL.R_WRIST],
  hips: [LM_FULL.L_HIP, LM_FULL.R_HIP],
  feet: [LM_FULL.L_KNEE, LM_FULL.R_KNEE, LM_FULL.L_ANKLE, LM_FULL.R_ANKLE, LM_FULL.L_HEEL, LM_FULL.R_HEEL, LM_FULL.L_FOOT_INDEX, LM_FULL.R_FOOT_INDEX],
};

/** All landmark indices considered when computing a whole-body bounding box. */
const ALL_INDICES = Array.from({ length: 33 }, (_, i) => i);

export { LM_FULL, BODY_PART_GROUPS, ALL_INDICES };
