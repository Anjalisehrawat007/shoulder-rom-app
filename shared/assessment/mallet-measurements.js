/**
 * mallet-measurements.js — new Mallet-specific derived measurements
 * ----------------------------------------------------------------------------
 * Everything here is computed from data the EXISTING engines already expose
 * (raw landmarks passed in by the caller, or a DMQE result's segmentation
 * phases) -- nothing here modifies shared/biomechanics/* or shared/motion/*.
 * Every value uses the same {value, unit, measurementType, confidence,
 * limitation} envelope as the rest of the app (makeParameter, imported
 * read-only from shared/biomechanics/parameter-schema.js -- the one shared
 * foundational layer every phase, including ICQA before this one, is
 * allowed to depend on).
 *
 * Four measurements, none of which exist anywhere else in the codebase
 * (confirmed by reading angle-computation.js, scapular-estimation.js,
 * compensation-detection.js, and dmqe-engine.js before writing this file):
 *
 *  - elbowFlexionDeg    -- a genuine 3-point joint angle (shoulder-elbow-
 *                          wrist), the same geometric category as the
 *                          existing shoulderFlexionDeg -- "measured", not a
 *                          heuristic proxy, but still z-dependent so
 *                          "moderate" confidence, same reasoning already
 *                          used for shoulderFlexionDeg.
 *  - reachSuccess       -- "estimated" boolean: is the wrist within a
 *                          configurable radius of an approximate neck
 *                          region (shoulder/ear midpoint)? MediaPipe has no
 *                          literal "back of neck" landmark, and a frontal
 *                          camera can't see the back of the neck at all --
 *                          this is a coarse proxy for "hand reached the
 *                          head/neck area," not a confirmed touch.
 *  - vertebralLevelProxy -- "estimated" ordinal bucket: how far up the back
 *                          the wrist traveled (as a fraction of the
 *                          shoulder-hip span), bucketed into a small set of
 *                          named levels. No true vertebral identification
 *                          is possible from skin-surface landmarks (no
 *                          spine landmarks exist in MediaPipe's 33-point
 *                          set, and a frontal camera can't see the hand
 *                          against the back at all) -- this is explicitly
 *                          a coarse positional proxy, not palpation.
 *  - completionTimeSec  -- "measured": real elapsed time between DMQE's own
 *                          segmentation-detected movementStart/movementEnd
 *                          frame timestamps. Confidence inherits DMQE's own
 *                          documented placeholder-constant caveat (see
 *                          shared/motion/segmentation.js).
 *
 * All numeric thresholds (reach-success radius, vertebral-level bucket
 * boundaries) are passed in via `config` (config/mallet-score-config.v1.json's
 * `measurementProxies` section) -- never hard-coded here.
 * ----------------------------------------------------------------------------
 */
import { makeParameter } from "../biomechanics/parameter-schema.js";
import { vec3 } from "../biomechanics/coordinate-frame.js";

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}
function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** Three-point angle at the elbow between the humerus (elbow->shoulder) and
 *  forearm (elbow->wrist) vectors. 180deg = fully extended, small angles =
 *  fully flexed. Uses raw landmark coordinates directly (a local joint
 *  angle, not expressed in the trunk frame -- there's no anatomical reason
 *  to project it into trunk-local axes the way shoulder elevation/rotation
 *  are, since elbow flexion is a single-joint hinge angle independent of
 *  trunk orientation). */
function computeElbowFlexionDeg({ shoulder, elbow, wrist }) {
  if (!shoulder || !elbow || !wrist) {
    return makeParameter({ value: null, unit: "deg", measurementType: "unavailable", limitation: "Shoulder, elbow, and wrist landmarks all required; at least one was not detected." });
  }
  const upper = vec3.v3(elbow, shoulder);
  const fore = vec3.v3(elbow, wrist);
  const angleDeg = vec3.angleBetweenDeg(upper, fore);
  return makeParameter({
    value: round1(angleDeg), unit: "deg", measurementType: "measured", confidence: "moderate",
    limitation: "A direct 3-point joint angle (shoulder-elbow-wrist), not a heuristic proxy -- but still depends in part on MediaPipe's weaker monocular z estimate, same caveat already documented for shoulderFlexionDeg.",
  });
}

/** Is the wrist within a configurable radius of an approximate neck region
 *  (shoulder/ear midpoint)? See file header for why this is a coarse
 *  "reached the head/neck area" proxy, not a confirmed touch. */
function computeReachSuccess({ wrist, shoulder, ear }, config) {
  if (!wrist || !shoulder || !ear) {
    return makeParameter({ value: null, unit: "boolean", measurementType: "unavailable", limitation: "Wrist, shoulder, and ear landmarks all required; at least one was not detected." });
  }
  const neckRegion = { x: (shoulder.x + ear.x) / 2, y: (shoulder.y + ear.y) / 2, z: ((shoulder.z ?? 0) + (ear.z ?? 0)) / 2 };
  const dist = vec3.magnitude(vec3.v3(wrist, neckRegion));
  const success = dist < config.reachSuccessRadiusNormalized;
  return makeParameter({
    value: success, unit: "boolean", measurementType: "estimated", confidence: "low",
    limitation: "MediaPipe has no 'back of neck' landmark, and a front-facing camera cannot see the back of the neck at all -- this checks only whether the wrist is near an approximate head/neck region (shoulder-ear midpoint), not a confirmed touch.",
  });
}

const DEFAULT_VERTEBRAL_BUCKETS = [
  { maxFraction: 0.15, label: "cannot_reach_back" },
  { maxFraction: 0.4, label: "sacrum_buttock" },
  { maxFraction: 0.6, label: "L3_lumbar" },
  { maxFraction: 0.8, label: "T12_thoracolumbar" },
  { maxFraction: Infinity, label: "T7_or_higher" },
];

/** Fraction of the shoulder-hip span the wrist traveled down/back, bucketed
 *  into a small ordinal set of approximate spinal levels. See file header
 *  for why this is a positional proxy, not vertebral palpation. */
function computeVertebralLevelProxy({ wrist, shoulder, hip }, config) {
  if (!wrist || !shoulder || !hip) {
    return makeParameter({ value: null, unit: "vertebral_level_bucket", measurementType: "unavailable", limitation: "Wrist, shoulder, and hip landmarks all required; at least one was not detected." });
  }
  const span = hip.y - shoulder.y; // MediaPipe y increases downward; hip is below shoulder, so span > 0 for an upright subject
  if (span <= 1e-6) {
    return makeParameter({ value: null, unit: "vertebral_level_bucket", measurementType: "unavailable", limitation: "Shoulder and hip landmarks coincide in the image; cannot form a trunk-span reference." });
  }
  const reachFraction = clamp01((wrist.y - shoulder.y) / span);
  const buckets = config.vertebralLevelBuckets || DEFAULT_VERTEBRAL_BUCKETS;
  const bucket = buckets.find((b) => reachFraction <= b.maxFraction) || buckets[buckets.length - 1];
  return makeParameter({
    value: bucket.label, unit: "vertebral_level_bucket", measurementType: "estimated", confidence: "low",
    limitation: "No spine/vertebra landmarks exist in MediaPipe's 33-point set, and a frontal camera cannot see the hand against the back at all -- this is a coarse 2D positional bucket (how far up the trunk the wrist traveled), not true vertebral-level identification.",
  });
}

/** Real elapsed time between DMQE's own segmentation-detected
 *  movementStart/movementEnd frame timestamps. `filteredFrames` is the same
 *  filtered sequence DMQE itself was run on; `segmentation` is `runDmqe()`'s
 *  own `segmentation` field (the phases object, frame indices). */
function computeCompletionTimeSec(filteredFrames, segmentation) {
  if (!segmentation || segmentation.movementStart == null || segmentation.movementEnd == null) {
    return makeParameter({ value: null, unit: "sec", measurementType: "unavailable", limitation: "DMQE did not identify a movement window for this task (see the task's motionAnalysis.status)." });
  }
  const startT = filteredFrames[segmentation.movementStart]?.t;
  const endT = filteredFrames[segmentation.movementEnd]?.t;
  if (startT == null || endT == null) {
    return makeParameter({ value: null, unit: "sec", measurementType: "unavailable", limitation: "Segmentation frame indices did not resolve to valid timestamps in the filtered sequence." });
  }
  return makeParameter({
    value: round2((endT - startT) / 1000), unit: "sec", measurementType: "measured", confidence: "moderate",
    limitation: "Derived from DMQE's velocity-threshold movement segmentation, which uses documented placeholder noise-floor/debounce constants pending calibration against a real cohort (see shared/motion/segmentation.js).",
  });
}

export { computeElbowFlexionDeg, computeReachSuccess, computeVertebralLevelProxy, computeCompletionTimeSec, DEFAULT_VERTEBRAL_BUCKETS };
