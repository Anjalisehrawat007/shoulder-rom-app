# Biomechanical Engine — Mathematical Documentation

Covers `shared/biomechanics/*`: every formula, every assumption, and the
known limitations of estimating shoulder kinematics from a single RGB
camera via MediaPipe pose landmarks. Written for a reviewer validating this
system against clinical measurement, not as a code walkthrough.

## 1. Landmark set and joint-center approximation

Source: MediaPipe Pose Landmarker (BlazePose topology, 33 points), indices
used here: `L_SHOULDER=11, R_SHOULDER=12, L_ELBOW=13, R_ELBOW=14,
L_WRIST=15, R_WRIST=16, L_HIP=23, R_HIP=24`.

**Assumption**: the MediaPipe shoulder landmark approximates the
glenohumeral (GH) joint center. This is a simplification — the true GH
joint center is internal to the joint capsule and not directly visible on
the skin surface; MediaPipe's shoulder landmark sits closer to the
acromion. No correction is applied for this offset. This is a standard
simplification in markerless motion capture but is a source of systematic
error that scales with how far the true GH center sits from the visible
shoulder landmark (varies by body habitus).

**Assumption**: MediaPipe's `z` coordinate is a relative, weakly-scaled
monocular depth estimate produced by the model's learned depth prior, not
a calibrated measurement (no stereo baseline, no depth sensor, no known
camera intrinsics). Any computation using `z` inherits this weaker
reliability relative to `x`/`y`, which are grounded in actual pixel
positions. This is why every parameter below documents whether it depends
on `z` and is confidence-rated accordingly.

## 2. Trunk-fixed anatomical coordinate frame

**Why not raw camera axes.** The previous implementation compared
`|upperArm.x|` to `|upperArm.z|` directly in camera space to split one
angle into "abduction" and "flexion". Camera-space X/Z do not correspond
to any fixed direction on the patient's body — the split's output changes
systematically depending on how squarely the patient faces the camera,
which is not a property of their shoulder, it's a property of camera
placement. This is not a measurement.

**Construction.** From four landmarks (`leftShoulder, rightShoulder,
leftHip, rightHip`):

```
shoulderMid = midpoint(leftShoulder, rightShoulder)
hipMid      = midpoint(leftHip, rightHip)

Y = normalize(shoulderMid − hipMid)                    (trunk superior axis)
Z = normalize((rightShoulder − leftShoulder) × Y)        (trunk anterior axis)
X = normalize(Y × Z)                                     (trunk right axis)
```

`Y` is re-used directly as-is (the trunk's long axis). `Z` is built via a
cross product so it is exactly perpendicular to both the shoulder line and
`Y`. `X` is derived *last*, via a second cross product, specifically so the
final basis `{X, Y, Z}` is always exactly orthonormal — even when the raw
shoulder line isn't perfectly perpendicular to the spine, which it usually
isn't in practice (posture, camera angle, asymmetric OBPP presentation).
This is a standard Gram-Schmidt-style segment-frame construction.

**What this fixes, and what it doesn't.** Anchoring the frame in the
patient's own shoulder/hip geometry, rather than camera axes, removes the
systematic "faces-camera" bias described above — the frame rotates *with*
the patient, so a given arm position produces a consistent trunk-local
angle regardless of which way the patient is facing the camera. It does
**not** fix the underlying weakness of MediaPipe's `z` estimate — the
frame is only as good as the landmarks it's built from. See
`scripts/verify-biomechanics.js` for a synthetic check confirming
camera-orientation invariance under this construction (a geometric
consistency check, not a clinical validation).

**Expressing a world vector in trunk-local coordinates.** Because
`{X, Y, Z}` is orthonormal, the matrix `R = [X | Y | Z]` (as columns) is a
proper rotation matrix, and its inverse equals its transpose:

```
v_local = R^T · v_world
```

implemented as one dot product per output axis (`toLocalFrame()` in
`coordinate-frame.js`) — algebraically identical to the matrix-transpose
multiply, computed directly for clarity on a per-frame hot path.

## 3. Shoulder elevation, plane of elevation, abduction, flexion

Let `humerusLocal = toLocalFrame(frame, shoulder→elbow vector)`, and
`restDown = [0,-1,0]` — the trunk-local reference for "arm hanging
relaxed at the side". MediaPipe's normalized `y` increases *downward*, so
a relaxed arm's shoulder→elbow vector already points in `-y`; `restDown`,
not `[0,1,0]`, is the correct zero-reference (using `[0,1,0]` would
report 180° elevation for a relaxed arm and 0° for a fully raised one —
backwards).

```
elevationDeg         = angleBetween(humerusLocal, restDown)
planeOfElevationDeg   = atan2(humerusLocal.z, humerusLocal.x)
abductionDeg         = angleFromRestOrZero({humerusLocal.x, humerusLocal.y, 0}, restDown)
flexionDeg           = angleFromRestOrZero({0, humerusLocal.y, humerusLocal.z}, restDown)
```

`angleBetween(a, b) = acos(clamp(a·b / (|a||b|), −1, 1))`, in degrees.
`angleFromRestOrZero` returns `0` directly, without calling
`angleBetween`, whenever the projected vector's magnitude is below
`1e-3` — during a pure abduction raise, for instance, the sagittal-plane
projection can be a near-zero vector, and the angle between a near-zero
vector and anything is mathematically undefined; the naive formula
spuriously returns ~90° there instead of the correct 0°. This was caught
by hand-tracing the synthetic check in `scripts/verify-biomechanics.mjs`
before it was ever run — worth noting as the concrete reason that
script exists, not just a formality.

**Non-complementary limitation**: `abductionDeg` and `flexionDeg` are
plane *projections* of the same 3D elevation, not mutually exclusive
measurements that sum to the total. During scaption (elevation through an
intermediate plane, `planeOfElevationDeg` around 45°), both can read a
substantial nonzero value simultaneously — this is the correct behavior
of the projection definition, but it means `abductionDeg + flexionDeg`
must never be read as "total ROM" for a non-pure movement.
`elevationDeg` is the single unambiguous "how far has the arm risen"
quantity regardless of plane, and is what `capture/app.js` now uses to
pick the representative peak frame per task (previously it summed
abduction+flexion, which double-counts during scaption).

This follows the ISB convention of representing humeral elevation as a
**plane of elevation** (which anatomical plane the arm rises through) plus
an **elevation angle** (how far), which can correctly represent scaption
— an intermediate plane between pure abduction and pure flexion — a
clinically real movement the old ratio-split could not represent at all
(it forced every raise into a lossy split that always summed to the raw
angle). `abductionDeg` and `flexionDeg` are reported alongside this for
clinical familiarity, computed as genuine projections onto the frontal and
sagittal planes (dot product against the plane-projected vector), not a
magnitude-ratio heuristic.

**Confidence rationale**: `abductionDeg` depends only on `humerusLocal.x`
and `.y` — MediaPipe's most reliable dimensions, no depth estimate
involved — so it is rated `measured` / `high` confidence. `flexionDeg`,
`elevationDeg`, and `planeOfElevationDeg` all depend on `humerusLocal.z`,
inheriting the weaker reliability of MediaPipe's depth estimate — rated
`measured` / `moderate` (still a real geometric projection, not an
arbitrary constant, but less reliable than abduction).

## 4. Axial rotation (internal/external) — ESTIMATED, not measured

True humeral axial rotation is rotation of the humerus about its own long
axis. This is **not observable** from shoulder/elbow/wrist skin-surface
landmarks alone — there is no landmark on the medial/lateral epicondyles
or any other feature that would let the model distinguish "forearm
pronated with elbow at this angle" from "humerus internally rotated with
elbow at this angle" in general. What is computed is a **proxy**:

```
forearmPerp = projectOntoPlane(elbow→wrist vector, onto plane ⊥ shoulder→elbow vector)
forearmPerpLocal = toLocalFrame(frame, forearmPerp)
rotationDeg = angleBetween(normalize(forearmPerpLocal), [0,1,0])   // trunk's own "up"
externalRotation = rotationDeg if forearmPerpLocal.z < 0, else 0
internalRotation = rotationDeg if forearmPerpLocal.z >= 0, else 0
```

Removing the forearm's component along the humeral axis isolates the part
of forearm orientation attributable to rotation about that axis rather
than elbow flexion/extension — but this is only a valid proxy for humeral
rotation **near ~90° elbow flexion**, where forearm orientation actually
tracks humeral rotation. Away from that window, the number reflects
elbow/forearm geometry more than shoulder rotation. The capture protocol's
four tasks do not currently enforce this elbow angle.

The one correctness fix versus the previous implementation: the reference
"vertical" is now the **trunk's own superior axis** (`[0,1,0]` in
trunk-local coordinates) rather than raw camera-space "up" — the old
version assumed camera "up" equals gravity/anatomical "up", which breaks
if the recording device itself is held at an angle. This reduces, but does
not eliminate, camera-orientation sensitivity for this parameter, since
the forearm-rotation proxy itself remains fundamentally limited as
described above.

**Rating**: `estimated` / `low` confidence for both external and internal
rotation.

## 5. Scapular parameters

MediaPipe's 33-point model has **no scapula-specific landmarks** — no
acromion, no inferior angle, no medial border points. This is a hard
ceiling, not a solvable heuristic problem.

- **Upward rotation**: reported as `unavailable` (`value: null`). The
  previous implementation computed this as `abduction × 0.28` — a fixed
  linear rescaling of a number already computed for a *different* joint,
  not an independent observation of anything. It has been removed rather
  than replaced with a different fake formula, per the research-integrity
  requirement this system is built to.
- **Tilt**: `tiltDeg = shoulderLineDepthDiff × 150`, where
  `shoulderLineDepthDiff = |shoulder.z − otherShoulder.z|`. A coarse proxy
  from shoulder-line depth asymmetry — genuinely observable, if noisily,
  from skin-surface landmarks, and does not borrow another joint's value.
  Rated `estimated` / `low`.
- **Winging**: boolean flag, `shoulderLineDepthDiff > 0.06`. Same
  dependency and rating as tilt. A threshold heuristic, not a validated
  detector — intended to prompt clinician review of the captured still
  image, not stand alone as a measurement.

`shared/biomechanics/scapular-estimation.js` is intentionally isolated so
a future scapula-specific landmark or CV model can populate the same
`{value, measurementType, confidence, limitation}` schema without any
other module changing.

## 6. Compensation detection (trunk lean, trunk rotation)

Reuses the trunk frame's own `Y` axis rather than recomputing shoulder/hip
midpoints a second time:

```
lateralLeanDeg = angleBetween(frame.y, [0,-1,0])   // see sign-convention note below
trunkRotationDeg = shoulderLineDepthDiff × 200
```

**Sign-convention note**: MediaPipe's normalized image-space `y`
increases *downward*, so a vertical spine's world vector
(`shoulderMid − hipMid`) already points in the `−y` direction — `[0,-1,0]`
is therefore the correct "physically upright, no lean" reference,
consistent with how `frame.y` itself is constructed (§2).

`lateralLeanDeg` is rated `measured` / `moderate` — it's a direct
geometric angle, but conflates sideways lean and forward/backward lean
into one number rather than separating them, and partially depends on
`z`. `trunkRotationDeg` reuses the same `shoulderLineDepthDiff` heuristic
as scapular tilt and is rated `estimated` / `low` for the same reason
(depends on the weak `z` dimension).

## 7. Movement speed and smoothness

Relocated unchanged from the previous implementation (`motion-quality.js`)
— algorithm not revised in this phase; full-sequence angular
velocity/acceleration analysis (replacing single-signal wrist speed) is
planned for a later phase (see project spec §7).

- **Speed**: average wrist displacement per second across the buffered
  history, in normalized landmark-space units — **not** calibrated
  real-world velocity (no camera calibration, no known patient-to-camera
  distance). Rated `estimated` / `moderate`.
- **Smoothness**: a simplified velocity-sign-change heuristic (fewer sign
  changes → smoother, scaled 0–100), *not* the validated dimensionless-jerk
  formula from the movement-quality literature. Rated `estimated` / `low`.

## 8. Complete assumptions list

1. The trunk is treated as rigid between hip and shoulder landmarks within
   a single frame.
2. The GH joint center is approximated by the MediaPipe shoulder landmark
   (§1) — no joint-center regression is applied.
3. MediaPipe's `z` is an uncalibrated, relatively weak monocular depth
   estimate (§1); every parameter's confidence rating reflects its
   dependency on `z`.
4. No camera intrinsics/extrinsics calibration is performed — reported
   linear-motion quantities (§7) are in normalized landmark-space units,
   not physical units.
5. Axial rotation (§4) is only a valid proxy near ~90° elbow flexion; the
   current four-task protocol does not enforce this.
6. Scapular kinematics beyond coarse depth-asymmetry heuristics are not
   observable from this landmark set at all (§5).
7. A single time-point "peak frame" per task is currently used to
   represent that task's ROM (see `capture/app.js`), not a full-sequence
   analysis — planned for a later phase (spec §7).

## 9. What this phase does and does not establish

This document and the accompanying synthetic check
(`scripts/verify-biomechanics.js`) establish that the geometry is
**internally consistent** — that abduction and flexion are computed via
real anatomical-plane projections that behave correctly under simulated
camera-orientation changes, and that every parameter is honestly labeled
by what kind of claim it is (measured / estimated / unavailable).

This is **not** clinical validation. It does not establish that these
numbers agree with goniometry, Mallet score, or any other clinical
reference standard under real skin/clothing landmark noise, patient
movement, or camera-setup variation in practice. That comparison is the
explicit purpose of the planned Validation Engine (project spec §8,
`shared/validation/README.md`) and requires real paired clinician
measurements, not synthetic geometry.
