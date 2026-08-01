/**
 * scapular-estimation.js — Scapular Estimation
 * ----------------------------------------------------------------------------
 * RESEARCH INTEGRITY NOTE (read before modifying this file):
 *
 * The previous implementation reported "scapular upward rotation" as a
 * fixed multiple of shoulder abduction (`abduction * 0.28`). That is not a
 * measurement of anything — it is a linear rescaling of a number this
 * module already has for a different joint, dressed up as an independent
 * scapular observation. It would trivially "correlate" with abduction in a
 * validation study (because it IS abduction, rescaled) while telling a
 * reviewer nothing about actual scapular kinematics.
 *
 * MediaPipe's 33-point pose model has NO scapula-specific landmarks — no
 * acromion, no inferior angle, no medial border points. Scapular upward
 * rotation is therefore not derivable from this landmark set by any
 * formula, heuristic or otherwise. Per the explicit research-integrity
 * requirement this system is built to: it is reported as `unavailable`
 * rather than replaced with a "better" fake formula.
 *
 * Scapular TILT and WINGING remain as low-confidence heuristics from
 * shoulder-line depth asymmetry — genuinely observable (if noisily) from
 * skin-surface landmarks, decoupled from any other joint's angle, and
 * explicitly tagged `estimated` / `low` confidence rather than presented as
 * clinical measurements.
 *
 * This module is intentionally isolated so a future scapula-specific CV
 * model (e.g. trained to detect acromion/scapular-border landmarks) can
 * replace its internals without touching any other module — callers only
 * depend on the {value, measurementType, confidence, limitation} schema
 * from parameter-schema.js, not on how the value was derived.
 * ----------------------------------------------------------------------------
 */
import { makeParameter } from "./parameter-schema.js";

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * @param {object} args
 * @param {object} args.shoulder - landmark on the tested side
 * @param {object} args.otherShoulder - landmark on the untested side
 */
function estimateScapularParameters({ shoulder, otherShoulder }) {
  const shoulderLineDepthDiff = Math.abs((shoulder.z ?? 0) - (otherShoulder.z ?? 0));

  return {
    scapularUpwardRotationDeg: makeParameter({
      value: null,
      unit: "deg",
      measurementType: "unavailable",
      confidence: null,
      limitation:
        "Not derivable from MediaPipe's 33-point landmark set, which has no scapula-specific landmarks " +
        "(no acromion, inferior angle, or medial border points). Requires a dedicated scapular landmark " +
        "model to populate; intentionally left null rather than approximated from an unrelated joint angle.",
    }),
    scapularTiltDeg: makeParameter({
      value: round1(shoulderLineDepthDiff * 150),
      unit: "deg",
      measurementType: "estimated",
      confidence: "low",
      limitation:
        "Heuristic proxy from shoulder-line depth asymmetry (relies on MediaPipe's weak monocular depth " +
        "estimate). Not validated against clinical scapular tilt measurement. Flagged for clinician " +
        "confirmation on the captured image rather than treated as an automated measurement.",
    }),
    scapularWingingFlag: makeParameter({
      value: shoulderLineDepthDiff > 0.06,
      unit: "boolean",
      measurementType: "estimated",
      confidence: "low",
      limitation:
        "Asymmetric shoulder depth MAY indicate winging but is a coarse threshold heuristic, not a validated " +
        "detector. Requires clinician confirmation on the captured still image before any clinical use.",
    }),
  };
}

export { estimateScapularParameters };
