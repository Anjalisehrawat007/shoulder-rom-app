/**
 * angle-computation.js — Angle Computation
 * ----------------------------------------------------------------------------
 * Shoulder abduction, flexion, plane of elevation, and axial rotation,
 * computed by projecting the humerus/forearm vectors into a trunk-fixed
 * anatomical frame (shared/biomechanics/coordinate-frame.js) instead of
 * reading raw camera-space components. See docs/biomechanics.md for the
 * full derivation, per-parameter confidence rationale, and assumptions.
 *
 * Depends only on coordinate-frame.js and parameter-schema.js — no
 * MediaPipe, no DOM. Pure functions on plain {x,y,z} landmark objects.
 *
 * Phase 7 note: computeAxialRotation() below is now a thin wrapper
 * delegating to shared/biomechanics/rotation-estimation.js's redesigned
 * estimator -- see that file for the full biomechanical rationale and
 * math. computeShoulderAngles() gains one additive parameter, `side`
 * (default "right", backward compatible) -- the redesigned sign
 * convention needs to know which arm is being measured (see
 * rotation-estimation.js's header comment for why), which nothing in
 * this codebase previously threaded through this call chain.
 * shared/biomechanics/index.js (the ONE real caller, itself part of the
 * biomechanical engine and in scope for this phase) now passes it; every
 * caller OUTSIDE the biomechanical engine still just calls
 * computeParameters(lm, side) with its existing 2-argument signature and
 * is unaffected.
 * ----------------------------------------------------------------------------
 */
import { vec3, toLocalFrame } from "./coordinate-frame.js";
import { makeParameter } from "./parameter-schema.js";
import { estimateAxialRotation } from "./rotation-estimation.js";

const { v3, angleBetweenDeg } = vec3;

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Elevation angle, plane of elevation, abduction, and flexion for one side.
 *
 * Formulas (all operate on `humerusLocal`, the shoulder→elbow vector
 * expressed in trunk-local coordinates via toLocalFrame):
 *
 *   restDown             = [0,-1,0]   (trunk-local "arm hanging at rest" reference --
 *                                      MediaPipe's normalized y increases DOWNWARD, so a
 *                                      relaxed arm's shoulder->elbow vector already points
 *                                      in -y; this, not +y, is the correct "zero" reference)
 *   elevationDeg        = angleBetween(humerusLocal, restDown)
 *   planeOfElevationDeg  = atan2(humerusLocal.z, humerusLocal.x)
 *   abductionDeg        = angleBetween({humerusLocal.x, humerusLocal.y, 0}, restDown)
 *   flexionDeg          = angleBetween({0, humerusLocal.y, humerusLocal.z}, restDown)
 *
 * abductionDeg/flexionDeg are each 0 (not computed via angleBetween) whenever their
 * plane-projected vector's magnitude is negligible -- e.g. during a pure abduction
 * raise, the sagittal-plane projection {0, humerusLocal.y, humerusLocal.z} can be a
 * near-zero vector, and angleBetween of a near-zero vector is mathematically
 * undefined; without this guard it spuriously reads ~90deg instead of the correct 0deg.
 * (Caught by the synthetic check in scripts/verify-biomechanics.mjs -- see that file's
 * comments for the worked-through failure this guard fixes.)
 *
 * LIMITATION: abductionDeg and flexionDeg are plane projections of the SAME 3D
 * elevation, not mutually exclusive/complementary measurements. During scaption
 * (elevation through an intermediate plane, e.g. planeOfElevationDeg ~45deg), both
 * can read a substantial nonzero value simultaneously -- this is expected given the
 * projection definition, but means abductionDeg + flexionDeg should NOT be read as a
 * combined "total ROM" during non-pure movements. elevationDeg is the single
 * unambiguous "how far has the arm risen" quantity regardless of plane.
 *
 * abductionDeg depends only on the trunk-local x/y components (MediaPipe's
 * most reliable dimensions — no depth estimate involved), so it is tagged
 * "measured" with high confidence. flexionDeg and planeOfElevationDeg
 * depend on the trunk-local z component, which is built from MediaPipe's
 * weak monocular depth estimate — tagged "measured" too (this is still a
 * real geometric projection, not an arbitrary heuristic constant) but with
 * moderate confidence, documented as such rather than presented identically
 * to abduction.
 */
const NEAR_ZERO_MAGNITUDE = 1e-3;

function angleFromRestOrZero(projectedVector, restDown) {
  const mag = Math.sqrt(projectedVector.x ** 2 + projectedVector.y ** 2 + projectedVector.z ** 2);
  if (mag < NEAR_ZERO_MAGNITUDE) return 0;
  return angleBetweenDeg(projectedVector, restDown);
}

function computeElevationAngles({ shoulder, elbow, frame }) {
  const humerusWorld = v3(shoulder, elbow);
  const humerusLocal = toLocalFrame(frame, humerusWorld);
  const restDown = { x: 0, y: -1, z: 0 };

  const elevationDeg = angleBetweenDeg(humerusLocal, restDown);
  const planeOfElevationDeg = (Math.atan2(humerusLocal.z, humerusLocal.x) * 180) / Math.PI;

  const frontalPlaneProjection = { x: humerusLocal.x, y: humerusLocal.y, z: 0 };
  const sagittalPlaneProjection = { x: 0, y: humerusLocal.y, z: humerusLocal.z };
  const abductionDeg = angleFromRestOrZero(frontalPlaneProjection, restDown);
  const flexionDeg = angleFromRestOrZero(sagittalPlaneProjection, restDown);

  return {
    shoulderAbductionDeg: makeParameter({
      value: round1(abductionDeg),
      unit: "deg",
      measurementType: "measured",
      confidence: "high",
      limitation:
        "Projection depends only on the frontal-plane (x/y) trunk-local components, which do not rely on MediaPipe's weak monocular depth estimate.",
    }),
    shoulderFlexionDeg: makeParameter({
      value: round1(flexionDeg),
      unit: "deg",
      measurementType: "measured",
      confidence: "moderate",
      limitation:
        "Sagittal-plane projection depends on the trunk-local z component, derived from MediaPipe's monocular depth estimate, which is less reliable than x/y.",
    }),
    shoulderElevationDeg: makeParameter({
      value: round1(elevationDeg),
      unit: "deg",
      measurementType: "measured",
      confidence: "moderate",
      limitation: "Combines both trunk-local x/y and z components; inherits the z-dimension's lower reliability.",
    }),
    planeOfElevationDeg: makeParameter({
      value: round1(planeOfElevationDeg),
      unit: "deg",
      measurementType: "measured",
      confidence: "moderate",
      limitation:
        "ISB-style plane-of-elevation angle (0deg=frontal/abduction, 90deg=sagittal/flexion); can represent scaption (intermediate planes), which a lossy abduction+flexion split cannot. Depends on the z component.",
    }),
  };
}

/**
 * Axial (internal/external) rotation — EXPLICITLY AN ESTIMATED PARAMETER,
 * not a direct measurement. True humeral axial rotation requires tracking
 * rotation of the humerus about its own long axis, which is not observable
 * from shoulder/elbow/wrist skin-surface landmarks alone (no epicondyle
 * markers, no forearm cross-section reference).
 *
 * Phase 7: this is now a thin wrapper around shared/biomechanics/
 * rotation-estimation.js's estimateAxialRotation() -- same forearm-
 * orientation-proxy PRINCIPLE as before, but redesigned to (a) report
 * `unavailable` rather than a fabricated angle when the elbow is too
 * close to full extension for the proxy to carry any signal, and (b) use
 * a continuous, elbow-angle- and landmark-visibility-based confidence
 * instead of a fixed "low." See rotation-estimation.js for the full
 * biomechanical rationale, citations, and math. `side` is new (see file
 * header note) and defaults to "right" for backward compatibility.
 * `compensation` is new in Phase 8 (optional, default undefined -- see
 * rotation-estimation.js) so rotation confidence can account for trunk
 * compensation, per that phase's own verification findings.
 */
function computeAxialRotation({ shoulder, elbow, wrist, frame, side = "right", compensation }) {
  return estimateAxialRotation({ shoulder, elbow, wrist, frame, side, compensation });
}

/** Compute the full angle set for one side. `frame` is a trunk frame from
 *  buildTrunkFrame() (see coordinate-frame.js), built once per call site.
 *  `side` is new in Phase 7 (default "right", backward compatible) -- see
 *  file header note. `compensation` is new in Phase 8 (optional, the
 *  detectCompensation() output -- see rotation-estimation.js for how it's
 *  used). */
function computeShoulderAngles({ shoulder, elbow, wrist, frame, side = "right", compensation }) {
  return {
    ...computeElevationAngles({ shoulder, elbow, frame }),
    ...computeAxialRotation({ shoulder, elbow, wrist, frame, side, compensation }),
  };
}

export { computeShoulderAngles, computeElevationAngles, computeAxialRotation };
