/**
 * publication-tables.js — Phase 10: discrete, per-topic publication tables.
 * ----------------------------------------------------------------------------
 * Before this file, the only "table" output was report-generator.js's one
 * monolithic resultsTable + prose report -- fine for a single research
 * report, but not what a conference paper needs (separate Table 1:
 * Demographics, Table 2: Agreement Statistics, etc., each independently
 * exportable). Every function here is a pure read of already-computed
 * results (comparisonResults, reliabilityResults, qcResults, etc.) -- this
 * file computes NOTHING statistical itself, it only reshapes existing
 * numbers into `{tableName, columns, rows}`, the same generic
 * `{sectionName: rows[]}` shape shared/reporting/csv-builder.js and
 * backend/xlsx-renderer.js already accept without modification (confirmed
 * during Phase 10 research).
 * ----------------------------------------------------------------------------
 */
import { iccInterpretation } from "./statistics.js";

function fmt(n, digits = 3) {
  return n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits;
}

function demographicsTable(participants) {
  const rows = [
    { metric: "Unique patients", value: participants.uniquePatients },
    { metric: "Total capture sessions", value: participants.totalSessions },
    { metric: "Total clinician assessments", value: participants.totalAssessments },
    { metric: "Age range (months)", value: participants.ageRangeMonths ? `${participants.ageRangeMonths[0]}-${participants.ageRangeMonths[1]}` : "n/a" },
    { metric: "Mean age (months)", value: fmt(participants.ageMeanMonths, 1) ?? "n/a" },
  ];
  for (const [sex, count] of Object.entries(participants.sexCounts || {})) rows.push({ metric: `Sex: ${sex}`, value: count });
  for (const [side, count] of Object.entries(participants.sideCounts || {})) rows.push({ metric: `Side tested: ${side}`, value: count });
  return { tableName: "Demographics", columns: ["metric", "value"], rows };
}

function assessmentSummaryTable(participants, qcResults) {
  const excludedCount = Object.values(qcResults.exclusionRecommendations || {}).filter((e) => e.excludeFromAnalysis).length;
  const rows = [
    { metric: "Total sessions", value: participants.totalSessions },
    { metric: "Total clinician assessments", value: participants.totalAssessments },
    { metric: "Sessions recommended for exclusion (data-quality errors)", value: excludedCount },
    { metric: "Sessions flagged for manual review (warnings only)", value: Object.values(qcResults.exclusionRecommendations || {}).filter((e) => !e.excludeFromAnalysis && e.reviewReasons.length > 0).length },
    { metric: "Quality-control errors", value: qcResults.bySeverity.error },
    { metric: "Quality-control warnings", value: qcResults.bySeverity.warning },
    { metric: "Quality-control informational flags", value: qcResults.bySeverity.info },
  ];
  return { tableName: "Assessment Summary", columns: ["metric", "value"], rows };
}

function agreementStatisticsTable(comparisonResults, malletAgreement) {
  const rows = Object.entries(comparisonResults).map(([parameter, r]) => ({
    parameter,
    n: r.n,
    pearsonR: fmt(r.pearsonR),
    pearsonR95CI: r.pearsonR95CI ? `[${fmt(r.pearsonR95CI.low)}, ${fmt(r.pearsonR95CI.high)}]` : "n/a",
    spearmanRho: fmt(r.spearmanRho),
    icc2_1: fmt(r.icc2_1?.value),
    icc2_1Interpretation: r.icc2_1?.interpretation ?? "n/a",
    icc3_1: fmt(r.icc3_1?.value),
    withinTolerancePct: r.withinTolerancePct?.value ?? "n/a",
    recommendedStatistic: r.recommendedStatistic?.statistic ?? "n/a",
  }));
  if (malletAgreement?.percentAgreement?.n) {
    rows.push({
      parameter: "malletGrade (ordinal I-V)",
      n: malletAgreement.percentAgreement.n,
      pearsonR: "n/a (categorical)",
      pearsonR95CI: "n/a",
      spearmanRho: "n/a",
      icc2_1: "n/a",
      icc2_1Interpretation: `exact agreement ${malletAgreement.percentAgreement.exactMatchPct}%, within-1-grade ${malletAgreement.percentAgreement.within1GradePct}%`,
      icc3_1: "n/a",
      withinTolerancePct: "n/a",
      recommendedStatistic: `weighted kappa = ${fmt(malletAgreement.weightedKappa?.value) ?? "n/a"} (${malletAgreement.weightedKappa?.interpretation ?? "n/a"})`,
    });
  }
  return { tableName: "Agreement Statistics", columns: ["parameter", "n", "pearsonR", "pearsonR95CI", "spearmanRho", "icc2_1", "icc2_1Interpretation", "icc3_1", "withinTolerancePct", "recommendedStatistic"], rows };
}

function errorStatisticsTable(comparisonResults) {
  const rows = Object.entries(comparisonResults).map(([parameter, r]) => ({
    parameter,
    n: r.n,
    mae: fmt(r.mae),
    rmse: fmt(r.rmse),
    bias: fmt(r.bias),
    blandAltmanBias: fmt(r.blandAltman?.bias),
    lowerLoA: fmt(r.blandAltman?.lowerLoA),
    upperLoA: fmt(r.blandAltman?.upperLoA),
    outlierCount: r.blandAltman?.outlierCount ?? "n/a",
  }));
  return { tableName: "Error Statistics", columns: ["parameter", "n", "mae", "rmse", "bias", "blandAltmanBias", "lowerLoA", "upperLoA", "outlierCount"], rows };
}

function reliabilityStatisticsTable(reliabilityResults, repeatabilityResults) {
  const rows = [];
  for (const [type, result] of Object.entries(reliabilityResults || {})) {
    for (const [parameter, p] of Object.entries(result.perParameter || {})) {
      const iccKey = Object.keys(p).find((k) => k.startsWith("icc"));
      rows.push({
        reliabilityType: type,
        parameter,
        n: p.n,
        icc: fmt(p[iccKey]?.value),
        iccForm: p[iccKey]?.form ?? "n/a",
        interpretation: p[iccKey]?.interpretation ?? iccInterpretation(p[iccKey]?.value),
      });
    }
  }
  if (repeatabilityResults?.betweenSession?.perParameter) {
    for (const [parameter, p] of Object.entries(repeatabilityResults.betweenSession.perParameter)) {
      rows.push({
        reliabilityType: "between-session repeatability",
        parameter,
        n: p.n,
        icc: "n/a",
        iccForm: `SD=${fmt(p.diffSd)}, CoV=${fmt(p.coefficientOfVariationPct, 1)}%, RC=${fmt(p.repeatabilityCoefficient, 1)}`,
        interpretation: p.note ?? "n/a",
      });
    }
  }
  rows.push({
    reliabilityType: "within-session repeatability",
    parameter: "all",
    n: 0,
    icc: "n/a",
    iccForm: "not computable",
    interpretation: repeatabilityResults?.withinSession?.reason ?? "not computable",
  });
  return { tableName: "Reliability Statistics", columns: ["reliabilityType", "parameter", "n", "icc", "iccForm", "interpretation"], rows };
}

/** A condensed, single-row-per-parameter "how well does the AI perform"
 *  summary -- distinct from the more detailed Agreement/Error tables above
 *  (standard practice: papers pair a detailed stats appendix with one
 *  consolidated headline performance table). */
function modelPerformanceTable(comparisonResults, malletAgreement) {
  const rows = Object.entries(comparisonResults).map(([parameter, r]) => ({
    parameter,
    n: r.n,
    mae: fmt(r.mae),
    icc2_1: fmt(r.icc2_1?.value),
    agreementLevel: r.icc2_1 ? iccInterpretation(r.icc2_1.value) : "insufficient data",
    recommendedStatistic: r.recommendedStatistic?.statistic ?? "none",
  }));
  if (malletAgreement?.weightedKappa?.value != null) {
    rows.push({
      parameter: "malletGrade",
      n: malletAgreement.weightedKappa.n,
      mae: "n/a",
      icc2_1: fmt(malletAgreement.weightedKappa.value),
      agreementLevel: malletAgreement.weightedKappa.interpretation,
      recommendedStatistic: "weighted kappa (ordinal)",
    });
  }
  return { tableName: "Model Performance", columns: ["parameter", "n", "mae", "icc2_1", "agreementLevel", "recommendedStatistic"], rows };
}

/** Requires raw sessions (with per-task cameraQuality), not just qcResults,
 *  since qcResults only carries individual flagged issues, not an
 *  aggregate CQI distribution. */
function captureQualitySummaryTable(sessions) {
  const cqiValues = [];
  let taskCount = 0;
  let lowCqiCount = 0;
  for (const s of sessions) {
    for (const task of Object.values(s.taskResults || {})) {
      taskCount++;
      const cqi = task.cameraQuality?.cqi;
      if (cqi != null) {
        cqiValues.push(cqi);
        if (cqi < 55) lowCqiCount++;
      }
    }
  }
  const sorted = [...cqiValues].sort((a, b) => a - b);
  const mean = cqiValues.length ? cqiValues.reduce((a, b) => a + b, 0) / cqiValues.length : null;
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const rows = [
    { metric: "Total tasks captured", value: taskCount },
    { metric: "Tasks with CQI recorded", value: cqiValues.length },
    { metric: "Mean CQI", value: fmt(mean, 1) ?? "n/a" },
    { metric: "Median CQI", value: median ?? "n/a" },
    { metric: "Min CQI", value: sorted.length ? sorted[0] : "n/a" },
    { metric: "Max CQI", value: sorted.length ? sorted[sorted.length - 1] : "n/a" },
    { metric: "Tasks below quality-gate threshold (CQI<55)", value: lowCqiCount },
  ];
  return { tableName: "Capture Quality Summary", columns: ["metric", "value"], rows };
}

/**
 * @param {object} args
 * @param {object} args.participants - report-generator.js's summarizeParticipants() output
 * @param {object} args.comparisonResults - comparison-engine.js's runComparison() output
 * @param {object} args.reliabilityResults - {testRetest, interRater, intraRater}
 * @param {object} args.repeatabilityResults - {betweenSession, withinSession}
 * @param {object} args.malletAgreement - {confusionMatrix, percentAgreement, weightedKappa}
 * @param {object} args.qcResults - quality-control.js's runQualityControl() output
 * @param {Array} args.sessions - raw sessions (for capture-quality aggregation)
 * @returns {{demographics, assessmentSummary, agreementStatistics, errorStatistics, reliabilityStatistics, modelPerformance, captureQualitySummary}}
 */
function buildPublicationTables({ participants, comparisonResults, reliabilityResults, repeatabilityResults, malletAgreement, qcResults, sessions }) {
  return {
    demographics: demographicsTable(participants),
    assessmentSummary: assessmentSummaryTable(participants, qcResults),
    agreementStatistics: agreementStatisticsTable(comparisonResults, malletAgreement),
    errorStatistics: errorStatisticsTable(comparisonResults),
    reliabilityStatistics: reliabilityStatisticsTable(reliabilityResults, repeatabilityResults),
    modelPerformance: modelPerformanceTable(comparisonResults, malletAgreement),
    captureQualitySummary: captureQualitySummaryTable(sessions),
  };
}

/**
 * Reshapes buildPublicationTables()'s {tableName, columns, rows} objects
 * into the generic {sectionName: rows[]} shape shared/reporting/
 * csv-builder.js and backend/xlsx-renderer.js already accept without
 * modification (confirmed reusable during Phase 10 research) -- a thin
 * adapter, not a second row-computation, following the same "one function
 * per export concern" pattern shared/reporting/research-export-rows.js
 * already established for the Phase 9 dashboard's export pipeline.
 * @param {object} publicationTables - buildPublicationTables() output
 * @returns {{[sectionName: string]: object[]}}
 */
function buildValidationExportRows(publicationTables) {
  return Object.fromEntries(Object.entries(publicationTables).map(([key, table]) => [key, table.rows]));
}

export {
  buildPublicationTables,
  buildValidationExportRows,
  demographicsTable,
  assessmentSummaryTable,
  agreementStatisticsTable,
  errorStatisticsTable,
  reliabilityStatisticsTable,
  modelPerformanceTable,
  captureQualitySummaryTable,
};
