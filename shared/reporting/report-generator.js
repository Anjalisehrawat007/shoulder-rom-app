/**
 * report-generator.js — Combined Clinical Report Generator
 * ----------------------------------------------------------------------------
 * Fulfills this directory's pre-existing planned interface (see README.md,
 * written in Phase 1 planning, never implemented until now): assembles a
 * session's Modified Mallet grades, ASRI composite, DMQE per-task quality,
 * ICQA capture-quality summary, and any clinician grade overrides into one
 * structured report object, plus a Markdown rendering -- the exact
 * "structured object first, renderer(s) second" pattern
 * shared/validation/report-generator.js already established in Phase 4.
 * A second renderer, backend/pdf-renderer.js, consumes this SAME object to
 * produce a PDF -- one data source, two output formats, no logic
 * duplicated between them.
 *
 * This module reads output from shared/assessment/*, shared/asri/*, and
 * shared/icqa/* (it is a reporting/aggregation layer sitting ABOVE those
 * engines, exactly as this directory's original README already specified:
 * "Depends on: shared/biomechanics/* parameter schema, shared/asri/
 * asri-engine.js") -- it does not modify any of them, and none of them
 * import from here.
 * ----------------------------------------------------------------------------
 */
import { GRADE_NUMERIC } from "../assessment/ModifiedMalletScoreEngine.js";

function fmt(n) {
  return n == null ? "n/a" : (Math.round(n * 1000) / 1000).toString();
}

/** Per-task chart-ready data points (grade/CQI/confidence as plain
 *  numbers) -- NOT a rendered chart. Actual chart drawing happens
 *  client-side in doctor-portal, following the dataviz skill's conventions
 *  at that point; this only prepares the numbers a renderer would need. */
function buildTaskChartData(taskRow) {
  return {
    gradeNumeric: taskRow.predictedGrade ? GRADE_NUMERIC[taskRow.predictedGrade] : null,
    clinicianGradeNumeric: taskRow.clinicianGrade ? GRADE_NUMERIC[taskRow.clinicianGrade] : null,
    cqi: taskRow.cqi,
    confidence: taskRow.predictedConfidence,
  };
}

function collectLimitations(taskResults) {
  const seen = new Set();
  const out = [
    "This is a research prototype, not a cleared or CE-marked medical device.",
    "Monocular RGB pose estimation has documented limitations for rotation, scapular, and several Mallet-specific proxy measurements (see docs/biomechanics.md and docs/mallet-score.md); these are treated as estimated, not measured, throughout.",
    "Grade thresholds in the active mallet-score-config version are a documented operationalization of the published Modified Mallet criteria, not fit to clinician-labelled outcome data for this population yet -- see docs/mallet-score.md.",
  ];
  for (const t of Object.values(taskResults)) {
    for (const limitation of t.malletGrade?.measurementLimitations || []) {
      if (!seen.has(limitation)) {
        seen.add(limitation);
        out.push(limitation);
      }
    }
  }
  return out;
}

function summarizeAgreement(taskRows) {
  const withOverride = taskRows.filter((r) => r.clinicianGrade != null && r.predictedGrade != null);
  if (withOverride.length === 0) return { status: "no_overrides_yet", n: 0 };
  const agreeCount = withOverride.filter((r) => r.agreement?.agree).length;
  const meanAbsDiff = withOverride.reduce((s, r) => s + Math.abs(r.agreement.differenceGrades), 0) / withOverride.length;
  return {
    status: "ok",
    n: withOverride.length,
    exactAgreementPct: Math.round((agreeCount / withOverride.length) * 100),
    meanAbsoluteGradeDifference: Math.round(meanAbsDiff * 100) / 100,
  };
}

function buildRecommendations(taskRows, malletOverall) {
  const recs = [];
  for (const r of taskRows) {
    if (r.predictedConfidence != null && r.predictedConfidence < 60) {
      recs.push(`${r.label}: prediction confidence is low (${r.predictedConfidence}%) -- consider re-recording this task with better camera positioning/lighting before relying on the predicted grade.`);
    }
    if (r.cqi != null && r.cqi < 55) {
      recs.push(`${r.label}: capture quality (CQI=${r.cqi}) was below the recommended gate threshold -- this task's measurements should be interpreted cautiously (check whether the gate was overridden).`);
    }
    if (r.taskId === "internal_rotation") {
      recs.push(`${r.label}: this task's underlying rotation proxy is documented as reliable mainly near ~90° elbow flexion, which a hand-behind-back posture does not match -- treat this grade as a rough indicator pending a future rotation-algorithm redesign (see docs/mallet-score.md §8).`);
    }
  }
  if (malletOverall?.status === "insufficient_data") {
    recs.push("Overall Modified Mallet Score could not be computed -- not enough tasks produced a valid grade. Review incomplete tasks above.");
  }
  return recs;
}

/**
 * @param {object} args
 * @param {object} args.session - {sessionId, patientLabel, side, createdAt, ...}
 * @param {object} args.taskResults - {taskId: taskResultEnvelope} (TaskResults.js shape, or the doctor-portal's stored equivalent)
 * @param {object|null} args.asriResult - shared/asri AsriEngine.score() output
 * @param {object|null} args.malletOverallResult - ModifiedMalletScoreEngine.scoreOverall() output
 * @param {object} [args.gradeOverrides] - {taskId: {clinicianGrade, overrideReason, clinicianName, createdAt}} (most recent version per task)
 * @param {object} [args.taskLabels] - {taskId: label} for display (from TaskDefinitions.js)
 * @param {object} [args.validationMetadata] - {malletScoreConfigVersion, icqaVersion, dmqeVersion, filterVersion, asriVersion}
 */
function generateMalletReport({ session, taskResults, asriResult = null, malletOverallResult = null, gradeOverrides = {}, taskLabels = {}, validationMetadata = {} }) {
  const taskRows = Object.entries(taskResults).map(([taskId, t]) => {
    const override = gradeOverrides[taskId] || null;
    const predictedGrade = t.malletGrade?.grade ?? null;
    const agreement =
      override && predictedGrade != null
        ? { agree: override.clinicianGrade === predictedGrade, differenceGrades: GRADE_NUMERIC[override.clinicianGrade] - GRADE_NUMERIC[predictedGrade] }
        : null;
    const row = {
      taskId,
      label: taskLabels[taskId] || taskId,
      predictedGrade,
      predictedStatus: t.malletGrade?.status ?? "unknown",
      predictedConfidence: t.malletGrade?.confidence ?? null,
      reasoning: t.malletGrade?.reasoning ?? null,
      clinicianGrade: override?.clinicianGrade ?? null,
      overrideReason: override?.overrideReason ?? null,
      overrideClinicianName: override?.clinicianName ?? null,
      overrideTimestamp: override?.createdAt ?? null,
      agreement,
      measurements: t.parameters,
      // The grade's own supportingMeasurements is the full merged set (core
      // biomechanics params + the new elbow/reach/vertebral/completion-time
      // proxies) actually used to derive the grade -- t.parameters alone
      // only has the former. See shared/assessment/ModifiedMalletScoreEngine.js's
      // score() output and shared/assessment/TaskRecorder.js's
      // measurementsForGrading for where this is assembled.
      malletMeasurements: t.malletGrade?.supportingMeasurements ?? null,
      cqi: t.cameraQuality?.cqi ?? null,
      dmqeScore: t.motionAnalysis?.dmqeScore ?? null,
    };
    return { ...row, chartData: buildTaskChartData(row) };
  });

  return {
    generatedAt: new Date().toISOString(),
    session: { sessionId: session.sessionId, patientLabel: session.patientLabel, side: session.side, createdAt: session.createdAt },
    taskRows,
    malletOverall: malletOverallResult,
    overallAgreement: summarizeAgreement(taskRows),
    asri: asriResult,
    validationMetadata,
    clinicalNotes: [],
    recommendations: buildRecommendations(taskRows, malletOverallResult),
    limitations: collectLimitations(taskResults),
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Modified Mallet Assessment Report — ${report.session.patientLabel || report.session.sessionId}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Session: ${report.session.sessionId} · ${report.session.side} side · captured ${report.session.createdAt}`);

  lines.push(`\n## Modified Mallet Score`);
  if (report.malletOverall?.status === "ok") {
    lines.push(`- Total score: ${report.malletOverall.totalScore} (${report.malletOverall.tasksGraded}/${report.malletOverall.tasksTotal} tasks graded)`);
    lines.push(`- Average grade: ${report.malletOverall.averageGrade} (~${report.malletOverall.averageGradeRoman})`);
    lines.push(`- Assessment confidence: ${report.malletOverall.assessmentConfidencePct}%`);
  } else {
    lines.push(`- insufficient data to compute an overall score`);
  }

  lines.push(`\n## Task-wise Results`);
  lines.push(`| Task | Predicted Grade | Confidence | Clinician Grade | Agreement | CQI | DMQE |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of report.taskRows) {
    const agree = r.agreement ? (r.agreement.agree ? "exact" : `Δ${r.agreement.differenceGrades}`) : "n/a";
    lines.push(`| ${r.label} | ${r.predictedGrade ?? "—"} | ${r.predictedConfidence ?? "—"}% | ${r.clinicianGrade ?? "—"} | ${agree} | ${fmt(r.cqi)} | ${fmt(r.dmqeScore)} |`);
  }
  for (const r of report.taskRows) {
    if (r.reasoning) lines.push(`\n*${r.label}: ${r.reasoning}*`);
  }

  lines.push(`\n## Clinician Agreement Summary`);
  if (report.overallAgreement.status === "ok") {
    lines.push(`- ${report.overallAgreement.n} task(s) reviewed by a clinician`);
    lines.push(`- Exact agreement: ${report.overallAgreement.exactAgreementPct}%`);
    lines.push(`- Mean absolute grade difference: ${report.overallAgreement.meanAbsoluteGradeDifference}`);
  } else {
    lines.push(`- No clinician overrides recorded yet`);
  }

  lines.push(`\n## ASRI (Adaptive Shoulder Recovery Index)`);
  if (report.asri?.composite != null) {
    lines.push(`- Composite: ${report.asri.composite} (95% CI ${report.asri.confidenceInterval?.low}–${report.asri.confidenceInterval?.high})`);
    lines.push(`- Overall confidence: ${report.asri.overallConfidencePct}%`);
  } else {
    lines.push(`- insufficient data`);
  }

  lines.push(`\n## Validation Metadata`);
  for (const [k, v] of Object.entries(report.validationMetadata || {})) lines.push(`- ${k}: ${v ?? "n/a"}`);

  if (report.clinicalNotes.length > 0) {
    lines.push(`\n## Clinical Notes`);
    for (const n of report.clinicalNotes) lines.push(`- ${n}`);
  }

  lines.push(`\n## Recommendations`);
  if (report.recommendations.length === 0) lines.push(`- none`);
  for (const r of report.recommendations) lines.push(`- ${r}`);

  lines.push(`\n## Limitations`);
  for (const l of report.limitations) lines.push(`- ${l}`);

  return lines.join("\n");
}

export { generateMalletReport, renderMarkdown };
