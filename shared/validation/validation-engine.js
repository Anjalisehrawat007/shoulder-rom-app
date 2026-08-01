/**
 * validation-engine.js — Part 1: Validation Architecture (orchestrator)
 * ----------------------------------------------------------------------------
 * Ties comparison, reliability, calibration, QC, and report generation
 * together into one entry point. This is the ONLY file the backend calls
 * directly for a validation run -- everything else in shared/validation/*
 * stays independently testable and importable on its own.
 *
 * Reads session/task data and clinician assessments; writes nothing back to
 * ASRI, DMQE, or session records. See shared/validation/README.md and
 * docs/validation.md for the full architecture rationale.
 * ----------------------------------------------------------------------------
 */
import { runComparison } from "./comparison-engine.js";
import { testRetestReliability, interRaterReliability, intraRaterReliability } from "./reliability-engine.js";
import { betweenSessionRepeatability, withinSessionRepeatability } from "./repeatability-engine.js";
import { buildConfusionMatrix, percentAgreement, weightedKappa } from "./mallet-agreement.js";
import { generateCalibrationReport } from "./calibration-advisor.js";
import { runQualityControl } from "./quality-control.js";
import { generateValidationReport, renderMarkdown, summarizeParticipants } from "./report-generator.js";
import { buildPublicationTables } from "./publication-tables.js";
import { generatePilotStudySummary } from "./pilot-study-summary.js";

/** Picks the task with the highest recorded elevation as the session's
 *  representative snapshot for comparison against a single clinician
 *  assessment -- the same "peak ROM across tasks" principle ASRI's own ROM
 *  category already uses (shared/asri/aggregation-strategies.js), applied
 *  here for consistency rather than inventing a different selection rule. */
function selectRepresentativeTask(taskResults) {
  const tasks = Object.values(taskResults || {});
  if (tasks.length === 0) return null;
  // Seed the accumulator with the first task (not null) so a session where
  // every task ties at -Infinity (e.g. shoulderElevationDeg missing on
  // older stored data) still returns a task instead of nothing -- a reduce
  // starting from `null` with a strict `>` comparison can never escape
  // `null` when every candidate ties, which silently produced zero paired
  // comparisons for legitimate stored data. Caught via a real backend
  // smoke test, not a hypothetical.
  return tasks.reduce((best, t) => {
    const v = t.parameters?.shoulderElevationDeg?.value ?? -Infinity;
    const bestV = best.parameters?.shoulderElevationDeg?.value ?? -Infinity;
    return v > bestV ? t : best;
  });
}

/**
 * @param {object} args
 * @param {Array<{sessionId,hospitalId,side,createdAt,asriVersion,referenceDatasetVersion,taskResults}>} args.sessions
 * @param {Array<{sessionId,hospitalId,assessmentDate,clinicianName,age,sex,shoulderAbduction,...}>} args.assessments
 * @param {object} [args.referenceTargets] - resolved reference dataset targets, reused for normalizedError/calibration
 * @param {string} [args.datasetName]
 * @param {Array<{taskId,predictedGrade,clinicianGrade,difference,createdAt}>} [args.malletGradePairs] - raw mallet_grade_overrides rows (Phase 10)
 * @param {Array} [args.malletOverrideRows] - same rows, passed through to the pilot study summary's override statistics
 * @param {Array} [args.parameterOverrideRows] - raw parameter_overrides rows, for the pilot study summary's override statistics
 * @param {Array} [args.datasetMemberships] - session_dataset_membership rows for this dataset, for the pilot study summary
 */
function runValidation({
  sessions,
  assessments,
  referenceTargets = {},
  datasetName = "all sessions",
  malletGradePairs = [],
  malletOverrideRows = [],
  parameterOverrideRows = [],
  datasetMemberships = [],
}) {
  const assessmentsBySession = {};
  for (const a of assessments) {
    if (!assessmentsBySession[a.sessionId]) assessmentsBySession[a.sessionId] = [];
    assessmentsBySession[a.sessionId].push(a);
  }
  const latestAssessmentBySession = {};
  for (const [sessionId, list] of Object.entries(assessmentsBySession)) {
    latestAssessmentBySession[sessionId] = [...list].sort((a, b) => new Date(b.assessmentDate) - new Date(a.assessmentDate))[0];
  }

  const pairedSessions = sessions
    .filter((s) => latestAssessmentBySession[s.sessionId])
    .map((s) => ({
      sessionId: s.sessionId,
      appParameters: selectRepresentativeTask(s.taskResults)?.parameters || {},
      clinicianAssessment: latestAssessmentBySession[s.sessionId],
    }));

  const comparisonResults = runComparison(pairedSessions, referenceTargets);

  const sessionsForReliability = sessions.map((s) => ({
    sessionId: s.sessionId,
    hospitalId: s.hospitalId,
    createdAt: s.createdAt,
    parameters: selectRepresentativeTask(s.taskResults)?.parameters || {},
  }));

  const reliabilityResults = {
    testRetest: testRetestReliability(sessionsForReliability),
    interRater: interRaterReliability(assessmentsBySession),
    intraRater: intraRaterReliability(assessments),
  };

  // Phase 10 additions -- all read-only downstream analyses of data already
  // gathered above; nothing here changes what comparisonResults/
  // reliabilityResults contain.
  const repeatabilityResults = {
    betweenSession: betweenSessionRepeatability(sessionsForReliability),
    withinSession: withinSessionRepeatability(),
  };
  const malletAgreement = {
    confusionMatrix: buildConfusionMatrix(malletGradePairs),
    percentAgreement: percentAgreement(malletGradePairs),
    weightedKappa: weightedKappa(malletGradePairs),
  };

  const calibrationReport = generateCalibrationReport(comparisonResults, referenceTargets);
  const qcResults = runQualityControl(sessions, assessments);

  const report = generateValidationReport({ sessions, assessments, comparisonResults, reliabilityResults, calibrationReport, qcResults, datasetName });

  const participants = summarizeParticipants(sessions, assessments);
  const publicationTables = buildPublicationTables({ participants, comparisonResults, reliabilityResults, repeatabilityResults, malletAgreement, qcResults, sessions });
  const pilotStudySummary = generatePilotStudySummary({
    sessions,
    assessments,
    comparisonResults,
    reliabilityResults,
    qcResults,
    malletAgreement,
    malletOverrideRows,
    parameterOverrideRows,
    datasetMemberships,
  });

  return {
    pairedSessionCount: pairedSessions.length,
    comparisonResults,
    reliabilityResults,
    repeatabilityResults,
    malletAgreement,
    calibrationReport,
    qcResults,
    report,
    reportMarkdown: renderMarkdown(report),
    publicationTables,
    pilotStudySummary,
  };
}

export { runValidation, selectRepresentativeTask };
