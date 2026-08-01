/**
 * statistics.js — Part 4: Statistical Analysis
 * ----------------------------------------------------------------------------
 * Pure functions on paired numeric arrays. No dependency on ASRI, DMQE, or
 * any capture-time module -- this file only knows about numbers.
 *
 * T-QUANTILE APPROXIMATION: 95% CIs need the two-tailed t-critical value at
 * a given degrees of freedom. Rather than implementing the full inverse
 * incomplete-beta function, this uses a standard textbook lookup table for
 * df 1-30 and converges to the normal-approximation value (1.96) beyond
 * that -- adequate for exploratory/preliminary reporting at the sample
 * sizes this project will see for a long time, but NOT a substitute for
 * exact p-values from R/Python/SPSS before publication. This limitation is
 * stated here deliberately, not hidden.
 *
 * ICC: three forms (Shrout & Fleiss 1979; McGraw & Wong 1996), computed
 * from the standard two-way ANOVA mean squares over a ratings matrix
 * (rows = subjects, columns = raters/methods). See docs/validation.md for
 * the full derivation and which form answers which question.
 * ----------------------------------------------------------------------------
 */

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator). */
function sd(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function se(values) {
  const s = sd(values);
  return s == null ? null : s / Math.sqrt(values.length);
}

// Two-tailed 95% t-critical values, df 1-30 (standard textbook table).
const T_TABLE_975 = [
  null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110,
  2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** Two-tailed 95% t-critical value, table-based for df<=30, converging to
 *  the normal approximation for larger df (see file header). */
function tCritical95(df) {
  if (df <= 0) return null;
  if (df <= 30) return T_TABLE_975[Math.round(df)] ?? 2.042;
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

/** 95% confidence interval for a mean, given its SE and degrees of freedom. */
function confidenceInterval95(meanValue, standardError, df) {
  if (standardError == null || df == null || df <= 0) return null;
  const t = tCritical95(df);
  const margin = t * standardError;
  return { low: meanValue - margin, high: meanValue + margin, margin, tCritical: t, df };
}

function pearsonR(x, y) {
  const n = x.length;
  if (n < 2 || n !== y.length) return null;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}

/** Ranks with tie-averaging (standard fractional ranking). */
function rankValues(values) {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function spearmanRho(x, y) {
  if (x.length < 2 || x.length !== y.length) return null;
  return pearsonR(rankValues(x), rankValues(y));
}

function mae(diffs) {
  return diffs.length === 0 ? null : mean(diffs.map(Math.abs));
}

function rmse(diffs) {
  return diffs.length === 0 ? null : Math.sqrt(mean(diffs.map((d) => d * d)));
}

function bias(diffs) {
  return diffs.length === 0 ? null : mean(diffs);
}

/**
 * Intraclass correlation from a subjects x raters matrix.
 * @param {number[][]} matrix - matrix[subject][rater]
 * @param {"1,1"|"2,1"|"3,1"} form
 * @returns {{value: number, n: number, k: number, form: string}|null}
 */
function computeICC(matrix, form) {
  const n = matrix.length;
  if (n < 2) return null;
  const k = matrix[0].length;
  if (k < 2) return null;

  const grandMean = mean(matrix.flat());
  const subjectMeans = matrix.map((row) => mean(row));
  const raterMeans = Array.from({ length: k }, (_, j) => mean(matrix.map((row) => row[j])));

  let sst = 0;
  for (const row of matrix) for (const v of row) sst += (v - grandMean) ** 2;
  const ssr = k * subjectMeans.reduce((sum, m) => sum + (m - grandMean) ** 2, 0);
  const ssc = n * raterMeans.reduce((sum, m) => sum + (m - grandMean) ** 2, 0);
  const sse = sst - ssr - ssc;
  const ssw = sst - ssr;

  const dfR = n - 1;
  const dfC = k - 1;
  const dfE = (n - 1) * (k - 1);
  const dfW = n * (k - 1);

  const msr = ssr / dfR;
  const msc = ssc / dfC;
  const mse = dfE > 0 ? sse / dfE : 0;
  const msw = dfW > 0 ? ssw / dfW : 0;

  let value;
  if (form === "1,1") {
    // One-way random: no separate rater effect modeled (test-retest / intra-rater).
    value = msw + msr === 0 ? null : (msr - msw) / (msr + (k - 1) * msw);
  } else if (form === "2,1") {
    // Two-way random, absolute agreement.
    const denom = msr + (k - 1) * mse + (k * (msc - mse)) / n;
    value = denom === 0 ? null : (msr - mse) / denom;
  } else if (form === "3,1") {
    // Two-way mixed, consistency.
    const denom = msr + (k - 1) * mse;
    value = denom === 0 ? null : (msr - mse) / denom;
  } else {
    throw new Error(`computeICC: unknown form "${form}"`);
  }

  return { value: value == null ? null : Math.max(-1, Math.min(1, value)), n, k, form };
}

/** Koo & Li (2016) interpretation bands -- cited, not silently applied. */
function iccInterpretation(value) {
  if (value == null) return "not computable";
  if (value < 0.5) return "poor";
  if (value < 0.75) return "moderate";
  if (value < 0.9) return "good";
  return "excellent";
}

/**
 * Recommends which correlation/agreement statistic is appropriate given
 * basic sample characteristics -- an explicit reasoned recommendation, not
 * a silently-applied default.
 */
function recommendedStatistic({ n, hasTies = false, likelyNonNormal = false }) {
  if (n < 5) {
    return { statistic: "none", reason: `n=${n} is too small for any correlation/ICC statistic to be meaningful; report raw differences only.` };
  }
  if (n < 10) {
    return { statistic: "spearman", reason: `n=${n} is small; Spearman's rank correlation is more robust to outliers/non-normality than Pearson at this sample size, and any ICC confidence interval should be treated as unreliable.` };
  }
  if (hasTies || likelyNonNormal) {
    return { statistic: "spearman", reason: "Data shows ties or apparent non-normality; Spearman's rank correlation does not assume a linear/normal relationship the way Pearson does." };
  }
  return { statistic: "pearson", reason: `n=${n} with no strong evidence against normality; Pearson correlation and ICC confidence intervals should be reasonably reliable, though still preliminary below the recommended sample size (see docs/validation.md).` };
}

/**
 * Fisher z-transform 95% CI for a Pearson correlation coefficient -- the
 * standard method (Fisher 1921), and the ONLY correlation/agreement
 * statistic in this file that previously had no CI attached (pearsonR/
 * spearmanRho returned a bare number; computeICC has its own CI via
 * bootstrapICC below). z = atanh(r), CI in z-space is ±1.96/sqrt(n-3),
 * transformed back with tanh.
 * @returns {{low: number, high: number}|null} null if n<=3 or |r|>=1 (atanh undefined at ±1)
 */
function fisherZCI(r, n) {
  if (r == null || n == null || n <= 3 || Math.abs(r) >= 1) return null;
  const z = Math.atanh(r);
  const se_z = 1 / Math.sqrt(n - 3);
  const margin = 1.96 * se_z;
  return { low: Math.tanh(z - margin), high: Math.tanh(z + margin) };
}

/**
 * Percentile bootstrap 95% CI for an ICC value -- resamples SUBJECTS (rows)
 * with replacement, recomputes ICC each time, takes the 2.5th/97.5th
 * percentile of the resulting distribution. Addresses a gap this project's
 * own docs/validation.md already flagged ("bootstrap confidence intervals
 * for ICC (more robust at small n)" under Future Improvements) -- a
 * parametric ICC CI formula exists in the literature but is more fragile
 * at the small sample sizes this project will see for a long time, so
 * bootstrap (which makes no distributional assumption) is the more
 * defensible choice here.
 * @param {number[][]} matrix - matrix[subject][rater], same shape computeICC takes
 * @param {"1,1"|"2,1"|"3,1"} form
 * @param {number} [iterations=1000]
 * @returns {{low: number, high: number, iterations: number}|null} null if n<3 (too few subjects to resample meaningfully)
 */
function bootstrapICC(matrix, form, iterations = 1000) {
  const n = matrix.length;
  if (n < 3) return null;
  const values = [];
  for (let iter = 0; iter < iterations; iter++) {
    const resampled = [];
    for (let i = 0; i < n; i++) resampled.push(matrix[Math.floor(Math.random() * n)]);
    const result = computeICC(resampled, form);
    if (result?.value != null) values.push(result.value);
  }
  if (values.length < iterations * 0.5) return null; // too many degenerate resamples (e.g. all-same-subject draws) to trust the distribution
  values.sort((a, b) => a - b);
  const lowIdx = Math.floor(0.025 * values.length);
  const highIdx = Math.min(values.length - 1, Math.ceil(0.975 * values.length));
  return { low: values[lowIdx], high: values[highIdx], iterations: values.length };
}

/**
 * Honest sample-size-adequacy classification against the project's own
 * cited minimum-n guidance (Bujang & Baharum 2017, n=30 -- see
 * docs/validation.md), NOT a fabricated post-hoc statistical power number.
 * Computing power from an OBSERVED effect size after the fact is a
 * well-documented statistical malpractice (it's a deterministic
 * (monotonic) function of the p-value, not new information) -- no
 * legitimate biostatistics practice does this, so this function
 * deliberately doesn't either. This is the honest mechanism the project
 * uses to satisfy "explicitly state when statistical power is
 * insufficient" without fabricating a number that looks precise but isn't.
 * @returns {{adequate: boolean, n: number, recommendedMinN: number, statement: string}}
 */
function sampleSizeAdequacy(n, recommendedMinN = 30) {
  const adequate = n >= recommendedMinN;
  const statement = adequate
    ? `n=${n} meets the recommended minimum of ${recommendedMinN} (Bujang & Baharum 2017) for stable correlation/ICC estimates.`
    : `n=${n} is below the recommended minimum of ${recommendedMinN} (Bujang & Baharum 2017) -- all agreement/correlation estimates here are exploratory/preliminary, not adequately powered to detect small-to-moderate effects. This is a sample-size adequacy classification, not a computed statistical power value: post-hoc power computed from an observed effect size would be circular (a deterministic function of the p-value) and is not reported here for that reason.`;
  return { adequate, n, recommendedMinN, statement };
}

export {
  mean,
  sd,
  se,
  tCritical95,
  confidenceInterval95,
  pearsonR,
  spearmanRho,
  rankValues,
  mae,
  rmse,
  bias,
  computeICC,
  iccInterpretation,
  recommendedStatistic,
  fisherZCI,
  bootstrapICC,
  sampleSizeAdequacy,
};
