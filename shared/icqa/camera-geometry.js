/**
 * camera-geometry.js — ICQA camera position analysis
 * ----------------------------------------------------------------------------
 * Answers: is the camera tilted/rolled, is the subject too close/far, and is
 * the camera at a reasonable height relative to the subject? None of these
 * are directly observable from a single RGB stream without a depth sensor,
 * so every result here is explicitly `measured` (real sensor data),
 * `estimated` (a documented proxy), or `unavailable` -- same envelope as
 * shared/biomechanics/parameter-schema.js, reused directly since this is the
 * project's one shared foundational layer every phase is allowed to depend
 * on (Phase 1, not Phase 2/3/4).
 *
 * TILT/ROLL: `measured` via the browser's DeviceOrientationEvent (device
 * accelerometer/gyroscope) when available and permission-granted -- a real
 * physical sensor reading, not a pose inference. Falls back to `estimated`
 * using the shoulder line's angle against the image's horizontal axis (roll
 * proxy) and the trunk midline's angle against the image's vertical axis
 * (tilt proxy) -- valid only under the documented assumption that the
 * subject is standing reasonably upright, since the proxy cannot distinguish
 * "camera is level and the child is leaning" from "child is upright and the
 * camera is tilted."
 *
 * DISTANCE: no depth sensor exists in this pipeline, so a real distance in
 * cm is `unavailable`. `estimated` via the fraction of frame height/width
 * the detected body's bounding box occupies -- a standard, simple monocular
 * framing heuristic, not a fabricated measurement.
 *
 * HEIGHT/CAMERA-ANGLE PROXY: `estimated` via the ratio of shoulder-to-hip vs.
 * hip-to-ankle vertical landmark span, compared against a generic
 * shoulder/trunk-to-leg proportion drawn from standard adult anthropometric
 * segment tables (Winter, D.A., "Biomechanics and Motor Control of Human
 * Movement", segment length ratios) as a coarse reference -- explicitly NOT
 * derived from pediatric-specific anthropometry, which this reference does
 * not have. A camera looking down or up compresses one segment relative to
 * the other via perspective foreshortening; this proxy flags large
 * deviations from the expected ratio as a likely non-level camera height,
 * not a precise angle.
 * ----------------------------------------------------------------------------
 */
import { makeParameter } from "../biomechanics/parameter-schema.js";
import { vec3 } from "../biomechanics/coordinate-frame.js";
import { LM_FULL, ALL_INDICES } from "./landmark-groups.js";

const RAD2DEG = 180 / Math.PI;

/** Expected shoulder-hip / hip-ankle vertical-span ratio for an upright
 *  adult standing frontally to the camera (Winter's segment tables, coarse
 *  reference only -- see file header). Documented as a generic default, not
 *  a pediatric norm. */
const EXPECTED_TRUNK_TO_LEG_RATIO = 0.62;

function visibleLandmark(lm, idx, minVisibility) {
  const p = lm[idx];
  if (!p) return null;
  const vis = p.visibility ?? 1;
  return vis >= minVisibility ? p : null;
}

/** Bounding box (normalized 0-1 image coordinates) over whichever of the 33
 *  landmarks are currently visible enough to trust. Returns null if too few
 *  points are visible to form a meaningful box. */
function boundingBox(lm, minVisibility) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0;
  for (const idx of ALL_INDICES) {
    const p = visibleLandmark(lm, idx, minVisibility);
    if (!p) continue;
    count++;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (count < 4) return null;
  return { minX, maxX, minY, maxY, widthFrac: maxX - minX, heightFrac: maxY - minY, count };
}

/** Roll/tilt from the device's own orientation sensor, when available.
 *  `deviceOrientation` is the raw {alpha, beta, gamma} from a
 *  DeviceOrientationEvent (beta = front-back tilt, gamma = left-right tilt,
 *  both in degrees) -- see MDN DeviceOrientationEvent for the axis
 *  convention. */
function sensorTiltRoll(deviceOrientation) {
  if (!deviceOrientation || deviceOrientation.beta == null || deviceOrientation.gamma == null) return null;
  return { tiltDeg: deviceOrientation.beta, rollDeg: deviceOrientation.gamma };
}

/** Pose-based roll/tilt proxy -- see file header for the standing-upright
 *  assumption this depends on. */
function poseTiltRollProxy(lm, minVisibility) {
  const lS = visibleLandmark(lm, LM_FULL.L_SHOULDER, minVisibility);
  const rS = visibleLandmark(lm, LM_FULL.R_SHOULDER, minVisibility);
  const lH = visibleLandmark(lm, LM_FULL.L_HIP, minVisibility);
  const rH = visibleLandmark(lm, LM_FULL.R_HIP, minVisibility);
  if (!lS || !rS || !lH || !rH) return null;

  // Roll proxy: angle of the shoulder line off horizontal. In MediaPipe's
  // image coordinates x increases right, y increases down, so a perfectly
  // level shoulder line has dy=0.
  const rollDeg = Math.atan2(rS.y - lS.y, rS.x - lS.x) * RAD2DEG;

  // Tilt proxy: angle of the shoulder-mid -> hip-mid line off vertical.
  const shoulderMid = { x: (lS.x + rS.x) / 2, y: (lS.y + rS.y) / 2 };
  const hipMid = { x: (lH.x + rH.x) / 2, y: (lH.y + rH.y) / 2 };
  const dx = hipMid.x - shoulderMid.x;
  const dy = hipMid.y - shoulderMid.y;
  const tiltDeg = Math.atan2(dx, dy) * RAD2DEG; // 0 when perfectly vertical

  return { tiltDeg, rollDeg };
}

function analyzeCameraGeometry({ landmarks, deviceOrientation = null, config }) {
  const cfg = config.cameraGeometry;
  const minVisibility = cfg.minLandmarkVisibility;

  // --- tilt / roll -----------------------------------------------------------
  let tilt, roll;
  const sensor = sensorTiltRoll(deviceOrientation);
  if (sensor) {
    tilt = makeParameter({ value: Math.round(sensor.tiltDeg * 10) / 10, unit: "deg", measurementType: "measured", confidence: "high" });
    roll = makeParameter({ value: Math.round(sensor.rollDeg * 10) / 10, unit: "deg", measurementType: "measured", confidence: "high" });
  } else {
    const proxy = landmarks ? poseTiltRollProxy(landmarks, minVisibility) : null;
    if (proxy) {
      tilt = makeParameter({
        value: Math.round(proxy.tiltDeg * 10) / 10, unit: "deg", measurementType: "estimated", confidence: "moderate",
        limitation: "No device-orientation sensor available; inferred from the trunk midline's angle against vertical, which assumes the subject is standing upright -- a leaning child would look identical to a tilted camera.",
      });
      roll = makeParameter({
        value: Math.round(proxy.rollDeg * 10) / 10, unit: "deg", measurementType: "estimated", confidence: "moderate",
        limitation: "No device-orientation sensor available; inferred from the shoulder line's angle against horizontal, which assumes level shoulders -- shoulder asymmetry from the OBPP side itself could bias this proxy.",
      });
    } else {
      tilt = makeParameter({ value: null, unit: "deg", measurementType: "unavailable", limitation: "No device-orientation sensor and no visible shoulder/hip landmarks to form a pose-based proxy." });
      roll = makeParameter({ value: null, unit: "deg", measurementType: "unavailable", limitation: "No device-orientation sensor and no visible shoulder landmarks to form a pose-based proxy." });
    }
  }

  // --- distance / framing -----------------------------------------------------
  const bbox = landmarks ? boundingBox(landmarks, minVisibility) : null;
  let distanceCategory, framing;
  if (bbox) {
    const h = bbox.heightFrac;
    const cat = h > cfg.distance.tooCloseMinHeightFrac ? "too_close" : h < cfg.distance.tooFarMaxHeightFrac ? "too_far" : "ideal";
    distanceCategory = makeParameter({
      value: cat, unit: "category", measurementType: "estimated", confidence: "moderate",
      limitation: "No depth sensor; distance is inferred only from what fraction of the frame the detected body occupies, not a true physical distance.",
    });
    const centerX = (bbox.minX + bbox.maxX) / 2;
    framing = {
      centeredness: makeParameter({ value: Math.round((1 - Math.abs(centerX - 0.5) * 2) * 100) / 100, unit: "0-1", measurementType: "estimated", confidence: "moderate", limitation: "Horizontal centering only; assumes the visible bounding box represents the whole subject." }),
      touchesTopEdge: bbox.minY < cfg.distance.edgeMarginFrac,
      touchesBottomEdge: bbox.maxY > 1 - cfg.distance.edgeMarginFrac,
      touchesLeftEdge: bbox.minX < cfg.distance.edgeMarginFrac,
      touchesRightEdge: bbox.maxX > 1 - cfg.distance.edgeMarginFrac,
    };
  } else {
    distanceCategory = makeParameter({ value: null, unit: "category", measurementType: "unavailable", limitation: "Too few visible landmarks to form a bounding box." });
    framing = { centeredness: makeParameter({ value: null, unit: "0-1", measurementType: "unavailable", limitation: "Too few visible landmarks to form a bounding box." }), touchesTopEdge: null, touchesBottomEdge: null, touchesLeftEdge: null, touchesRightEdge: null };
  }

  // --- height / camera-angle proxy -------------------------------------------
  let heightAngleProxy;
  const lS = landmarks ? visibleLandmark(landmarks, LM_FULL.L_SHOULDER, minVisibility) : null;
  const rS = landmarks ? visibleLandmark(landmarks, LM_FULL.R_SHOULDER, minVisibility) : null;
  const lH = landmarks ? visibleLandmark(landmarks, LM_FULL.L_HIP, minVisibility) : null;
  const rH = landmarks ? visibleLandmark(landmarks, LM_FULL.R_HIP, minVisibility) : null;
  const lA = landmarks ? visibleLandmark(landmarks, LM_FULL.L_ANKLE, minVisibility) : null;
  const rA = landmarks ? visibleLandmark(landmarks, LM_FULL.R_ANKLE, minVisibility) : null;
  if (lS && rS && lH && rH && lA && rA) {
    const shoulderY = (lS.y + rS.y) / 2;
    const hipY = (lH.y + rH.y) / 2;
    const ankleY = (lA.y + rA.y) / 2;
    const trunkSpan = Math.abs(hipY - shoulderY);
    const legSpan = Math.abs(ankleY - hipY);
    const ratio = legSpan > 1e-6 ? trunkSpan / legSpan : null;
    if (ratio != null) {
      const deviation = Math.abs(ratio - EXPECTED_TRUNK_TO_LEG_RATIO) / EXPECTED_TRUNK_TO_LEG_RATIO;
      heightAngleProxy = makeParameter({
        value: Math.round(deviation * 1000) / 1000, unit: "relative_deviation", measurementType: "estimated", confidence: "low",
        limitation: "Proxy for camera height/angle via perspective-foreshortening of the trunk-to-leg segment ratio, referenced against a generic adult anthropometric ratio (Winter's tables) -- not pediatric-specific, and confounded by the child's own limb proportions.",
      });
    } else {
      heightAngleProxy = makeParameter({ value: null, unit: "relative_deviation", measurementType: "unavailable", limitation: "Hip and ankle landmarks coincide in the image; cannot form a leg-span ratio." });
    }
  } else {
    heightAngleProxy = makeParameter({ value: null, unit: "relative_deviation", measurementType: "unavailable", limitation: "Ankles not visible (feet likely out of frame) -- this proxy requires the full body, shoulder to ankle." });
  }

  return { tilt, roll, distanceCategory, framing, heightAngleProxy, bbox };
}

export { analyzeCameraGeometry, boundingBox, visibleLandmark };
