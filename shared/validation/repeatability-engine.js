/**
 * repeatability-engine.js — Phase 10: Repeatability Analysis
 * ----------------------------------------------------------------------------
 * Distinct from reliability-engine.js's testRetestReliability(): that
 * function answers "how consistent is the RANKING/relative agreement
 * between two occasions" (ICC). This file answers the complementary
 * measurement-science question "how big an absolute difference should we
 * expect between two repeat measurements of the same true value" (SD,
 * coefficient of variation, repeatability coefficient) -- the two are
 * usually reported together in a real repeatability study, but they are
 * mathematically different questions (a measure can have high ICC and a
 * wide repeatability coefficient at the same time, if the population
 * spans a wide range).
 *
 * REPEATABILITY COEFFICIENT DERIVATION (Bland & Altman 1996, BMJ 313:106;
 * British Standards Institution BS 5497): for n subjects each with exactly
 * two repeat measurements x1, x2, and d = x1 - x2:
 *   Var(d) = Var(x1) + Var(x2) - 2*Cov(x1,x2) = 2 * s_w^2   (equal-variance,
 *     no-correlation-shift assumption for a true repeat measurement)
 *   => s_w (within-subject SD) = SD(d) / sqrt(2)
 *   => RC = 1.96 * sqrt(2) * s_w = 1.96 * sqrt(2) * SD(d)/sqrt(2) = 1.96 * SD(d)
 * So the repeatability coefficient reduces to 1.96 x the SD of the paired
 * differences directly -- implemented exactly that way below, not as two
 * separate multiplications that could be gotten wrong in either direction.
 * This is also exactly HALF the width of a Bland-Altman limits-of-agreement
 * band computed on the same differences (bland-altman.js's
 * upperLoA-lowerLoA = 2 x 1.96 x SD(diff) = 2 x RC) -- expected, since RC
 * and LoA are the same underlying quantity asked two different ways.
 * ----------------------------------------------------------------------------
 */
import { mean, sd } from "./statistics.js";

const APP_PARAMETER_KEYS = ["shoulderAbductionDeg", "shoulderFlexionDeg", "externalRotationDeg", "internalRotationDeg"];

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const k = keyFn(item);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

/**
 * Between-session (between-visit) repeatability: same patient, repeat APP
 * sessions within `windowDays`, paired consecutively -- the exact same
 * pairing logic reliability-engine.js's testRetestReliability() already
 * uses (same groupBy-hospitalId, same consecutive-pairing-within-window
 * rule), so the two analyses agree on WHICH pairs count as repeats; they
 * just compute different statistics from those pairs.
 * @param {Array<{sessionId,hospitalId,createdAt,parameters}>} sessions - same shape testRetestReliability() takes
 */
function betweenSessionRepeatability(sessions, { windowDays = 30 } = {}) {
  const groups = groupBy(sessions, (s) => s.hospitalId);
  const diffsPerParam = Object.fromEntries(APP_PARAMETER_KEYS.map((k) => [k, []]));
  const allValuesPerParam = Object.fromEntries(APP_PARAMETER_KEYS.map((k) => [k, []]));
  const pairsFound = [];

  for (const [hospitalId, group] of Object.entries(groups)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (let i = 1; i < sorted.length; i++) {
      const daysBetween = (new Date(sorted[i].createdAt) - new Date(sorted[i - 1].createdAt)) / 86400000;
      if (daysBetween > windowDays) continue;
      pairsFound.push({ hospitalId, sessionA: sorted[i - 1].sessionId, sessionB: sorted[i].sessionId, daysBetween: Math.round(daysBetween * 10) / 10 });
      for (const key of APP_PARAMETER_KEYS) {
        const a = sorted[i - 1].parameters?.[key]?.value;
        const b = sorted[i].parameters?.[key]?.value;
        if (a != null && b != null) {
          diffsPerParam[key].push(a - b);
          allValuesPerParam[key].push(a, b);
        }
      }
    }
  }

  const perParameter = {};
  for (const key of APP_PARAMETER_KEYS) {
    const diffs = diffsPerParam[key];
    const n = diffs.length;
    if (n < 2) {
      perParameter[key] = { n, note: `n=${n} paired repeats -- need at least 2 to compute repeatability statistics.` };
      continue;
    }
    const diffSd = sd(diffs);
    const withinSubjectSd = diffSd / Math.sqrt(2);
    const grandMean = mean(allValuesPerParam[key]);
    const repeatabilityCoefficient = 1.96 * diffSd; // see file header derivation
    const coefficientOfVariationPct = grandMean !== 0 ? (withinSubjectSd / Math.abs(grandMean)) * 100 : null;
    perParameter[key] = {
      n,
      meanDifference: mean(diffs),
      diffSd,
      withinSubjectSd,
      coefficientOfVariationPct,
      repeatabilityCoefficient,
      note: `95% of repeat-measurement pairs are expected to differ by less than ${repeatabilityCoefficient.toFixed(1)}deg (Bland & Altman 1996 repeatability coefficient).`,
    };
  }

  return { type: "between-session", windowDays, groupsFound: pairsFound.length, pairsFound, perParameter };
}

/**
 * Within-session repeatability (recording the SAME task twice in ONE
 * visit) is explicitly NOT computed here, and deliberately does not return
 * a number of any kind. The capture workflow (frozen/out of scope this
 * phase) records each Modified Mallet task exactly once per session --
 * there is no repeat-capture-in-one-visit data to analyze. The per-frame
 * trajectory samples within a single task recording (see
 * shared/biomechanics/rotation-trajectory.js) are NOT a valid substitute:
 * they are samples of one continuous movement, not independent repeat
 * trials, so treating their spread as "measurement repeatability" would
 * misattribute genuine movement variability to measurement error -- a real
 * statistical error, not a defensible approximation. This function exists
 * so callers have an explicit, honest status to display rather than
 * silently omitting the analysis (which could read as "not yet run"
 * instead of "not currently possible, here's why").
 * @returns {{status: "not_computable", reason: string}}
 */
function withinSessionRepeatability() {
  return {
    status: "not_computable",
    reason:
      "The capture workflow records each Modified Mallet task exactly once per session -- no repeat-capture-in-one-visit data exists to analyze. Per-frame samples within a single task recording are one continuous movement, not independent repeat trials, and using their spread as a repeatability estimate would misattribute movement variability to measurement error. Recording the same task twice in one visit would be a capture-workflow change, out of scope for this validation/statistics phase.",
  };
}

export { betweenSessionRepeatability, withinSessionRepeatability, APP_PARAMETER_KEYS };
