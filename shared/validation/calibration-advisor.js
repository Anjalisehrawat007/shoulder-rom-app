/**
 * calibration-advisor.js — Part 9: Calibration Framework
 * ----------------------------------------------------------------------------
 * Detects parameters whose agreement with clinician measurements is poor
 * and generates a RECOMMENDATION -- never a code change, never an API call.
 * Publishing a new reference-dataset or asri-config version stays a human
 * decision made through the existing Phase 2 endpoints
 * (POST /api/asri-config, POST /api/reference-datasets), both of which are
 * already immutable/versioned. This module only reads comparison-engine.js
 * output and reference-datasets.v1.json; it writes nothing.
 * ----------------------------------------------------------------------------
 */

const MIN_N_FOR_RECOMMENDATION = 8; // below this, a "recommendation" would just be noise

/**
 * @param {object} comparisonResults - shared/validation/comparison-engine.js's runComparison() output
 * @param {object} referenceTargets - resolved reference dataset targets (for current target values)
 */
function generateCalibrationReport(comparisonResults, referenceTargets = {}) {
  const recommendations = [];

  for (const [paramKey, result] of Object.entries(comparisonResults)) {
    if (result.n < MIN_N_FOR_RECOMMENDATION) {
      recommendations.push({
        parameter: paramKey,
        status: "insufficient_data",
        n: result.n,
        message: `n=${result.n} is below the minimum (${MIN_N_FOR_RECOMMENDATION}) for a calibration recommendation to be meaningful -- collect more paired data before considering re-calibration.`,
      });
      continue;
    }

    const icc = result.icc2_1?.value ?? null;
    const interpretation = result.icc2_1?.interpretation ?? "not computable";
    const isPoor = icc != null && icc < 0.5;
    const isModerate = icc != null && icc >= 0.5 && icc < 0.75;

    if (!isPoor && !isModerate) {
      recommendations.push({
        parameter: paramKey,
        status: "acceptable",
        n: result.n,
        icc2_1: icc,
        interpretation,
        message: `ICC(2,1)=${icc?.toFixed(2)} (${interpretation}, Koo & Li 2016) -- no calibration recommended at this time.`,
      });
      continue;
    }

    const currentTarget = referenceTargets?.[paramKey]?.target ?? null;
    const meanBias = result.bias;
    const suggestedTarget = currentTarget != null && meanBias != null ? Math.round((currentTarget - meanBias) * 10) / 10 : null;

    recommendations.push({
      parameter: paramKey,
      status: isPoor ? "poor" : "moderate",
      n: result.n,
      icc2_1: icc,
      interpretation,
      meanBias,
      currentTarget,
      suggestedTarget,
      message:
        `ICC(2,1)=${icc?.toFixed(2)} (${interpretation}) with n=${result.n}. ` +
        (suggestedTarget != null
          ? `Current reference target is ${currentTarget}deg; mean app-clinician bias of ${meanBias?.toFixed(1)}deg suggests trying ~${suggestedTarget}deg. `
          : "") +
        `Publish a NEW reference-dataset version via POST /api/reference-datasets to test this -- never overwrite the existing version, and re-run validation on a held-out sample before trusting the change.`,
      icc2_vs_icc3_gap:
        result.icc2_1?.value != null && result.icc3_1?.value != null
          ? Math.round((result.icc3_1.value - result.icc2_1.value) * 100) / 100
          : null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    minSampleSizeForRecommendation: MIN_N_FOR_RECOMMENDATION,
    recommendations,
    disclaimer:
      "These are recommendations for a researcher to evaluate manually. This module never modifies ASRI, DMQE, or reference-dataset configuration -- publishing a new config version is always a separate, deliberate, human action through the existing versioned endpoints.",
  };
}

export { generateCalibrationReport, MIN_N_FOR_RECOMMENDATION };
