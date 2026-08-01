/**
 * pilot-study-summary.js — Phase 10: Pilot Study Summary + structured
 * readiness classification.
 * ----------------------------------------------------------------------------
 * A dedicated summary artifact distinct from generateValidationReport()'s
 * general research report -- this answers the specific "should we run a
 * pilot study / submit to a conference" question the general report
 * doesn't structure an answer to (it has the numbers, but no explicit
 * readiness verdict).
 *
 * THE READINESS CLASSIFICATION IS THE TYPED VERSION of a distinction this
 * project's docs (docs/validation.md, report-generator.js's limitations
 * array) have only ever stated in prose: engineering verification vs
 * clinical validation vs clinical deployment are three different bars, and
 * clearing one does not clear the next. Making it a real, structured field
 * (not just narrative) means a caller (UI, PDF, API consumer) can act on it
 * directly rather than parsing prose.
 * ----------------------------------------------------------------------------
 */

/**
 * Engineering verification is a code-quality question this project already
 * answers definitively elsewhere (the verify-*.mjs synthetic test suites,
 * one per phase, all passing) -- always "complete" once code ships with
 * passing tests, independent of how much real clinical data exists.
 * Clinical validation and deployment readiness DO depend on real data
 * volume/quality, computed from this run's own qcResults/comparisonResults.
 */
function classifyReadiness({ pairedN, uniquePatients, qcResults, recommendedMinN = 30 }) {
  const engineeringVerification = {
    status: "complete",
    reason: "Every measurement/statistics module has a passing synthetic ground-truth test suite (scripts/verify-*.mjs) verifying its own internal correctness against known inputs. This is independent of how much real clinical data exists -- it answers 'does the code compute what it claims to compute,' not 'does the app agree with clinicians.'",
  };

  const hasErrors = qcResults.bySeverity.error > 0;
  const adequateN = pairedN >= recommendedMinN && uniquePatients >= recommendedMinN;
  let clinicalValidation;
  if (pairedN === 0) {
    clinicalValidation = { status: "not_started", reason: "Zero paired app-vs-clinician measurements exist. Clinical validation has not begun." };
  } else if (hasErrors) {
    clinicalValidation = { status: "blocked", reason: `${qcResults.bySeverity.error} data-quality error(s) must be resolved before any validation conclusion can be trusted.` };
  } else if (!adequateN) {
    clinicalValidation = { status: "preliminary", reason: `n=${pairedN} paired measurements across ${uniquePatients} patients is below the recommended minimum (n=${recommendedMinN} both). Results are exploratory, not confirmatory.` };
  } else {
    clinicalValidation = { status: "adequate_sample", reason: `n=${pairedN} paired measurements across ${uniquePatients} patients meets the recommended minimum -- statistics are stable enough for confirmatory interpretation, subject to the actual agreement values found (a large, well-powered sample can still show poor agreement).` };
  }

  // Clinical deployment always trails clinical validation by design -- a
  // research prototype with no regulatory clearance cannot reach "ready"
  // regardless of how good the statistics look, and this project has never
  // claimed otherwise (see docs/validation.md regulatory considerations).
  const clinicalDeployment = {
    status: "not_ready",
    reason: "This is a research prototype, not a cleared or CE-marked medical device. Clinical deployment readiness requires regulatory clearance and a validation program well beyond what a pilot study establishes, regardless of how favorable the statistics above are.",
  };

  return { engineeringVerification, clinicalValidation, clinicalDeployment };
}

/**
 * @param {object} args
 * @param {Array} args.sessions
 * @param {Array} args.assessments
 * @param {object} args.comparisonResults
 * @param {object} args.reliabilityResults
 * @param {object} args.qcResults
 * @param {object} args.malletAgreement
 * @param {Array} [args.malletOverrideRows] - raw mallet_grade_overrides rows, for override statistics
 * @param {Array} [args.parameterOverrideRows] - raw parameter_overrides rows
 * @param {Array} [args.datasetMemberships] - session_dataset_membership rows for this dataset, for status counts
 */
function generatePilotStudySummary({
  sessions,
  assessments,
  comparisonResults,
  reliabilityResults,
  qcResults,
  malletAgreement,
  malletOverrideRows = [],
  parameterOverrideRows = [],
  datasetMemberships = [],
}) {
  const uniquePatients = new Set(sessions.map((s) => s.hospitalId).filter(Boolean)).size;
  const pairedN = Math.max(0, ...Object.values(comparisonResults).map((r) => r.n), 0);

  // Failure rate: sessions with zero captured tasks (no_pose_detected /
  // never completed a single task) out of all sessions in this dataset.
  const failedSessions = sessions.filter((s) => Object.keys(s.taskResults || {}).length === 0).length;
  const failureRatePct = sessions.length ? Math.round((failedSessions / sessions.length) * 1000) / 10 : null;

  const cqiValues = [];
  const confidenceCounts = { high: 0, moderate: 0, low: 0, unavailable: 0 };
  for (const s of sessions) {
    for (const task of Object.values(s.taskResults || {})) {
      if (task.cameraQuality?.cqi != null) cqiValues.push(task.cameraQuality.cqi);
      for (const p of Object.values(task.parameters || {})) {
        if (!p || typeof p !== "object") continue;
        const bucket = p.confidence && confidenceCounts[p.confidence] != null ? p.confidence : p.measurementType === "unavailable" ? "unavailable" : null;
        if (bucket) confidenceCounts[bucket]++;
      }
    }
  }
  const meanCqi = cqiValues.length ? Math.round((cqiValues.reduce((a, b) => a + b, 0) / cqiValues.length) * 10) / 10 : null;
  const totalConfidenceObservations = Object.values(confidenceCounts).reduce((a, b) => a + b, 0);
  const meanConfidencePct = totalConfidenceObservations
    ? Math.round(((confidenceCounts.high * 100 + confidenceCounts.moderate * 60 + confidenceCounts.low * 25) / totalConfidenceObservations) * 10) / 10
    : null; // weighted proxy (high=100/moderate=60/low=25/unavailable=0), documented as a proxy, not a claimed precise probability

  const overrideStats = {
    malletGradeOverrideCount: malletOverrideRows.length,
    parameterOverrideCount: parameterOverrideRows.length,
    meanMalletGradeDelta:
      malletOverrideRows.length > 0
        ? Math.round((malletOverrideRows.reduce((sum, o) => sum + Math.abs(o.difference ?? 0), 0) / malletOverrideRows.length) * 100) / 100
        : null,
  };

  const membershipStatusCounts = { pending: 0, in_review: 0, completed: 0 };
  for (const m of datasetMemberships) if (membershipStatusCounts[m.status] != null) membershipStatusCounts[m.status]++;

  const readiness = classifyReadiness({ pairedN, uniquePatients, qcResults });

  const limitations = [
    "This is a research prototype -- see the readiness classification above for the explicit engineering/clinical-validation/clinical-deployment distinction.",
    pairedN === 0 ? "Zero real paired app-vs-clinician measurements exist in this dataset -- every statistic elsewhere in this report is either null or computed from synthetic/prototype data." : null,
    failedSessions > 0 ? `${failedSessions} session(s) (${failureRatePct}%) captured zero usable tasks -- investigate capture-workflow failure modes before treating the failure rate as representative of real-world use.` : null,
  ].filter(Boolean);

  const futureWork = [
    "Recruit toward the recommended minimum sample size (n=30 paired measurements, n=30 unique patients) before treating any correlation/ICC/kappa estimate as confirmatory.",
    "Extend the comparison engine to average across multiple independent clinician raters per session rather than using only the most recent assessment (already flagged as future work in docs/validation.md).",
    "If within-session repeatability data becomes a priority, this would require a capture-workflow change (recording a task twice in one visit) -- explicitly out of scope for this validation/statistics phase.",
  ];

  return {
    generatedAt: new Date().toISOString(),
    patients: { uniquePatients, totalSessions: sessions.length, totalAssessments: assessments.length },
    clinicianAgreement: {
      pairedN,
      malletExactAgreementPct: malletAgreement?.percentAgreement?.exactMatchPct ?? null,
      malletWeightedKappa: malletAgreement?.weightedKappa?.value ?? null,
    },
    aiPerformance: Object.fromEntries(Object.entries(comparisonResults).map(([k, r]) => [k, { n: r.n, mae: r.mae, icc2_1: r.icc2_1?.value ?? null }])),
    failureRate: { failedSessions, totalSessions: sessions.length, failureRatePct },
    captureQuality: { meanCqi, tasksWithCqi: cqiValues.length },
    averageConfidence: { meanConfidencePct, confidenceCounts, note: "Weighted proxy (high=100/moderate=60/low=25/unavailable=0) across all recorded parameter confidence labels -- a summary indicator, not a calibrated probability." },
    overrideStatistics: overrideStats,
    studyMembershipStatus: membershipStatusCounts,
    readiness,
    limitations,
    futureWork,
  };
}

export { generatePilotStudySummary, classifyReadiness };
