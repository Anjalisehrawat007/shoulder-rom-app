/**
 * compensation-detection.js — Compensation Detection
 * ----------------------------------------------------------------------------
 * Trunk lean and trunk rotation, used to flag whole-body compensation
 * strategies (e.g. leaning or rotating the torso to fake shoulder ROM)
 * rather than genuine glenohumeral motion. Expressed via the same
 * trunk-frame formalism as angle-computation.js for consistency: the
 * frame's own superior axis (`frame.y`) is reused directly rather than
 * recomputing the shoulder/hip midpoints a second time.
 * ----------------------------------------------------------------------------
 */
import { vec3 } from "./coordinate-frame.js";
import { makeParameter } from "./parameter-schema.js";

const { angleBetweenDeg } = vec3;

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * @param {object} args
 * @param {object} args.frame - trunk frame from buildTrunkFrame()
 * @param {object} args.shoulder - landmark on the tested side
 * @param {object} args.otherShoulder - landmark on the untested side
 */
function detectCompensation({ frame, shoulder, otherShoulder }) {
  // "Physically upright" reference: MediaPipe's normalized image-space y
  // increases downward, so a vertical spine's world vector already points
  // in the -y direction — {0,-1,0} is the correct "no lean" reference here,
  // matching the sign convention frame.y was built with.
  const lateralLeanDeg = angleBetweenDeg(frame.y, { x: 0, y: -1, z: 0 });
  const shoulderLineDepthDiff = Math.abs((shoulder.z ?? 0) - (otherShoulder.z ?? 0));
  const trunkRotationDeg = shoulderLineDepthDiff * 200; // scaled heuristic, degrees-ish

  return {
    trunkLateralLeanDeg: makeParameter({
      value: round1(lateralLeanDeg),
      unit: "deg",
      measurementType: "measured",
      confidence: "moderate",
      limitation:
        "Angle between the full 3D trunk axis and vertical; conflates sideways lean and forward/backward " +
        "lean into a single number rather than separating them, and partially depends on the z component.",
    }),
    trunkRotationDeg: makeParameter({
      value: round1(trunkRotationDeg),
      unit: "deg",
      measurementType: "estimated",
      confidence: "low",
      limitation:
        "Heuristic proxy from shoulder-line depth asymmetry, dependent on MediaPipe's weak monocular depth " +
        "estimate. Not a validated trunk-rotation measurement.",
    }),
    trunkCompensationFlag: lateralLeanDeg > 15 || trunkRotationDeg > 15,
  };
}

export { detectCompensation };
