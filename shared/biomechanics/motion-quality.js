/**
 * motion-quality.js
 * ----------------------------------------------------------------------------
 * Wrist-trajectory speed and smoothness over a buffered landmark history.
 * Relocated from the old PoseEngine class method with the same algorithm —
 * this file only changes where the logic lives (pure function, no MediaPipe
 * dependency, no class state) and how its output is labeled, not the math
 * itself. Full-sequence analysis (max/avg ROM, angular velocity,
 * acceleration across the entire motion, not just wrist-position speed) is
 * planned for a later phase (spec §7) — this module keeps the current
 * single-signal speed/smoothness estimate in the interim.
 * ----------------------------------------------------------------------------
 */
import { vec3 } from "./coordinate-frame.js";
import { makeParameter } from "./parameter-schema.js";

const { v3, magnitude } = vec3;

/**
 * @param {object} args
 * @param {Array<{t: number, lm: object[]}>} args.history - buffered frames
 * @param {number} args.wristIndex - MediaPipe landmark index for the tested wrist
 */
function computeMotionQuality({ history, wristIndex }) {
  const pts = history.map((h) => ({ t: h.t, p: h.lm[wristIndex] })).filter((x) => x.p);
  if (pts.length < 4) {
    return {
      movementSpeed: makeParameter({
        value: null,
        unit: "landmark-units/s",
        measurementType: "unavailable",
        limitation: "Fewer than 4 samples buffered for this task window.",
      }),
      movementSmoothness: makeParameter({
        value: null,
        unit: "score(0-100)",
        measurementType: "unavailable",
        limitation: "Fewer than 4 samples buffered for this task window.",
      }),
      sampleCount: pts.length,
    };
  }

  const velocities = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const dist = magnitude(v3(pts[i - 1].p, pts[i].p));
    velocities.push(dist / dt);
  }
  const avgSpeed = velocities.reduce((a, b) => a + b, 0) / (velocities.length || 1);

  // Simplified normalized-jerk-like smoothness metric: fewer velocity sign
  // changes / lower variance in speed => smoother. This is an approximation
  // of true jerk-based smoothness (not the validated dimensionless jerk
  // formula from the movement-quality literature), scaled to a 0-100 score
  // where 100 = a single monotonic bell-shaped velocity profile.
  let signChanges = 0;
  for (let i = 1; i < velocities.length; i++) {
    if (Math.sign(velocities[i] - velocities[i - 1]) !== Math.sign(velocities[i - 1] - (velocities[i - 2] ?? velocities[i - 1]))) {
      signChanges++;
    }
  }
  const smoothness = Math.max(0, 100 - signChanges * 8);

  return {
    movementSpeed: makeParameter({
      value: Math.round(avgSpeed * 1000) / 1000,
      unit: "landmark-units/s",
      measurementType: "estimated",
      confidence: "moderate",
      limitation:
        "Normalized landmark-space units per second, not calibrated real-world velocity (m/s) -- no camera " +
        "calibration or known patient-to-camera distance is available to convert units.",
    }),
    movementSmoothness: makeParameter({
      value: Math.round(smoothness),
      unit: "score(0-100)",
      measurementType: "estimated",
      confidence: "low",
      limitation:
        "Simplified velocity-sign-change heuristic, not the validated dimensionless-jerk smoothness formula " +
        "from the movement-quality literature. Planned for replacement in the full-sequence pipeline (spec §7).",
    }),
    sampleCount: pts.length,
  };
}

export { computeMotionQuality };
