/**
 * report-generator.js — Part 10: Research Report Generator
 * ----------------------------------------------------------------------------
 * Assembles comparison, reliability, calibration, and QC results into a
 * structured report (participant characteristics, methods/results text,
 * tables, limitations, discussion points) plus a Markdown rendering.
 *
 * With the current zero-real-paired-data reality, this MUST produce an
 * honest "preliminary, not publication-ready" framing rather than a
 * dressed-up table -- verified in scripts/verify-validation.mjs.
 * ----------------------------------------------------------------------------
 */

// Conventional minimum sample size for a reasonably stable ICC/correlation
// point estimate at typical (0.80) power for a moderate expected effect --
// standard textbook guidance (see docs/validation.md), not a project-
// specific claim about this app's actual required n.
const RECOMMENDED_MIN_N = 30;

function fmt(n) {
  return n == null ? "n/a" : (Math.round(n * 1000) / 1000).toString();
}

function summarizeParticipants(sessions, assessments) {
  const hospitalIds = new Set(sessions.map((s) => s.hospitalId).filter(Boolean));
  const ages = assessments.map((a) => a.age).filter((v) => v != null);
  const sexCounts = {};
  for (const a of assessments) if (a.sex) sexCounts[a.sex] = (sexCounts[a.sex] || 0) + 1;
  const sideCounts = {};
  for (const s of sessions) sideCounts[s.side] = (sideCounts[s.side] || 0) + 1;

  return {
    uniquePatients: hospitalIds.size,
    totalSessions: sessions.length,
    totalAssessments: assessments.length,
    ageRangeMonths: ages.length ? [Math.min(...ages), Math.max(...ages)] : null,
    ageMeanMonths: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
    sexCounts,
    sideCounts,
  };
}

/**
 * @param {object} args
 * @param {Array} args.sessions
 * @param {Array} args.assessments
 * @param {object} args.comparisonResults - comparison-engine.js's runComparison() output
 * @param {object} args.reliabilityResults - {testRetest, interRater, intraRater}
 * @param {object} args.calibrationReport - calibration-advisor.js output
 * @param {object} args.qcResults - quality-control.js output
 * @param {string} [args.datasetName]
 */
function generateValidationReport({ sessions, assessments, comparisonResults, reliabilityResults, calibrationReport, qcResults, datasetName = "all sessions" }) {
  const participants = summarizeParticipants(sessions, assessments);
  const pairedN = Math.max(0, ...Object.values(comparisonResults).map((r) => r.n));
  const isPreliminary = participants.uniquePatients < RECOMMENDED_MIN_N || pairedN < RECOMMENDED_MIN_N;

  const limitations = [
    "This is a research prototype, not a cleared or CE-marked medical device -- see docs/validation.md regulatory considerations.",
    "Monocular RGB pose estimation (Phase 1) has documented limitations for rotation and scapular parameters (see docs/biomechanics.md); these are treated as estimated, not measured, throughout.",
    isPreliminary
      ? `Sample size (n=${pairedN} paired measurements across ${participants.uniquePatients} unique patient${participants.uniquePatients === 1 ? "" : "s"}) is below the recommended minimum (n=${RECOMMENDED_MIN_N}) for reliable correlation/ICC estimates. **All statistics in this report are PRELIMINARY, not publication-ready.**`
      : null,
    qcResults.bySeverity.error > 0 ? `${qcResults.bySeverity.error} data-quality error(s) were detected (see Quality Control) and should be resolved before drawing any conclusion.` : null,
  ].filter(Boolean);

  const methods =
    `Shoulder range-of-motion measurements from ${participants.uniquePatients} patient(s) across ${participants.totalSessions} capture session(s) were compared against ${participants.totalAssessments} clinician assessment(s). ` +
    `App measurements were produced by a monocular RGB smartphone-camera pose-estimation pipeline (MediaPipe Pose + a custom biomechanical engine; see docs/biomechanics.md) -- no marker-based motion-capture reference was used. ` +
    `Agreement was assessed per parameter (not as a single blended score) via Pearson and Spearman correlation, intraclass correlation coefficients (ICC(2,1) for absolute agreement, ICC(3,1) for consistency; Shrout & Fleiss 1979, McGraw & Wong 1996), Bland-Altman bias and 95% limits of agreement (Bland & Altman 1986, 1999), and mean absolute/root-mean-square error.`;

  const resultsTable = Object.entries(comparisonResults).map(([key, r]) => ({
    parameter: key,
    n: r.n,
    pearsonR: r.pearsonR,
    spearmanRho: r.spearmanRho,
    icc2_1: r.icc2_1?.value ?? null,
    icc2_1_interpretation: r.icc2_1?.interpretation ?? null,
    icc3_1: r.icc3_1?.value ?? null,
    mae: r.mae,
    rmse: r.rmse,
    bias: r.bias,
    limitsOfAgreement: r.blandAltman ? [r.blandAltman.lowerLoA, r.blandAltman.upperLoA] : null,
    note: r.note,
  }));

  const discussionPoints = [
    "Report each parameter's validity separately -- gross ROM (abduction/flexion) and estimated parameters (rotation) carry different expected reliability per this project's own biomechanical documentation and must not be summarized into one number.",
    calibrationReport.recommendations.some((r) => r.status === "poor")
      ? "One or more parameters showed poor agreement (ICC(2,1)<0.5, Koo & Li 2016) -- see Calibration Recommendations before any clinical claim about that parameter."
      : null,
    resultsTable.some((r) => r.icc2_1 != null && r.icc3_1 != null && r.icc3_1 - r.icc2_1 > 0.15)
      ? "A notable gap between ICC(3,1) (consistency) and ICC(2,1) (absolute agreement) for at least one parameter suggests a systematic bias between the app and clinician measurements, not just random disagreement -- worth investigating directionally (does the app over- or under-estimate?) via the Bland-Altman bias figure."
      : null,
  ].filter(Boolean);

  return {
    generatedAt: new Date().toISOString(),
    datasetName,
    isPreliminary,
    recommendedMinN: RECOMMENDED_MIN_N,
    participants,
    methods,
    resultsTable,
    reliability: reliabilityResults,
    calibration: calibrationReport,
    qualityControl: qcResults,
    limitations,
    discussionPoints,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Validation Report — ${report.datasetName}`);
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.isPreliminary) {
    lines.push(`\n> **PRELIMINARY RESULTS** — sample size is below the recommended minimum (n=${report.recommendedMinN}). These statistics are not publication-ready. See Limitations.`);
  }

  lines.push(`\n## Participant Characteristics`);
  lines.push(`- Unique patients: ${report.participants.uniquePatients}`);
  lines.push(`- Total sessions: ${report.participants.totalSessions}`);
  lines.push(`- Total clinician assessments: ${report.participants.totalAssessments}`);
  if (report.participants.ageRangeMonths) {
    lines.push(`- Age range: ${report.participants.ageRangeMonths[0]}–${report.participants.ageRangeMonths[1]} months (mean ${fmt(report.participants.ageMeanMonths)})`);
  }
  lines.push(`- Sex: ${JSON.stringify(report.participants.sexCounts)}`);
  lines.push(`- Side tested: ${JSON.stringify(report.participants.sideCounts)}`);

  lines.push(`\n## Methods`);
  lines.push(report.methods);

  lines.push(`\n## Results`);
  lines.push(`| Parameter | n | Pearson r | Spearman ρ | ICC(2,1) | ICC(3,1) | MAE | RMSE | Bias | 95% LoA |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const row of report.resultsTable) {
    const loa = row.limitsOfAgreement ? `[${fmt(row.limitsOfAgreement[0])}, ${fmt(row.limitsOfAgreement[1])}]` : "n/a";
    lines.push(`| ${row.parameter} | ${row.n} | ${fmt(row.pearsonR)} | ${fmt(row.spearmanRho)} | ${fmt(row.icc2_1)} (${row.icc2_1_interpretation ?? "n/a"}) | ${fmt(row.icc3_1)} | ${fmt(row.mae)} | ${fmt(row.rmse)} | ${fmt(row.bias)} | ${loa} |`);
  }
  for (const row of report.resultsTable) {
    if (row.note) lines.push(`\n*${row.parameter}: ${row.note}*`);
  }

  lines.push(`\n## Reliability`);
  for (const [type, result] of Object.entries(report.reliability || {})) {
    lines.push(`### ${type}`);
    lines.push(`Groups found: ${result?.groupsFound ?? result?.sessionsWithMultipleRaters ?? 0}`);
  }

  lines.push(`\n## Calibration Recommendations`);
  for (const rec of report.calibration.recommendations) {
    lines.push(`- **${rec.parameter}** (${rec.status}): ${rec.message}`);
  }

  lines.push(`\n## Quality Control`);
  lines.push(`Total issues: ${report.qualityControl.totalIssues} (${report.qualityControl.bySeverity.error} errors, ${report.qualityControl.bySeverity.warning} warnings, ${report.qualityControl.bySeverity.info} info)`);

  lines.push(`\n## Limitations`);
  for (const l of report.limitations) lines.push(`- ${l}`);

  lines.push(`\n## Discussion Points`);
  for (const d of report.discussionPoints) lines.push(`- ${d}`);

  return lines.join("\n");
}

export { generateValidationReport, renderMarkdown, summarizeParticipants, RECOMMENDED_MIN_N };
