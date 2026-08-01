/**
 * tracking-stability.js — ICQA camera/tracking stability analysis
 * ----------------------------------------------------------------------------
 * `measured` via frame-to-frame displacement of the shoulder midpoint over a
 * brief history window -- a real, directly-computed signal (reuses `vec3`
 * from shared/biomechanics/coordinate-frame.js, the same vector-math layer
 * every other phase already depends on). During the pre-task gate the
 * subject is asked to hold still, so this doubles as a camera-shake
 * detector; it CANNOT distinguish "camera shook" from "child moved" -- both
 * produce identical shoulder-midpoint jitter. This is documented as a
 * limitation, not resolved (resolving it would require an independent
 * background-feature optical-flow signal, out of scope for this phase --
 * see docs/icqa.md future improvements).
 * ----------------------------------------------------------------------------
 */
import { makeParameter } from "../biomechanics/parameter-schema.js";
import { vec3 } from "../biomechanics/coordinate-frame.js";
import { LM_FULL } from "./landmark-groups.js";

function shoulderMidpoint(lm) {
  const l = lm[LM_FULL.L_SHOULDER];
  const r = lm[LM_FULL.R_SHOULDER];
  if (!l || !r) return null;
  return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, z: ((l.z ?? 0) + (r.z ?? 0)) / 2 };
}

function meanDisplacement(points) {
  if (points.length < 2) return null;
  let sumDisp = 0;
  for (let i = 1; i < points.length; i++) {
    sumDisp += vec3.magnitude(vec3.v3(points[i - 1], points[i]));
  }
  return sumDisp / (points.length - 1);
}

/** `history` is a short array of {t, lm} frames (lm may be null on a failed
 *  detection), most recent last. Needs at least 2 frames with a detected
 *  shoulder midpoint to compute anything.
 *
 *  Returns TWO distinct jitter signals, feeding two different ICQA
 *  subscores: `jitter` (over the full sample window -- feeds Tracking
 *  Stability, "has the camera/subject been steady during this check") and
 *  `recentJitter` (over only the last few frames -- feeds Movement
 *  Readiness, "is the subject still enough RIGHT NOW to start recording").
 *  A subject who was fidgeting a second ago but has just settled should
 *  score low on the former and high on the latter; that distinction is the
 *  point of computing both rather than one. */
function analyzeStability(history, recentWindow = 4) {
  const points = (history || []).map((f) => (f.lm ? shoulderMidpoint(f.lm) : null)).filter(Boolean);

  if (points.length < 2) {
    const unavailableJitter = makeParameter({ value: null, unit: "normalized_displacement", measurementType: "unavailable", limitation: "Fewer than 2 frames with a detected shoulder midpoint in the sample window." });
    return {
      jitter: unavailableJitter,
      recentJitter: unavailableJitter,
      detectionRate: makeParameter({ value: (history || []).length > 0 ? Math.round((points.length / history.length) * 1000) / 1000 : null, unit: "fraction", measurementType: history?.length ? "measured" : "unavailable", limitation: history?.length ? "" : "No frames sampled yet." }),
    };
  }

  const meanDisp = meanDisplacement(points);
  const recentPoints = points.slice(-recentWindow);
  const recentDisp = meanDisplacement(recentPoints) ?? meanDisp;

  return {
    jitter: makeParameter({
      value: Math.round(meanDisp * 10000) / 10000, unit: "normalized_displacement", measurementType: "measured", confidence: "moderate",
      limitation: "Mean frame-to-frame shoulder-midpoint displacement over the full sample window; cannot distinguish camera shake from the subject moving during the stillness sample.",
    }),
    recentJitter: makeParameter({
      value: Math.round(recentDisp * 10000) / 10000, unit: "normalized_displacement", measurementType: "measured", confidence: "moderate",
      limitation: "Same displacement measure as `jitter`, restricted to only the most recent frames -- a narrower, more volatile signal intended to answer 'is the subject still right now,' not 'has this check been stable overall.'",
    }),
    detectionRate: makeParameter({ value: Math.round((points.length / history.length) * 1000) / 1000, unit: "fraction", measurementType: "measured", confidence: "high" }),
  };
}

export { analyzeStability, shoulderMidpoint };
