/**
 * pose-engine.js
 * ----------------------------------------------------------------------------
 * Wraps MediaPipe Tasks Vision PoseLandmarker to turn video frames into the
 * kinematic parameters this thesis tracks.
 *
 * IMPORTANT SCIENTIFIC / CLINICAL LIMITATION (documented deliberately, see
 * README.md "Accuracy & validation" section):
 *   A single RGB smartphone/webcam camera estimates 3D landmark positions
 *   monocularly. This is NOT equivalent to marker-based multi-camera motion
 *   capture (e.g. Vicon) and angles reported here are best treated as
 *   RESEARCH-GRADE ESTIMATES requiring validation against your thesis's
 *   reference standard before any clinical claim is made. Scapular winging,
 *   tilt and upward rotation in particular are only partially observable
 *   through skin/clothing landmarks in monocular RGB video, so this engine
 *   reports them as a heuristic PROXY plus flags them for clinician
 *   confirmation on the captured still image rather than presenting them as
 *   fully automated measurements.
 * ----------------------------------------------------------------------------
 */

const LM = {
  NOSE: 0, MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
};

function v3(a, b) {
  return { x: b.x - a.x, y: b.y - a.y, z: (b.z ?? 0) - (a.z ?? 0) };
}
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function mag(a) { return Math.sqrt(dot(a, a)) || 1e-9; }
function angleBetween(a, b) {
  const c = Math.min(1, Math.max(-1, dot(a, b) / (mag(a) * mag(b))));
  return (Math.acos(c) * 180) / Math.PI;
}

class PoseEngine {
  constructor() {
    this.landmarker = null;
    this.ready = false;
    this._history = []; // {t, landmarks} for velocity/smoothness
  }

  async init() {
    const vision = await window.MediapipeTasksVision.FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    this.landmarker = await window.MediapipeTasksVision.PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    this.ready = true;
  }

  /** Run detection on a single video frame. Returns raw landmarks or null. */
  detect(videoEl, timestampMs) {
    if (!this.ready) return null;
    const result = this.landmarker.detectForVideo(videoEl, timestampMs);
    if (!result.landmarks || result.landmarks.length === 0) return null;
    const lm = result.landmarks[0];
    this._history.push({ t: timestampMs, lm });
    if (this._history.length > 60) this._history.shift();
    return lm;
  }

  /** Compute the full parameter set for the current frame, given which side is being tested. */
  computeParameters(lm, side = "right") {
    const isRight = side === "right";
    const shoulder = lm[isRight ? LM.R_SHOULDER : LM.L_SHOULDER];
    const otherShoulder = lm[isRight ? LM.L_SHOULDER : LM.R_SHOULDER];
    const elbow = lm[isRight ? LM.R_ELBOW : LM.L_ELBOW];
    const wrist = lm[isRight ? LM.R_WRIST : LM.L_WRIST];
    const hip = lm[isRight ? LM.R_HIP : LM.L_HIP];
    const otherHip = lm[isRight ? LM.L_HIP : LM.R_HIP];

    // Trunk vertical reference: hip -> shoulder (same side), used as the long axis of the torso.
    const trunkAxis = v3(hip, shoulder);
    const upperArm = v3(shoulder, elbow);
    const forearm = v3(elbow, wrist);

    // Abduction/flexion are both "angle of humerus away from trunk axis"; we split them using
    // the sign/dominance of the lateral (x) vs anterior (z) component in camera space.
    const rawAngle = angleBetween(trunkAxis, upperArm);
    const lateralComponent = Math.abs(upperArm.x);
    const anteriorComponent = Math.abs(upperArm.z);
    const total = lateralComponent + anteriorComponent || 1e-9;
    const abduction = rawAngle * (lateralComponent / total);
    const flexion = rawAngle * (anteriorComponent / total);

    // Rotation proxy: angle of the forearm around the humeral long-axis relative to a
    // gravity-vertical reference plane. Reliable mainly near ~90 deg elbow flexion (thesis
    // protocol tasks are chosen so this holds during "comb hair" / "reach head").
    const humeralAxis = upperArm;
    const forearmProj = {
      x: forearm.x - (dot(forearm, humeralAxis) / dot(humeralAxis, humeralAxis)) * humeralAxis.x,
      y: forearm.y - (dot(forearm, humeralAxis) / dot(humeralAxis, humeralAxis)) * humeralAxis.y,
      z: forearm.z - (dot(forearm, humeralAxis) / dot(humeralAxis, humeralAxis)) * humeralAxis.z,
    };
    const verticalRef = { x: 0, y: 1, z: 0 };
    const rotationAngle = angleBetween(forearmProj, verticalRef);
    const externalRotation = forearmProj.z < 0 ? rotationAngle : 0;
    const internalRotation = forearmProj.z >= 0 ? rotationAngle : 0;

    // Trunk compensation: lateral lean (shoulder midline vs hip midline tilt from vertical)
    // and trunk rotation proxy (difference in relative depth of the two shoulders).
    const shoulderMid = { x: (shoulder.x + otherShoulder.x) / 2, y: (shoulder.y + otherShoulder.y) / 2, z: (shoulder.z + otherShoulder.z) / 2 };
    const hipMid = { x: (hip.x + otherHip.x) / 2, y: (hip.y + otherHip.y) / 2, z: (hip.z + otherHip.z) / 2 };
    const spineAxis = v3(hipMid, shoulderMid);
    const lateralLean = angleBetween(spineAxis, { x: 0, y: -1, z: 0 });
    const shoulderLineDepthDiff = Math.abs(shoulder.z - otherShoulder.z);
    const trunkRotationProxy = shoulderLineDepthDiff * 200; // scaled heuristic, degrees-ish

    // Scapular parameters: monocular RGB proxy only -- flagged for clinician confirmation.
    const scapular = {
      upwardRotationProxy: Math.round(abduction * 0.28 * 10) / 10, // heuristic coupling to abduction
      tiltProxy: Math.round(shoulderLineDepthDiff * 150 * 10) / 10,
      wingingFlag: shoulderLineDepthDiff > 0.06, // asymmetric shoulder depth may indicate winging; needs photo review
      requiresClinicianConfirmation: true,
    };

    return {
      shoulderAbductionDeg: round1(abduction),
      shoulderFlexionDeg: round1(flexion),
      externalRotationDeg: round1(externalRotation),
      internalRotationDeg: round1(internalRotation),
      scapularUpwardRotationDeg_proxy: scapular.upwardRotationProxy,
      scapularTiltDeg_proxy: scapular.tiltProxy,
      scapularWingingFlag_proxy: scapular.wingingFlag,
      scapularRequiresClinicianConfirmation: scapular.requiresClinicianConfirmation,
      trunkLateralLeanDeg: round1(lateralLean),
      trunkRotationProxyDeg: round1(trunkRotationProxy),
      trunkCompensationFlag: lateralLean > 15 || trunkRotationProxy > 15,
    };
  }

  /** Speed & smoothness of the wrist trajectory over the buffered history. */
  computeMotionQuality(side = "right") {
    const isRight = side === "right";
    const idx = isRight ? LM.R_WRIST : LM.L_WRIST;
    const pts = this._history.map((h) => ({ t: h.t, p: h.lm[idx] })).filter((x) => x.p);
    if (pts.length < 4) return { speed: null, smoothness: null, sampleCount: pts.length };

    const velocities = [];
    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i].t - pts[i - 1].t) / 1000;
      if (dt <= 0) continue;
      const d = v3(pts[i - 1].p, pts[i].p);
      const dist = mag(d);
      velocities.push(dist / dt);
    }
    const avgSpeed = velocities.reduce((a, b) => a + b, 0) / (velocities.length || 1);

    // Simplified normalized-jerk-like smoothness metric: fewer velocity sign changes /
    // lower variance in speed => smoother. Scaled to a 0-100 "smoothness score" where
    // 100 = perfectly monotonic single bell-shaped velocity profile.
    let signChanges = 0;
    for (let i = 1; i < velocities.length; i++) {
      if (Math.sign(velocities[i] - velocities[i - 1]) !== Math.sign(velocities[i - 1] - (velocities[i - 2] ?? velocities[i - 1]))) {
        signChanges++;
      }
    }
    const smoothness = Math.max(0, 100 - signChanges * 8);

    return {
      speed: Math.round(avgSpeed * 1000) / 1000, // normalized units/sec (landmark space)
      smoothness,
      sampleCount: pts.length,
    };
  }
}

function round1(n) { return Math.round(n * 10) / 10; }

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PoseEngine, LM };
} else {
  window.PoseEngine = PoseEngine;
}
