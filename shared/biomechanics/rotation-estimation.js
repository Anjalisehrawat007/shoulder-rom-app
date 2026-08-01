/**
 * rotation-estimation.js — Phase 7: redesigned axial (internal/external)
 * rotation estimator
 * ----------------------------------------------------------------------------
 * Replaces the internals of angle-computation.js's computeAxialRotation()
 * (which now delegates here, unchanged export name/signature -- see that
 * file). This is a drop-in replacement: same two output keys
 * (externalRotationDeg/internalRotationDeg), same 5-field envelope contract
 * every consumer already reads (value/unit/measurementType/confidence/
 * limitation), plus new ADDITIVE fields for explainability that any
 * existing consumer simply ignores.
 *
 * WHY A REDESIGN WAS NEEDED (diagnosed, not assumed -- see the Phase 7
 * final report for the full analysis): the old code computed one unsigned
 * angle via acos-based angleBetweenDeg (always >= 0) and a hard binary
 * z<0 sign split, then ZEROED whichever of external/internal wasn't
 * selected -- so near the split boundary, ordinary landmark noise could
 * flip which field got the real number, and the OTHER field would report
 * a confident-looking "0.0deg, estimated" instead of an honest "don't
 * know." Separately, the old code ALWAYS produced a number, even when the
 * elbow was near full extension, where the forearm-sweep signal is
 * mathematically zero (a vector colinear with the rotation axis is
 * invariant under rotation about that axis -- this isn't "low
 * confidence," it's no information at all).
 *
 * THE FIX, in two parts:
 *  1. A continuous, closed-form SENSITIVITY measure --
 *     sensitivity = |forearmPerpWorld| / |forearmWorld| = sin(elbow angle)
 *     -- computed from geometry the old code ALREADY built
 *     (projectOntoPlane), just never used. 0 at full extension (genuinely
 *     zero information), 1 at 90deg flexion (maximum information). Below
 *     a documented cutoff, this function reports `unavailable`, not a
 *     fabricated angle -- this is the actual fix for "Internal Rotation
 *     frequently approaching 0deg."
 *  2. A continuous signed angle via atan2 (not acos + a separate sign
 *     hack) -- numerically stable, no boundary discontinuity.
 *
 * BIOMECHANICAL BASIS (see the Phase 7 final report for full citations):
 * true humeral axial rotation per the ISB shoulder standard (Wu et al.
 * 2005) requires a humeral coordinate frame anchored to the medial/
 * lateral epicondyles -- landmarks MediaPipe's 33-point set does not
 * provide. The forearm-sweep-at-~90deg-elbow-flexion technique used here
 * is the SAME principle standard clinical goniometry already uses for
 * shoulder IR/ER (elbow at side, flexed 90deg) -- this function's job is
 * to be honest about how far the ACTUAL posture is from that ideal, not
 * to assume it's always satisfied.
 *
 * LIMITATION NOT FIXED BY THIS REDESIGN (stated, not hidden): scapulohumeral
 * rhythm (Inman, Saunders, Abbott 1944; Ludewig & Reynolds 2009) means
 * that as the arm elevates, the scapula itself rotates, so a trunk-relative
 * reference increasingly diverges from true glenohumeral orientation for
 * tasks with concurrent elevation (e.g. Hand to Neck/Mouth). This proxy
 * is most valid for an arm-at-side posture (Task 2's instruction), least
 * valid for elevated-arm phases of other tasks -- no scapular tracking
 * exists in this codebase to correct for it.
 *
 * PHASE 8 ADDITIONS (verification/hardening, not a further redesign --
 * see scripts/verify-rotation-stability.mjs and the Phase 8 final report):
 * two more confidence factors, both closing genuine gaps found by checking
 * this file against Phase 8's own explicit acceptance criteria. (1)
 * `trunkStabilityScore`, from an optional `compensation` argument (the
 * existing, unmodified detectCompensation() output) -- confidence now
 * falls as trunk lateral lean increases, previously not modeled at all.
 * (2) `postureScore`, computed internally from data already in scope
 * (`humerusLocal`) -- confidence now falls as the arm elevates away from
 * the "hanging at the side" posture the whole technique assumes, closing
 * a failure mode (an elevated arm with elbow still near 90deg previously
 * scored identically to a properly-positioned one). Both default to
 * neutral (no penalty) when their inputs aren't available, so every
 * existing caller is unaffected unless it opts in.
 * ----------------------------------------------------------------------------
 */
import { vec3, toLocalFrame, projectOntoPlane } from "./coordinate-frame.js";
import { makeParameter } from "./parameter-schema.js";

const { v3, magnitude, angleBetweenDeg } = vec3;
const EPSILON = 1e-9;

/**
 * Default thresholds -- embedded as a plain object rather than fetched
 * from config/rotation-estimation-config.v1.json at runtime, because
 * computeParameters(lm, side) must stay perfectly synchronous with an
 * unchanged signature (called many times per second from the live frame
 * loop; its callers are out of scope for this phase). The JSON file is
 * the versioned, documented reference copy -- kept identical by hand.
 */
const DEFAULT_CONFIG = {
  idealElbowAngleDeg: 90,
  minSensitivityForUnavailable: 0.3,
  // Phase 8: reweighted from {sensitivity:0.65, landmarkVisibility:0.35} to
  // four components -- trunkCompensation and posture were identified during
  // Phase 8 verification as genuine gaps against that phase's own explicit
  // confidence-behavior requirements (confidence must fall when trunk
  // compensation increases; a failure-mode analysis separately surfaced
  // that the algorithm couldn't distinguish an arm properly at the side
  // from an elevated/abducted arm, both scoring identically before this).
  confidenceBlend: { sensitivity: 0.45, landmarkVisibility: 0.2, trunkCompensation: 0.15, posture: 0.2 },
  confidenceBuckets: { high: 0.75, moderate: 0.45 },
  landmarkReliabilityBuckets: { high: 0.75, moderate: 0.45 },
  defaultVisibilityWhenMissing: 0.8,
  trustScoreWeights: { confidenceScore: 0.7, landmarkReliability: 0.3 },
  // Phase 8 additions:
  maxTolerableLeanDeg: 25, // trunkStabilityScore reaches 0 at/beyond this much lateral lean
  maxTolerableElevationDeg: 60, // postureScore reaches 0 at/beyond this much arm elevation from "hanging at the side"
};

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}
function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}
function bucket(score, buckets) {
  if (score >= buckets.high) return "high";
  if (score >= buckets.moderate) return "moderate";
  return "low";
}

/** Mean of whatever `.visibility` values are present, defaulting missing
 *  ones to `defaultVisibility` (a documented neutral assumption, not a
 *  claim of certainty) rather than crashing or silently treating a
 *  missing landmark as fully visible. */
function meanVisibility(points, defaultVisibility) {
  const vals = points.map((p) => p?.visibility ?? defaultVisibility);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const CITATION_LIMITATION =
  "Not directly observable from shoulder/elbow/wrist landmarks alone -- true humeral axial rotation per the ISB shoulder standard (Wu et al. 2005) requires a humeral frame anchored to the medial/lateral epicondyles, which this landmark set does not provide. This is a forearm-orientation proxy, confidence-weighted by how close the current elbow angle is to the ~90deg window where it is actually informative, referenced against the trunk's own frame rather than raw camera 'up.'";

/**
 * @param {object} args
 * @param {object} args.shoulder - {x,y,z,visibility?}
 * @param {object} args.elbow
 * @param {object} args.wrist
 * @param {object} args.frame - a trunk frame from buildTrunkFrame()
 * @param {"left"|"right"} [args.side] - which arm is under test (default "right") -- needed
 *   because the sign convention below ("away from the body" = external) is mirrored
 *   between the two arms; see the signedRotationDeg derivation for why.
 * @param {object} [args.compensation] - optional detectCompensation() output (shared/biomechanics/
 *   compensation-detection.js, unmodified) -- when supplied, trunk lateral lean reduces confidence
 *   (Phase 8). Omitting it is fully backward compatible: confidence simply isn't penalized for
 *   compensation the caller didn't tell this function about, rather than assuming the worst.
 * @param {object} [config] - defaults to DEFAULT_CONFIG; override for testing/tuning
 * @returns {{externalRotationDeg: object, internalRotationDeg: object}}
 */
function estimateAxialRotation({ shoulder, elbow, wrist, frame, side = "right", compensation = null }, config = DEFAULT_CONFIG) {
  if (!shoulder || !elbow || !wrist) {
    const limitation = "Shoulder, elbow, and wrist landmarks are all required to compute the forearm-sweep proxy; at least one was not detected in this frame.";
    const shared = {
      signedRotationDeg: null,
      confidenceScore: 0,
      trustScore: 0,
      landmarkReliability: "low",
      supportingMeasurements: { elbowFlexionDeg: null, sensitivity: null, landmarkVisibility: { shoulder: shoulder?.visibility ?? null, elbow: elbow?.visibility ?? null, wrist: wrist?.visibility ?? null } },
      assumptions: [],
      measurementLimitations: [limitation],
      cqiContribution: null,
      reasoning: "Unavailable: one or more of shoulder/elbow/wrist was not detected in this frame.",
    };
    const envelope = { ...makeParameter({ value: null, unit: "deg", measurementType: "unavailable", limitation }), ...shared };
    return { externalRotationDeg: envelope, internalRotationDeg: envelope };
  }

  // Phase 8: defensive check against a degenerate trunk frame (e.g.
  // coincident/near-coincident shoulder or hip landmarks). Two failure
  // shapes were found during this phase's failure-mode testing, so both
  // are checked: (1) a non-finite basis vector, which would propagate NaN
  // all the way through to a "successful"-looking but garbage output; (2)
  // a near-ZERO basis vector, which is finite but not caught by a
  // finite-only check -- coordinate-frame.js's normalize() divides by
  // `magnitude(a) || EPSILON`, so normalizing an exactly-zero vector (from
  // fully coincident landmarks) yields {0,0,0}, not NaN. A real, non-degenerate
  // frame's axes are always unit length (~1), so magnitude is checked, not
  // just finiteness -- this was verified as a genuine gap, not a hypothetical
  // one: a degenerate-frame test initially still produced a fabricated
  // "high confidence, 0deg" result before this magnitude check was added.
  const axisIsValid = (axis) => axis && Number.isFinite(axis.x) && Number.isFinite(axis.y) && Number.isFinite(axis.z) && Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z) > 0.5;
  const frameIsValid = [frame?.x, frame?.y, frame?.z].every(axisIsValid);
  if (!frameIsValid) {
    const limitation = "The trunk reference frame could not be constructed (degenerate or missing shoulder/hip landmarks) -- rotation cannot be expressed relative to an undefined frame.";
    const shared = {
      signedRotationDeg: null,
      confidenceScore: 0,
      trustScore: 0,
      landmarkReliability: "low",
      supportingMeasurements: { elbowFlexionDeg: null, sensitivity: null, landmarkVisibility: { shoulder: shoulder?.visibility ?? null, elbow: elbow?.visibility ?? null, wrist: wrist?.visibility ?? null } },
      assumptions: [],
      measurementLimitations: [limitation],
      cqiContribution: null,
      reasoning: "Unavailable: trunk reference frame is degenerate.",
    };
    const envelope = { ...makeParameter({ value: null, unit: "deg", measurementType: "unavailable", limitation }), ...shared };
    return { externalRotationDeg: envelope, internalRotationDeg: envelope };
  }

  const humerusWorld = v3(shoulder, elbow);
  const forearmWorld = v3(elbow, wrist);
  const forearmMag = magnitude(forearmWorld);
  const forearmPerpWorld = projectOntoPlane(forearmWorld, humerusWorld);
  const perpMag = magnitude(forearmPerpWorld);

  // sensitivity = sin(elbow included angle): 0 at full extension (forearm
  // colinear with humerus -- mathematically zero rotational information),
  // 1 at 90deg flexion (forearm exactly perpendicular -- maximum information).
  const sensitivity = forearmMag > EPSILON ? clamp01(perpMag / forearmMag) : 0;

  // Included angle at the elbow (180deg=fully extended, 90deg=right angle) --
  // same convention shared/assessment/mallet-measurements.js's
  // computeElbowFlexionDeg already uses, for consistency across the app.
  const elbowAngleDeg = round1(angleBetweenDeg(v3(elbow, shoulder), v3(elbow, wrist)));

  // Phase 8: how far the upper arm is from "hanging at the side" (the
  // clinical technique's assumed posture) -- 0deg = hanging straight down,
  // larger = elevated/abducted away from the body. Computed from data
  // already in scope (humerusWorld, frame), no new parameter needed. This
  // catches "incorrect posture" (e.g. elbow near 90deg but the arm is
  // raised overhead) -- geometrically just as sensitive/informative as an
  // arm-at-side 90deg-elbow posture, but not what the clinical technique
  // (and this proxy's own operating assumption) actually calls for.
  const humerusLocal = toLocalFrame(frame, humerusWorld);
  const restDownLocal = { x: 0, y: -1, z: 0 };
  const armElevationFromRestDeg = round1(angleBetweenDeg(humerusLocal, restDownLocal));
  const postureScore = clamp01(1 - armElevationFromRestDeg / config.maxTolerableElevationDeg);

  // Phase 8: trunk compensation as a confidence factor. `compensation` is
  // detectCompensation()'s own, unmodified output -- this function only
  // reads its trunkLateralLeanDeg value, never recomputes trunk lean
  // itself. Absent (not supplied) -> neutral (no penalty), so this stays
  // fully backward compatible with any caller that doesn't have it handy.
  const leanDeg = compensation?.trunkLateralLeanDeg?.value ?? 0;
  const trunkStabilityScore = clamp01(1 - leanDeg / config.maxTolerableLeanDeg);

  const visibilityScore = clamp01(meanVisibility([shoulder, elbow, wrist], config.defaultVisibilityWhenMissing));
  const landmarkReliability = bucket(visibilityScore, config.landmarkReliabilityBuckets);

  const confidenceScore = clamp01(
    config.confidenceBlend.sensitivity * sensitivity +
      config.confidenceBlend.landmarkVisibility * visibilityScore +
      config.confidenceBlend.trunkCompensation * trunkStabilityScore +
      config.confidenceBlend.posture * postureScore
  );

  const supportingMeasurements = {
    elbowFlexionDeg: elbowAngleDeg,
    sensitivity: round2(sensitivity),
    armElevationFromRestDeg,
    trunkLateralLeanDeg: compensation?.trunkLateralLeanDeg?.value ?? null,
    landmarkVisibility: {
      shoulder: round2(shoulder?.visibility ?? null),
      elbow: round2(elbow?.visibility ?? null),
      wrist: round2(wrist?.visibility ?? null),
    },
  };

  const assumptions = [
    "The trunk (shoulder/hip landmarks) is treated as the rotation reference frame; true glenohumeral rotation is referenced to the scapula, which is not directly trackable from skin-surface landmarks alone.",
    "The forearm-sweep-around-the-humeral-axis technique is only informative near 90deg elbow flexion; this function models sensitivity as a continuous function of the CURRENT elbow angle rather than assuming 90deg is always achieved.",
    "Most valid for an arm-at-side posture; scapulohumeral rhythm during concurrent shoulder elevation increasingly decouples the trunk-relative reference from true glenohumeral orientation (Inman, Saunders, Abbott 1944; Ludewig & Reynolds 2009). Arm elevation away from the side is penalized in confidence for exactly this reason.",
    compensation ? "Trunk compensation (lateral lean) is factored into confidence when supplied; a leaning trunk makes the trunk-relative reference frame itself less representative of a stable postural baseline." : "Trunk compensation data was not supplied for this estimate; confidence does not account for it.",
  ];

  const elbowWindowNote =
    elbowAngleDeg != null && Math.abs(elbowAngleDeg - config.idealElbowAngleDeg) <= 25
      ? `elbow angle ${elbowAngleDeg}° is near the ideal ~${config.idealElbowAngleDeg}° window`
      : `elbow angle ${elbowAngleDeg}° is away from the ideal ~${config.idealElbowAngleDeg}° window`;

  if (sensitivity < config.minSensitivityForUnavailable) {
    const limitation =
      `Elbow angle (${elbowAngleDeg}°) is too close to full extension for the forearm-sweep proxy to carry meaningful rotational information ` +
      `(sensitivity=${round2(sensitivity)}, below the ${config.minSensitivityForUnavailable} cutoff) -- a forearm colinear with the humerus is ` +
      `mathematically invariant under axial rotation, so no signal exists at this posture, not just a noisy one.`;
    const shared = {
      signedRotationDeg: null,
      confidenceScore: round2(confidenceScore),
      trustScore: 0,
      landmarkReliability,
      supportingMeasurements,
      assumptions,
      measurementLimitations: [limitation],
      cqiContribution: null, // not wired into a live CQI source at this stage of the pipeline -- see Phase 7 final report
      reasoning: `Unavailable: ${elbowWindowNote}, leaving essentially no forearm-sweep signal to estimate rotation from. Camera quality (CQI): not evaluated at this stage.`,
    };
    const envelope = { ...makeParameter({ value: null, unit: "deg", measurementType: "unavailable", limitation }), ...shared };
    return { externalRotationDeg: envelope, internalRotationDeg: envelope };
  }

  const forearmPerpLocal = toLocalFrame(frame, forearmPerpWorld);
  // Continuous signed angle via atan2 over the LOCAL X (lateral) and Z
  // (anterior) components -- NOT Y. This matters: for the clinically
  // intended posture (elbow at the side, humerus roughly vertical), the
  // humerus is nearly parallel to the trunk frame's own Y axis (verified
  // directly: a straight-hanging arm's humerusLocal comes out as
  // approximately {0, -|humerus|, 0}). Since forearmPerpWorld is by
  // construction perpendicular to the humerus, its LOCAL Y component is
  // then also ~0 in exactly this common case -- an angle formula that
  // used Y as one of its two reference axes (as an earlier draft of this
  // function did, and arguably as the original pre-Phase-7 implementation
  // implicitly did too, via angleBetween(..., [0,1,0])) would be measuring
  // against a near-degenerate reference for the MOST common clinical
  // posture, not a rare edge case. The X-Z plane is the anatomically
  // correct one: with the humerus vertical, rotating it sweeps the
  // forearm through the horizontal-ish plane spanned by trunk-lateral (X)
  // and trunk-anterior (Z) -- confirmed by direct computation, not
  // assumed. `lateralAway` flips sign by side so "swept away from the
  // body" is positive (external) for EITHER arm -- external rotation of
  // the right shoulder sweeps the forearm toward local +X, external
  // rotation of the left shoulder sweeps it toward local -X, since the
  // trunk frame's X axis is a single, side-independent "right" direction.
  const lateralAway = side === "right" ? forearmPerpLocal.x : -forearmPerpLocal.x;
  const signedRotationDeg = round1((Math.atan2(lateralAway, forearmPerpLocal.z) * 180) / Math.PI);

  const confidenceBucketLabel = bucket(confidenceScore, config.confidenceBuckets);
  const trustScore = Math.round(
    100 * clamp01(config.trustScoreWeights.confidenceScore * confidenceScore + config.trustScoreWeights.landmarkReliability * visibilityScore)
  );

  const externalValue = Math.max(0, signedRotationDeg);
  const internalValue = Math.max(0, -signedRotationDeg);

  function buildEnvelope(value, direction) {
    const postureNote = armElevationFromRestDeg <= 30 ? "arm close to the side" : `arm elevated ~${armElevationFromRestDeg}° from the side`;
    const compensationNote = compensation ? (leanDeg > 5 ? `trunk lean ~${round1(leanDeg)}°` : "trunk stable") : "trunk compensation not evaluated";
    const reasoning =
      `Estimated ${direction} rotation ${round1(value)}°. ` +
      `• Elbow angle ${elbowAngleDeg}° (${elbowWindowNote.replace(`elbow angle ${elbowAngleDeg}° is `, "")}) ` +
      `• Forearm-sweep sensitivity ${Math.round(sensitivity * 100)}% ` +
      `• Landmark visibility ${landmarkReliability} ` +
      `• Posture: ${postureNote} ` +
      `• Compensation: ${compensationNote} ` +
      `• Camera quality (CQI): not evaluated at the single-frame stage (see the trajectory-level estimate when available) ` +
      `• Confidence ${confidenceBucketLabel} (${Math.round(confidenceScore * 100)}%) ` +
      `• Trust score ${trustScore}`;
    return {
      ...makeParameter({ value: round1(value), unit: "deg", measurementType: "estimated", confidence: confidenceBucketLabel, limitation: CITATION_LIMITATION }),
      signedRotationDeg,
      confidenceScore: round2(confidenceScore),
      trustScore,
      landmarkReliability,
      supportingMeasurements,
      assumptions,
      measurementLimitations: [CITATION_LIMITATION],
      cqiContribution: null,
      reasoning,
    };
  }

  return {
    externalRotationDeg: buildEnvelope(externalValue, "external"),
    internalRotationDeg: buildEnvelope(internalValue, "internal"),
  };
}

export { estimateAxialRotation, DEFAULT_CONFIG };
