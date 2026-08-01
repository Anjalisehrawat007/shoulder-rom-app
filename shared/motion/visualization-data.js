/**
 * visualization-data.js — Part 7: Movement Visualization (data only)
 * ----------------------------------------------------------------------------
 * Pure data packaging for a future dashboard/replay UI -- no charting, no
 * rendering, no styling. Takes a DMQE result (shared/motion/dmqe-engine.js's
 * `runDmqe` output) and repackages its already-computed curves into a
 * stable, documented shape a future charting layer can consume directly.
 * Nothing here recomputes anything; it only reshapes existing data.
 * ----------------------------------------------------------------------------
 */

/**
 * @param {ReturnType<import("./dmqe-engine.js").runDmqe>} dmqeResult
 * @returns {object|null} null if the underlying DMQE run didn't produce a
 *   valid segmentation (e.g. no movement detected) -- nothing to visualize.
 */
function buildVisualizationData(dmqeResult) {
  if (dmqeResult.status !== "ok" || !dmqeResult.trajectory) return null;
  const t = dmqeResult.trajectory;

  return {
    jointAngleTimeline: t.elevationCurve.value, // [{t, value}]
    velocityGraph: t.velocityCurve.value,
    accelerationGraph: t.accelerationCurve.value,
    jerkGraph: t.jerkCurve.value,
    romTimeline: t.elevationCurve.value, // alias: for this protocol, elevation angle IS the ROM signal
    trajectoryPlot: {
      // Wrist position isn't re-exported here (already implicit in the source
      // frames); a future replay UI reads the same filtered frame sequence
      // directly rather than duplicating raw landmark data through this module.
      trajectoryLength: t.trajectoryLength.value,
      pathEfficiency: t.pathEfficiency.value,
    },
    compensationTimeline: t.compensationTimeline.value, // [{t, lateralLeanDeg, trunkRotationDeg, flag}]
    dmqeTimeline: {
      dmqeScore: dmqeResult.dmqeScore,
      movementConfidencePct: dmqeResult.movementConfidencePct,
      phases: dmqeResult.segmentation,
    },
    movementReplay: {
      // Frame indices marking each segmentation phase boundary -- a replay UI
      // can scrub the original video/skeleton overlay using these, without
      // this module needing to store video/landmark data itself.
      phases: dmqeResult.segmentation,
    },
  };
}

export { buildVisualizationData };
