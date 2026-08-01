/**
 * normalize-parameter.js
 * ----------------------------------------------------------------------------
 * Raw biomechanical value -> 0-100 domain score, direction-aware. Replaces
 * the ad-hoc per-parameter formulas that used to live inline in
 * capture/app.js's buildDomainScores() (scoreFromAngle, "100 - x*2", etc).
 * The reference target/threshold a parameter is normalized against comes
 * from the resolved reference dataset (shared/asri/reference-datasets.js),
 * never a hard-coded constant here.
 *
 * Three directions, declared per-parameter in config/asri-config.v2.json:
 *   "higher_is_better" -- ROM angles: 0 at rawValue=0, 100 at rawValue>=target
 *   "lower_is_better"  -- compensation/tilt: 100 at rawValue=0, 0 at rawValue>=target
 *   "boolean_flag"     -- winging: a fixed trueScore/falseScore pair
 * ----------------------------------------------------------------------------
 */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * @param {object} args
 * @param {number|boolean|null} args.rawValue
 * @param {"higher_is_better"|"lower_is_better"|"boolean_flag"} args.direction
 * @param {number} [args.target] - required for higher_is_better/lower_is_better
 * @param {number} [args.trueScore] - required for boolean_flag
 * @param {number} [args.falseScore] - required for boolean_flag
 * @returns {number|null} 0-100, or null if rawValue is null (unavailable/not captured)
 */
function normalizeParameter({ rawValue, direction, target, trueScore, falseScore }) {
  if (rawValue == null) return null;

  switch (direction) {
    case "higher_is_better":
      return clamp((rawValue / target) * 100, 0, 100);
    case "lower_is_better":
      return clamp(100 - (rawValue / target) * 100, 0, 100);
    case "boolean_flag":
      return rawValue ? trueScore : falseScore;
    default:
      throw new Error(`normalizeParameter: unknown direction "${direction}"`);
  }
}

export { normalizeParameter };
