#!/usr/bin/env node
/**
 * verify-biomechanics.mjs
 * ----------------------------------------------------------------------------
 * Synthetic geometric consistency check for shared/biomechanics/*. Confirms:
 *
 *  1. Elevation/abduction/flexion read correctly at a known rest pose and at
 *     known 90deg abduction / 90deg flexion poses. (Hand-tracing this exact
 *     scenario during development caught two real bugs before this script
 *     was ever run: the elevation reference vector was inverted -- [0,1,0]
 *     instead of [0,-1,0], since MediaPipe's y increases downward -- and
 *     the flexion/abduction projections returned a spurious ~90deg instead
 *     of 0deg during a pure single-plane raise, because the angle between a
 *     near-zero-magnitude vector and anything is mathematically undefined.
 *     Both are fixed in angle-computation.js; see its comments and
 *     docs/biomechanics.md §3.)
 *
 *  2. The computed angles for a FIXED body-relative arm pose stay constant
 *     as the whole body is rotated relative to the camera/world frame --
 *     the concrete evidence for "independent of camera orientation" that
 *     the old |x| vs |z| camera-space heuristic did not have.
 *
 * NOT clinical validation: confirms the math is internally consistent, not
 * that it matches real human anatomy under real landmark noise. See
 * docs/biomechanics.md §9 and shared/validation/README.md.
 *
 * Run: node scripts/verify-biomechanics.mjs
 * ----------------------------------------------------------------------------
 */
import { buildTrunkFrame, vec3 } from "../shared/biomechanics/coordinate-frame.js";
import { computeShoulderAngles } from "../shared/biomechanics/angle-computation.js";

const { add, scale } = vec3;

let failures = 0;
function assertClose(label, actual, expected, tolerance = 0.5) {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tolerance;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ${expected}, got ${actual.toFixed(2)} (diff ${diff.toFixed(3)})`);
  if (!ok) failures++;
}

/** Rotate a point around the world Y axis by `thetaDeg` -- simulates the
 *  patient standing at a different angle relative to the camera. */
function rotateAroundY(p, thetaDeg) {
  const t = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { x: p.x * cos + p.z * sin, y: p.y, z: -p.x * sin + p.z * cos };
}

/** Base (untransformed) trunk landmarks: upright, facing the camera
 *  squarely, centered at the origin. */
function baseTrunk() {
  return {
    leftShoulder: { x: -0.1, y: 0, z: 0 },
    rightShoulder: { x: 0.1, y: 0, z: 0 },
    leftHip: { x: -0.1, y: 0.5, z: 0 },
    rightHip: { x: 0.1, y: 0.5, z: 0 },
  };
}

/**
 * Build a synthetic pose for the right arm at a given body-relative
 * abduction OR flexion angle (0deg = arm at rest, hanging down), then
 * rigidly rotate the whole body (trunk + arm) around the world Y axis by
 * `cameraAngleDeg` to simulate a different camera-facing angle. Because the
 * rotation is applied identically to every landmark, buildTrunkFrame()
 * reconstructs a frame that is just the base frame rotated the same way --
 * so if the math is truly camera-orientation-invariant, the angles computed
 * from the rotated landmarks should match the unrotated case exactly.
 */
function syntheticPose({ mode, angleDeg, cameraAngleDeg = 0 }) {
  const trunk = baseTrunk();
  const frame = buildTrunkFrame(trunk);
  const a = (angleDeg * Math.PI) / 180;

  // Local arm vector: 0deg = straight down (rest), sweeping toward +x
  // (lateral = abduction) or +z (anterior = flexion) as angle increases.
  const localArm =
    mode === "abduction"
      ? { x: Math.sin(a), y: -Math.cos(a), z: 0 }
      : { x: 0, y: -Math.cos(a), z: Math.sin(a) };

  const armOffset = add(add(scale(frame.x, localArm.x), scale(frame.y, localArm.y)), scale(frame.z, localArm.z));
  const elbowWorld = add(trunk.rightShoulder, scale(armOffset, 0.3));
  const wristWorld = add(elbowWorld, scale(frame.y, -0.25)); // forearm hangs from elbow; unused in assertions below

  const rotated = {
    leftShoulder: rotateAroundY(trunk.leftShoulder, cameraAngleDeg),
    rightShoulder: rotateAroundY(trunk.rightShoulder, cameraAngleDeg),
    leftHip: rotateAroundY(trunk.leftHip, cameraAngleDeg),
    rightHip: rotateAroundY(trunk.rightHip, cameraAngleDeg),
    elbow: rotateAroundY(elbowWorld, cameraAngleDeg),
    wrist: rotateAroundY(wristWorld, cameraAngleDeg),
  };

  const rotatedFrame = buildTrunkFrame(rotated);
  return computeShoulderAngles({
    shoulder: rotated.rightShoulder,
    elbow: rotated.elbow,
    wrist: rotated.wrist,
    frame: rotatedFrame,
  });
}

console.log("--- Rest position (0deg) ---");
{
  const angles = syntheticPose({ mode: "abduction", angleDeg: 0 });
  assertClose("elevation at rest", angles.shoulderElevationDeg.value, 0);
  assertClose("abduction at rest", angles.shoulderAbductionDeg.value, 0);
  assertClose("flexion at rest", angles.shoulderFlexionDeg.value, 0);
}

console.log("\n--- Pure 90deg abduction, facing camera squarely ---");
{
  const angles = syntheticPose({ mode: "abduction", angleDeg: 90 });
  assertClose("elevation", angles.shoulderElevationDeg.value, 90);
  assertClose("abduction", angles.shoulderAbductionDeg.value, 90);
  assertClose("flexion (regression check: was ~90 before the near-zero-magnitude fix)", angles.shoulderFlexionDeg.value, 0);
}

console.log("\n--- Pure 90deg flexion, facing camera squarely ---");
{
  const angles = syntheticPose({ mode: "flexion", angleDeg: 90 });
  assertClose("elevation", angles.shoulderElevationDeg.value, 90);
  assertClose("flexion", angles.shoulderFlexionDeg.value, 90);
  assertClose("abduction (should read ~0)", angles.shoulderAbductionDeg.value, 0);
}

console.log("\n--- Camera-orientation invariance: 90deg abduction at 3 camera angles ---");
for (const cameraAngleDeg of [0, 30, 60]) {
  const angles = syntheticPose({ mode: "abduction", angleDeg: 90, cameraAngleDeg });
  assertClose(`abduction @ camera angle ${cameraAngleDeg}deg`, angles.shoulderAbductionDeg.value, 90);
  assertClose(`flexion @ camera angle ${cameraAngleDeg}deg`, angles.shoulderFlexionDeg.value, 0);
}

console.log("\n--- Camera-orientation invariance: 90deg flexion at 3 camera angles ---");
for (const cameraAngleDeg of [0, 30, 60]) {
  const angles = syntheticPose({ mode: "flexion", angleDeg: 90, cameraAngleDeg });
  assertClose(`flexion @ camera angle ${cameraAngleDeg}deg`, angles.shoulderFlexionDeg.value, 90);
  assertClose(`abduction @ camera angle ${cameraAngleDeg}deg`, angles.shoulderAbductionDeg.value, 0);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
