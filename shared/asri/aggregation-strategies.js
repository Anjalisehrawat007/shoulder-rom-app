/**
 * aggregation-strategies.js
 * ----------------------------------------------------------------------------
 * Each ASRI category aggregates its parameters across the 4 captured tasks
 * differently -- a flat "best value across tasks" rule (the old behavior)
 * doesn't make sense for every category. Each strategy is a pure function
 * operating on already-normalized (0-100) per-task scores, selected per
 * category by the `aggregation` field in config/asri-config.v2.json (a
 * string key, not a hard-coded if/else in the engine) -- see STRATEGIES
 * below for the registry.
 *
 * Every strategy returns { score, sourceTaskId, confidenceMultiplier } (or
 * a status object for the "insufficient data" case) so the caller can build
 * a full contribution trace without re-deriving provenance.
 * ----------------------------------------------------------------------------
 */

/**
 * @typedef {object} TaskParamEntry
 * @property {number|null} normalizedScore - 0-100, or null if not captured
 * @property {number} confidenceMultiplier - 0-1, from the confidenceWeights table
 * @property {string} taskId
 */

/** ROM: peak value achieved across tasks is the clinically meaningful summary. */
function bestAcrossTasks(entries) {
  const captured = entries.filter((e) => e.normalizedScore != null);
  if (captured.length === 0) return { score: null, sourceTaskId: null, confidenceMultiplier: 0 };
  const best = captured.reduce((a, b) => (b.normalizedScore > a.normalizedScore ? b : a));
  return { score: best.normalizedScore, sourceTaskId: best.taskId, confidenceMultiplier: best.confidenceMultiplier };
}

/** Movement Quality: consistency across tasks matters more than a single peak. */
function averageAcrossTasks(entries) {
  const captured = entries.filter((e) => e.normalizedScore != null);
  if (captured.length === 0) return { score: null, sourceTaskId: null, confidenceMultiplier: 0 };
  const score = captured.reduce((sum, e) => sum + e.normalizedScore, 0) / captured.length;
  const confidenceMultiplier = captured.reduce((sum, e) => sum + e.confidenceMultiplier, 0) / captured.length;
  return { score, sourceTaskId: captured.map((e) => e.taskId).join(","), confidenceMultiplier };
}

/** Compensation: a single task revealing poor compensation control is clinically
 *  important and should not be averaged away by three "clean" tasks. */
function worstAcrossTasks(entries) {
  const captured = entries.filter((e) => e.normalizedScore != null);
  if (captured.length === 0) return { score: null, sourceTaskId: null, confidenceMultiplier: 0 };
  const worst = captured.reduce((a, b) => (b.normalizedScore < a.normalizedScore ? b : a));
  return { score: worst.normalizedScore, sourceTaskId: worst.taskId, confidenceMultiplier: worst.confidenceMultiplier };
}

/** Functional Tasks: `entries` here are already per-task COMPOSITE scores
 *  (rom-threshold-met + smoothness + compensation-absence for that task,
 *  combined upstream in asri-engine.js), averaged across the 4 tasks --
 *  reflects whether the child can actually perform daily-living movements,
 *  not just isolated peak joint ROM. */
function taskCompositeAverage(entries) {
  return averageAcrossTasks(entries);
}

/** Symmetry: requires bilateral capture (testing both arms in one session).
 *  The current capture protocol only tests one side per session, so this
 *  always reports insufficient data rather than fabricating a number from
 *  unrelated proxies. Accepts `bilateralEntries` for forward compatibility
 *  once bilateral capture exists -- when absent/null, short-circuits. */
function bilateralComparison(bilateralEntries) {
  if (!bilateralEntries || !bilateralEntries.tested || !bilateralEntries.untested) {
    return {
      score: null,
      status: "insufficient_data",
      note: "Requires bilateral capture (testing both arms in one session); not supported by the current capture flow.",
    };
  }
  // Placeholder for when bilateral capture exists: symmetry score from the
  // ratio of tested-side to untested-side ROM, direction-agnostic.
  const ratio = Math.min(bilateralEntries.tested, bilateralEntries.untested) / Math.max(bilateralEntries.tested, bilateralEntries.untested);
  return { score: ratio * 100, status: "computed", confidenceMultiplier: 1 };
}

const STRATEGIES = {
  best_across_tasks: bestAcrossTasks,
  average_across_tasks: averageAcrossTasks,
  worst_across_tasks: worstAcrossTasks,
  task_composite_average: taskCompositeAverage,
  bilateral_comparison: bilateralComparison,
};

export { STRATEGIES, bestAcrossTasks, averageAcrossTasks, worstAcrossTasks, taskCompositeAverage, bilateralComparison };
