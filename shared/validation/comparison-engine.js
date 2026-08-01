/**
 * comparison-engine.js — Part 3: Automatic Comparison
 * ----------------------------------------------------------------------------
 * Per-parameter app-vs-clinician comparison. Returns ONE ROW PER PARAMETER,
 * never a single blended verdict -- gross ROM (abduction/flexion) and
 * estimated parameters (rotation) have very different expected validity and
 * must not be collapsed together (this was the explicit requirement in the
 * Phase 1 stub, shared/validation/README.md, and stays true here).
 * ----------------------------------------------------------------------------
 */
import { pearsonR, spearmanRho, computeICC, iccInterpretation, mae, rmse, bias, sd, confidenceInterval95, recommendedStatistic, fisherZCI, bootstrapICC } from "./statistics.js";
import { blandAltmanAnalysis } from "./bland-altman.js";

// App parameter key -> clinician assessment field name. Only the four ROM
// angles are compared here -- scapular/compensation parameters don't have a
// standard clinician-measured counterpart (Mallet/AMS are composite scores,
// compared separately, not angle-for-angle).
const APP_TO_CLINICIAN_MAP = {
  shoulderAbductionDeg: "shoulderAbduction",
  shoulderFlexionDeg: "shoulderFlexion",
  externalRotationDeg: "externalRotation",
  internalRotationDeg: "internalRotation",
};

function compareParameter(paramKey, rawPairs, referenceTargets, toleranceDeg = 5) {
  const valid = rawPairs.filter((p) => p.appValue != null && p.clinicianValue != null);
  const n = valid.length;
  const appValues = valid.map((p) => p.appValue);
  const clinicianValues = valid.map((p) => p.clinicianValue);
  const diffs = appValues.map((a, i) => a - clinicianValues[i]);
  const target = referenceTargets?.[paramKey]?.target ?? null;

  const rec = recommendedStatistic({ n });
  const pearson = n >= 2 ? pearsonR(appValues, clinicianValues) : null;
  const spearman = n >= 2 ? spearmanRho(appValues, clinicianValues) : null;

  let icc2 = null;
  let icc3 = null;
  if (n >= 2) {
    const matrix = appValues.map((a, i) => [a, clinicianValues[i]]);
    const rawIcc2 = computeICC(matrix, "2,1");
    const rawIcc3 = computeICC(matrix, "3,1");
    // Phase 10: bootstrap CI computed here, not deferred to a caller, since
    // this is the one place the raw ratings matrix is still in scope
    // (compareParameter's return value discards it). n>=3 required for a
    // meaningful resample -- see bootstrapICC's own guard in statistics.js.
    icc2 = rawIcc2 && { ...rawIcc2, interpretation: iccInterpretation(rawIcc2.value), ci: n >= 3 ? bootstrapICC(matrix, "2,1") : null };
    icc3 = rawIcc3 && { ...rawIcc3, interpretation: iccInterpretation(rawIcc3.value), ci: n >= 3 ? bootstrapICC(matrix, "3,1") : null };
  }

  const maeVal = mae(diffs);
  const rmseVal = rmse(diffs);
  const biasVal = bias(diffs);
  const sdVal = sd(diffs);
  const seVal = sdVal != null ? sdVal / Math.sqrt(n) : null;
  const ci = seVal != null && n > 1 ? confidenceInterval95(biasVal, seVal, n - 1) : null;
  const withinTolerancePct = n > 0 ? (valid.filter((p, i) => Math.abs(diffs[i]) <= toleranceDeg).length / n) * 100 : null;
  const ba = n >= 2 ? blandAltmanAnalysis(appValues, clinicianValues) : null;
  const lowConfidenceCount = valid.filter((p) => p.appMeasurementType === "estimated" && p.appConfidence === "low").length;

  return {
    parameter: paramKey,
    n,
    pairs: valid.map((p, i) => ({
      sessionId: p.sessionId,
      appValue: p.appValue,
      appMeasurementType: p.appMeasurementType,
      appConfidence: p.appConfidence,
      clinicianValue: p.clinicianValue,
      diff: diffs[i],
      absoluteError: Math.abs(diffs[i]),
      relativeError: p.clinicianValue !== 0 ? Math.abs(diffs[i]) / Math.abs(p.clinicianValue) : null,
      normalizedError: target != null ? Math.abs(diffs[i]) / target : null,
    })),
    recommendedStatistic: rec,
    pearsonR: pearson,
    // Phase 10: previously the only correlation/agreement statistic in this
    // row without a CI attached (icc2_1/icc3_1 below now carry their own
    // bootstrap CI via the same statistics.js addition).
    pearsonR95CI: pearson != null ? fisherZCI(pearson, n) : null,
    spearmanRho: spearman,
    icc2_1: icc2,
    icc3_1: icc3,
    mae: maeVal,
    rmse: rmseVal,
    bias: biasVal,
    sd: sdVal,
    se: seVal,
    confidenceInterval95: ci,
    withinTolerancePct: { value: withinTolerancePct, toleranceDeg, note: "Parameterized convenience metric, not a universal 'percentage agreement' statistic -- that concept is native to categorical data, not continuous angles." },
    blandAltman: ba,
    lowConfidenceAppSampleCount: lowConfidenceCount,
    note: n === 0 ? "No paired data available." : n < 5 ? `Insufficient data (n=${n}) -- statistics shown are descriptive only, not inferential. See docs/validation.md sample-size guidance.` : null,
  };
}

/**
 * @param {Array<{sessionId: string, appParameters: object, clinicianAssessment: object}>} pairedSessions
 * @param {object} referenceTargets - resolved reference dataset targets (shared/asri/reference-datasets.js), reused for normalizedError
 */
function runComparison(pairedSessions, referenceTargets = {}) {
  const results = {};
  for (const [appKey, clinicianKey] of Object.entries(APP_TO_CLINICIAN_MAP)) {
    const rawPairs = pairedSessions.map((s) => ({
      sessionId: s.sessionId,
      appValue: s.appParameters?.[appKey]?.value ?? null,
      appMeasurementType: s.appParameters?.[appKey]?.measurementType ?? null,
      appConfidence: s.appParameters?.[appKey]?.confidence ?? null,
      clinicianValue: s.clinicianAssessment?.[clinicianKey] ?? null,
    }));
    results[appKey] = compareParameter(appKey, rawPairs, referenceTargets);
  }
  return results;
}

export { compareParameter, runComparison, APP_TO_CLINICIAN_MAP };
