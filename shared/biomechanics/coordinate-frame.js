/**
 * coordinate-frame.js — Biomechanical Engine
 * ----------------------------------------------------------------------------
 * Pure vector/matrix math and anatomical coordinate frame construction. No
 * MediaPipe dependency, no DOM dependency — operates only on plain
 * {x, y, z} landmark objects, so it is independently testable and reusable
 * (e.g. for future server-side reprocessing of stored raw landmarks).
 *
 * WHY A TRUNK-FIXED FRAME (not raw camera axes):
 * The previous implementation split shoulder abduction/flexion by comparing
 * |upperArm.x| to |upperArm.z| directly in camera space. That is not an
 * anatomical measurement — it is systematically biased by how squarely the
 * patient happens to face the camera, since camera-space X/Z do not
 * correspond to any fixed direction on the patient's body. This module
 * instead builds a coordinate frame anchored in the patient's own trunk
 * geometry (shoulder and hip landmarks), so anatomical planes (frontal,
 * sagittal) are defined relative to the BODY, not the camera. See
 * docs/biomechanics.md for full derivation and the camera-orientation
 * invariance check in scripts/verify-biomechanics.js.
 *
 * ASSUMPTIONS (see docs/biomechanics.md for the complete list):
 *  - The trunk is treated as rigid between the hip and shoulder landmarks
 *    for the duration of a single frame (standard biomechanics simplification).
 *  - The glenohumeral joint center is approximated by the MediaPipe shoulder
 *    landmark (no true joint-center regression is available from skin-surface
 *    landmarks alone).
 *  - MediaPipe's z-coordinate is a rough, weakly-scaled monocular depth
 *    estimate, not calibrated 3D depth — the frame construction below
 *    minimizes (but cannot eliminate) sensitivity to this by anchoring two
 *    of three axes in the frontal plane (x,y — the most reliable MediaPipe
 *    dimensions) and only using z, via a cross product, for the third axis.
 * ----------------------------------------------------------------------------
 */

const EPSILON = 1e-9;

// ---- basic vector algebra ---------------------------------------------------

/** Vector from point a to point b. */
function v3(a, b) {
  return { x: b.x - a.x, y: b.y - a.y, z: (b.z ?? 0) - (a.z ?? 0) };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: (a.z ?? 0) + (b.z ?? 0) };
}

function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: (a.z ?? 0) * s };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
}

/** Right-handed cross product a × b. */
function cross(a, b) {
  return {
    x: a.y * (b.z ?? 0) - (a.z ?? 0) * b.y,
    y: (a.z ?? 0) * b.x - a.x * (b.z ?? 0),
    z: a.x * b.y - a.y * b.x,
  };
}

function magnitude(a) {
  return Math.sqrt(dot(a, a)) || EPSILON;
}

function normalize(a) {
  const m = magnitude(a);
  return { x: a.x / m, y: a.y / m, z: (a.z ?? 0) / m };
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Angle between two vectors, in degrees, via the dot-product definition
 *  cos(theta) = (a·b) / (|a||b|). Always returns a value in [0, 180]. */
function angleBetweenDeg(a, b) {
  const c = clamp(dot(a, b) / (magnitude(a) * magnitude(b)), -1, 1);
  return (Math.acos(c) * 180) / Math.PI;
}

// ---- 3x3 rotation matrix utilities ------------------------------------------
// A frame's basis vectors {x, y, z}, each unit length and mutually
// orthogonal, form the columns of an orthonormal rotation matrix R that maps
// local (trunk-relative) coordinates to world (camera-relative) coordinates:
//   v_world = R · v_local
// Because R is orthonormal, its inverse equals its transpose, so the reverse
// mapping (world → local, i.e. "how does this vector look from the trunk's
// own point of view") is:
//   v_local = R^T · v_world
// which is exactly what toLocalFrame() below computes — one dot product per
// output axis, which is algebraically the transpose-matrix multiply without
// needing an explicit matrix object.

/** Build the 3x3 rotation matrix (as column vectors) for a frame. */
function matrixFromBasis(frame) {
  return { columns: [frame.x, frame.y, frame.z] };
}

/** Transpose of a 3x3 matrix given as column vectors — for an orthonormal
 *  matrix this equals its inverse. */
function transpose(matrix) {
  const [c0, c1, c2] = matrix.columns;
  return {
    rows: [
      { x: c0.x, y: c1.x, z: c2.x },
      { x: c0.y, y: c1.y, z: c2.y },
      { x: c0.z, y: c1.z, z: c2.z },
    ],
  };
}

/** Multiply a row-form matrix by a vector: out_i = row_i · v. */
function multiplyMatrixVector(rowMatrix, v) {
  const [r0, r1, r2] = rowMatrix.rows;
  return { x: dot(r0, v), y: dot(r1, v), z: dot(r2, v) };
}

// ---- anatomical trunk frame --------------------------------------------------

/**
 * Build a trunk-fixed, right-handed, orthonormal anatomical coordinate frame
 * from four landmarks. This is the reference frame every joint angle in
 * angle-computation.js is expressed relative to.
 *
 * Construction (Gram-Schmidt-style, so the result is always exactly
 * orthonormal even if the raw landmarks are slightly noisy/non-rectangular):
 *
 *   shoulderMid = midpoint(leftShoulder, rightShoulder)
 *   hipMid      = midpoint(leftHip, rightHip)
 *
 *   Y = normalize(shoulderMid − hipMid)                    (superior axis)
 *   Z = normalize((rightShoulder − leftShoulder) × Y)       (anterior axis)
 *   X = normalize(Y × Z)                                    (right axis, re-orthogonalized)
 *
 * Y is the trunk's long axis. Z is perpendicular to both the shoulder line
 * and Y, pointing anteriorly (out of the chest) for a landmark set numbered
 * left-to-right in the usual MediaPipe convention. X is derived last via a
 * second cross product specifically so the final basis is exactly
 * orthonormal regardless of whether the raw shoulder line was perfectly
 * perpendicular to the spine (it usually isn't, especially with imperfect
 * posture or camera angle) — this is what makes the frame well-defined even
 * under patient rotation relative to the camera.
 *
 * @returns {{origin: object, x: object, y: object, z: object}}
 */
function buildTrunkFrame({ leftShoulder, rightShoulder, leftHip, rightHip }) {
  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const hipMid = midpoint(leftHip, rightHip);

  const y = normalize(v3(hipMid, shoulderMid));
  const shoulderLine = v3(leftShoulder, rightShoulder); // left -> right
  const z = normalize(cross(shoulderLine, y));
  const x = normalize(cross(y, z));

  return { origin: shoulderMid, x, y, z };
}

/**
 * Express a world-space vector in trunk-local coordinates: how much of the
 * vector lies along the trunk's own right (x), up (y), and anterior (z)
 * axes. Equivalent to R_trunk^T · v (see matrix utilities above), computed
 * directly via dot products for clarity and to avoid an unnecessary
 * intermediate matrix allocation on a per-frame hot path.
 */
function toLocalFrame(frame, worldVector) {
  return {
    x: dot(worldVector, frame.x),
    y: dot(worldVector, frame.y),
    z: dot(worldVector, frame.z),
  };
}

/** Remove the component of `vector` along `normalAxis`, returning the
 *  projection of `vector` onto the plane perpendicular to `normalAxis`. */
function projectOntoPlane(vector, normalAxis) {
  const unitNormal = normalize(normalAxis);
  const along = dot(vector, unitNormal);
  return {
    x: vector.x - along * unitNormal.x,
    y: vector.y - along * unitNormal.y,
    z: vector.z - along * unitNormal.z,
  };
}

const vec3 = { v3, add, scale, dot, cross, magnitude, normalize, midpoint, clamp, angleBetweenDeg };
const matrix3 = { matrixFromBasis, transpose, multiplyMatrixVector };

export { vec3, matrix3, buildTrunkFrame, toLocalFrame, projectOntoPlane };
