/**
 * TaskDefinitions.js — the 6-task Modified Mallet protocol
 * ----------------------------------------------------------------------------
 * Pure data. Each entry names: the task id (also the `task_results.task_id`
 * key -- ASRI/DMQE/ICQA are already task-id-agnostic, confirmed by reading
 * capture/app.js's finishSession() and shared/asri/aggregation-strategies.js
 * before writing this file, per the Phase 6 plan), the corresponding
 * `malletCategory` key into config/mallet-score-config.v1.json, clinical
 * purpose text, instruction text, placeholder flags for demo video/
 * illustration (real assets don't exist yet -- see docs/mallet-score.md),
 * duration, and which measurement keys this task records (primary = what
 * mainly drives the grade, supporting = shown for context/explainability).
 *
 * Tasks 1, 3, 4, 5 record NEW derived measurements computed by
 * mallet-measurements.js from data the existing engines already expose.
 * Tasks 2 and 6 use the EXISTING `externalRotationDeg`/`internalRotationDeg`
 * from shared/biomechanics/angle-computation.js completely unchanged --
 * see docs/mallet-score.md §2 for why Task 2's elbow-at-side instruction
 * matches that proxy's valid operating window and Task 6's hand-behind-back
 * posture does not (a documented limitation, not a bug to fix here).
 * ----------------------------------------------------------------------------
 */

const TASKS = [
  {
    id: "global_abduction",
    malletCategory: "globalAbduction",
    label: "Global Abduction",
    clinicalPurpose:
      "Measures active shoulder abduction range -- the classic Modified Mallet Global Abduction category (Mallet 1972; Bae et al. 2003).",
    instruction: "Raise the arm sideways as high as comfortably possible.",
    demoVideoPlaceholder: true,
    illustrationPlaceholder: true,
    durationMs: 7000,
    primaryMeasurement: "shoulderAbductionDeg",
    supportingMeasurements: ["shoulderFlexionDeg", "trunkCompensationFlag", "movementSmoothness"],
    recordedCriteria: ["Maximum Shoulder Abduction", "Shoulder Flexion", "Compensation", "Movement Smoothness", "CQI", "Confidence"],
  },
  {
    id: "global_external_rotation",
    malletCategory: "globalExternalRotation",
    label: "Global External Rotation",
    clinicalPurpose:
      "Measures active external rotation with the elbow at the side -- the classic Modified Mallet Global External Rotation category.",
    instruction: "Keep the elbow close to the body. Flex the elbow approximately 90°. Rotate the forearm outward.",
    demoVideoPlaceholder: true,
    illustrationPlaceholder: true,
    durationMs: 7000,
    primaryMeasurement: "externalRotationDeg",
    supportingMeasurements: ["elbowFlexionDeg", "trunkCompensationFlag", "movementSmoothness"],
    recordedCriteria: ["External Rotation", "Elbow Position", "Compensation", "Movement Smoothness", "CQI", "Confidence"],
    usesExistingAlgorithmUnchanged: "shared/biomechanics/angle-computation.js computeAxialRotation() -- not modified this phase.",
  },
  {
    id: "hand_to_neck",
    malletCategory: "handToNeck",
    label: "Hand to Neck",
    clinicalPurpose:
      "Measures functional reach to the neck -- the classic Modified Mallet Hand to Neck category, which clinically also weighs how much shoulder abduction/compensation was needed to get there, not just whether the hand arrived.",
    instruction: "Touch the back of the neck.",
    demoVideoPlaceholder: true,
    illustrationPlaceholder: true,
    durationMs: 7000,
    primaryMeasurement: "reachSuccess",
    supportingMeasurements: ["shoulderElevationDeg", "elbowFlexionDeg", "trunkCompensationFlag", "movementSmoothness"],
    recordedCriteria: ["Reach Success", "Shoulder Elevation", "Elbow Position", "Trunk Compensation", "Smoothness", "CQI", "Confidence"],
  },
  {
    id: "hand_to_spine",
    malletCategory: "handToSpine",
    label: "Hand to Spine",
    clinicalPurpose:
      "Measures functional reach up the back -- the classic Modified Mallet Hand to Spine (Back) category, clinically graded by which vertebral level the thumb reaches.",
    instruction: "Reach the middle of the back.",
    demoVideoPlaceholder: true,
    illustrationPlaceholder: true,
    durationMs: 7000,
    primaryMeasurement: "vertebralLevelProxy",
    supportingMeasurements: ["shoulderExtensionDeg", "internalRotationDeg", "trunkCompensationFlag", "movementSmoothness"],
    recordedCriteria: ["Estimated Vertebral Level", "Shoulder Extension", "Internal Rotation", "Trunk Compensation", "Smoothness", "CQI", "Confidence"],
    usesExistingAlgorithmUnchanged: "internalRotationDeg reused as supporting context only -- not this task's primary measurement.",
  },
  {
    id: "hand_to_mouth",
    malletCategory: "handToMouth",
    label: "Hand to Mouth",
    clinicalPurpose:
      "Measures functional reach to the mouth -- the classic Modified Mallet Hand to Mouth category, clinically graded largely by how much shoulder abduction/scapular winging ('trumpet sign') is needed to compensate for limited true elevation.",
    instruction: "Bring the hand naturally to the mouth.",
    demoVideoPlaceholder: true,
    illustrationPlaceholder: true,
    durationMs: 7000,
    primaryMeasurement: "completionTimeSec",
    supportingMeasurements: ["shoulderFlexionDeg", "elbowFlexionDeg", "trunkLateralLeanDeg", "trunkCompensationFlag", "movementSmoothness"],
    recordedCriteria: ["Completion Time", "Shoulder Flexion", "Elbow Flexion", "Trunk Lean", "Compensation", "Smoothness", "CQI", "Confidence"],
  },
  {
    id: "internal_rotation",
    malletCategory: "internalRotation",
    label: "Internal Rotation",
    clinicalPurpose:
      "A supplementary item added to this app's protocol beyond the classic 5-category Modified Mallet scale -- NOT part of Mallet 1972 / Bae et al. 2003. Graded I-V using the same ordinal philosophy as the other five, on the existing internalRotationDeg proxy. See docs/mallet-score.md §2 for why this proxy's ~90°-elbow-flexion operating window does not match a hand-behind-back posture -- a known, documented limitation, not redesigned this phase.",
    instruction: "Perform the Modified Mallet Internal Rotation task.",
    demoVideoPlaceholder: true,
    illustrationPlaceholder: true,
    durationMs: 7000,
    primaryMeasurement: "internalRotationDeg",
    supportingMeasurements: ["trunkCompensationFlag", "movementSmoothness"],
    recordedCriteria: ["Internal Rotation", "Compensation", "Movement Smoothness", "CQI", "Confidence"],
    usesExistingAlgorithmUnchanged: "shared/biomechanics/angle-computation.js computeAxialRotation() -- not modified this phase.",
  },
];

function getTaskById(id) {
  return TASKS.find((t) => t.id === id) || null;
}

export { TASKS, getTaskById };
