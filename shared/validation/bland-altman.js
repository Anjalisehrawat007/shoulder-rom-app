/**
 * bland-altman.js — Part 5: Bland-Altman Analysis
 * ----------------------------------------------------------------------------
 * Standard Bland & Altman (1986, 1999) difference-plot statistics. Returns
 * chart-ready point data; the actual figure is drawn in
 * validation-portal/app.js (built using the dataviz skill), not here --
 * this module only computes numbers.
 * ----------------------------------------------------------------------------
 */
import { mean, sd } from "./statistics.js";

/**
 * @param {number[]} appValues
 * @param {number[]} clinicianValues
 * @returns {object|null} null if fewer than 2 pairs
 */
function blandAltmanAnalysis(appValues, clinicianValues) {
  const n = appValues.length;
  if (n < 2 || n !== clinicianValues.length) return null;

  const diffs = appValues.map((a, i) => a - clinicianValues[i]);
  const means = appValues.map((a, i) => (a + clinicianValues[i]) / 2);

  const biasValue = mean(diffs);
  const diffSd = sd(diffs);
  const upperLoA = biasValue + 1.96 * diffSd;
  const lowerLoA = biasValue - 1.96 * diffSd;

  // Confidence bands (Bland & Altman 1999): SE(bias) = SD/sqrt(n); SE(LoA) ~= SD*sqrt(3/n).
  const seBias = diffSd / Math.sqrt(n);
  const seLoA = diffSd * Math.sqrt(3 / n);
  const t = n > 30 ? 1.96 : [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228][Math.min(n - 1, 10)] ?? 2.045;

  const points = appValues.map((a, i) => ({
    x: means[i],
    y: diffs[i],
    outlier: Math.abs(diffs[i] - biasValue) > 1.96 * diffSd,
  }));
  const outliers = points.filter((p) => p.outlier);

  return {
    n,
    bias: biasValue,
    diffSd,
    upperLoA,
    lowerLoA,
    biasCI: { low: biasValue - t * seBias, high: biasValue + t * seBias },
    upperLoACI: { low: upperLoA - t * seLoA, high: upperLoA + t * seLoA },
    lowerLoACI: { low: lowerLoA - t * seLoA, high: lowerLoA + t * seLoA },
    points,
    outlierCount: outliers.length,
    outlierIndices: points.map((p, i) => (p.outlier ? i : null)).filter((i) => i != null),
  };
}

export { blandAltmanAnalysis };
