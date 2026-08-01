/**
 * pdf-renderer.js — PDF rendering for the combined Mallet report
 * ----------------------------------------------------------------------------
 * Lives here (backend/, CommonJS) rather than in shared/reporting/ (ESM)
 * because `pdfkit` is a Node-only dependency the browser-facing shared/*
 * modules don't otherwise need, and because Node's module resolution walks
 * UP from the importing file's own directory -- installing pdfkit only in
 * backend/node_modules would not resolve from a file under shared/reporting/,
 * which sits outside backend/'s ancestor chain. Consumes the EXACT same
 * structured object shared/reporting/report-generator.js's
 * generateMalletReport() produces (dynamically imported by server.js, same
 * as every other shared/* engine) -- one data source, two renderers
 * (Markdown + this), no logic duplicated between them.
 * ----------------------------------------------------------------------------
 */
const PDFDocument = require("pdfkit");

function fmt(n) {
  return n == null ? "n/a" : String(n);
}

/** Writes the Mallet/ASRI section shared by both the plain Mallet report and
 *  the fuller research report -- factored out so the two renderers can't
 *  drift apart on how they present the same underlying data. */
function writeMalletSection(doc, report) {
  doc.fontSize(18).text(report.reportType === "research" ? "Clinician Research Report" : "Modified Mallet Assessment Report", { continued: false });
  doc.fontSize(11).fillColor("#555").text(`${report.session.patientLabel || report.session.sessionId}`);
  doc.text(`Session ${report.session.sessionId} - ${report.session.side} side - captured ${report.session.createdAt}`);
  doc.text(`Generated ${report.generatedAt}`);
  doc.fillColor("#000").moveDown();

  doc.fontSize(14).text("Modified Mallet Score", { underline: true });
  doc.fontSize(11);
  if (report.malletOverall?.status === "ok") {
    doc.text(`Total score: ${report.malletOverall.totalScore}  (${report.malletOverall.tasksGraded}/${report.malletOverall.tasksTotal} tasks graded)`);
    doc.text(`Average grade: ${report.malletOverall.averageGrade} (~${report.malletOverall.averageGradeRoman})`);
    doc.text(`Assessment confidence: ${report.malletOverall.assessmentConfidencePct}%`);
  } else {
    doc.text("Insufficient data to compute an overall score.");
  }
  doc.moveDown();

  doc.fontSize(14).text("Task-wise Results", { underline: true });
  doc.fontSize(10);
  for (const r of report.taskRows) {
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#000").text(r.label, { continued: false, underline: false });
    doc.fontSize(10).fillColor("#333");
    const agree = r.agreement ? (r.agreement.agree ? "exact agreement" : `differs by ${r.agreement.differenceGrades}`) : "no clinician review yet";
    doc.text(`Predicted: ${r.predictedGrade ?? "n/a"} (confidence ${r.predictedConfidence ?? "n/a"}%)   Clinician: ${r.clinicianGrade ?? "n/a"}   Agreement: ${agree}`);
    doc.text(`CQI: ${fmt(r.cqi)}   DMQE score: ${fmt(r.dmqeScore)}`);
    if (r.reasoning) doc.fontSize(9).fillColor("#555").text(r.reasoning);
    doc.fillColor("#000");
  }
  doc.moveDown();

  doc.fontSize(14).text("Clinician Agreement Summary", { underline: true });
  doc.fontSize(10);
  if (report.overallAgreement.status === "ok") {
    doc.text(`${report.overallAgreement.n} task(s) reviewed - exact agreement ${report.overallAgreement.exactAgreementPct}% - mean absolute grade difference ${report.overallAgreement.meanAbsoluteGradeDifference}`);
  } else {
    doc.text("No clinician overrides recorded yet.");
  }
  doc.moveDown();

  doc.fontSize(14).text("ASRI (Adaptive Shoulder Recovery Index)", { underline: true });
  doc.fontSize(10);
  if (report.asri?.composite != null) {
    doc.text(`Composite: ${report.asri.composite}  (95% CI ${report.asri.confidenceInterval?.low}-${report.asri.confidenceInterval?.high})`);
    doc.text(`Overall confidence: ${report.asri.overallConfidencePct}%`);
  } else {
    doc.text("Insufficient data.");
  }
  doc.moveDown();

  if (report.recommendations.length > 0) {
    doc.fontSize(14).text("Recommendations", { underline: true });
    doc.fontSize(10);
    for (const rec of report.recommendations) doc.text(`- ${rec}`);
    doc.moveDown();
  }
}

/** Streams a PDF rendering of `report` (report-generator.js's structured
 *  object) directly to `res` (an Express response). */
function renderMalletReportPdf(report, res) {
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);
  writeMalletSection(doc, report);
  doc.fontSize(14).text("Limitations", { underline: true });
  doc.fontSize(9).fillColor("#555");
  for (const l of report.limitations) doc.text(`- ${l}`);
  doc.end();
}

/**
 * Streams the fuller Phase 9 research report: everything renderMalletReportPdf
 * covers, PLUS the Clinician Assessment Panel, AI-vs-Clinician comparison,
 * full override history, a vector-drawn joint-angle chart (using the SAME
 * coordinate math shared/joint-angle-chart.js's on-screen SVG chart uses,
 * via shared/reporting/chart-geometry.js -- so the printed chart can't
 * silently show different shapes than what the clinician saw on screen),
 * representative capture photos (pdfkit's own doc.image(), never used in
 * this codebase before this phase), and research metadata.
 *
 * @param {object} report - generateResearchReport()'s structured object
 * @param {import("express").Response} res
 * @param {object} [options]
 * @param {Array<object>|null} [options.angleSeries] - one task's angle-timeseries frames, optional
 * @param {Array<{label:string, filePath:string}>} [options.taskPhotos] - representative capture photos, optional
 */
async function renderResearchReportPdf(report, res, { angleSeries = null, taskPhotos = [] } = {}) {
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  writeMalletSection(doc, report);

  doc.addPage();
  doc.fontSize(14).text("Clinician Assessment Panel", { underline: true });
  doc.fontSize(10);
  if (report.clinicianAssessmentPanel) {
    const c = report.clinicianAssessmentPanel;
    doc.text(`Clinician: ${c.clinicianName}   Date: ${c.assessmentDate}`);
    doc.text(`Overall assessment: ${c.overallAssessment ?? "n/a"}`);
    doc.text(`Compensation severity: ${c.compensationSeverity ?? "n/a"}   Clinician confidence: ${c.clinicianConfidencePct ?? "n/a"}%`);
    doc.text(`Recommendation: ${c.clinicianRecommendation ?? "n/a"}`);
    if (c.notes) doc.text(`Notes: ${c.notes}`);
  } else {
    doc.text("No clinician assessment recorded for this session yet.");
  }
  doc.moveDown();

  doc.fontSize(14).text("AI vs Clinician Comparison", { underline: true });
  doc.fontSize(9);
  if (report.comparison.rows.length === 0) doc.text("No comparable clinician-entered values yet.");
  for (const row of report.comparison.rows) {
    const flag = row.agreementStatus === "disagree" ? "  [DISAGREEMENT]" : "";
    doc.fillColor(row.agreementStatus === "disagree" ? "#b91c1c" : "#000");
    doc.text(`${row.field}${row.taskId ? ` (${row.taskId})` : ""}: AI=${fmt(row.aiValue)}  Clinician=${fmt(row.clinicianValue)}${flag}`);
  }
  doc.fillColor("#000").moveDown();

  doc.fontSize(14).text("Override History", { underline: true });
  doc.fontSize(9);
  if (report.overrideHistory.length === 0) {
    doc.text("No overrides recorded for this session.");
  } else {
    for (const o of report.overrideHistory) {
      doc.text(`${o.createdAt}  ${o.field}${o.taskId ? ` (${o.taskId})` : ""}: ${fmt(o.originalValue)} -> ${fmt(o.overriddenValue)}  by ${o.reviewer}${o.reason ? ` -- ${o.reason}` : ""}`);
    }
  }
  doc.moveDown();

  if (angleSeries && angleSeries.length > 1) {
    const { computeLineChartPoints } = await import("../shared/reporting/chart-geometry.js");
    doc.addPage();
    doc.fontSize(14).text("Joint Angle Over Time", { underline: true });
    const chartWidth = 480;
    const chartHeight = 200;
    const originX = doc.x;
    const originY = doc.y + 10;
    const seriesDefs = [
      { key: "shoulderAbductionDeg", label: "Abduction", color: "#2563eb" },
      { key: "externalRotationDeg", label: "External Rotation", color: "#16a34a" },
      { key: "internalRotationDeg", label: "Internal Rotation", color: "#dc2626" },
    ];
    for (const def of seriesDefs) {
      const series = angleSeries.map((f) => ({ tSec: f.tSec, value: f[def.key]?.value ?? null }));
      const { points } = computeLineChartPoints({ series, width: chartWidth, height: chartHeight });
      if (points.length < 2) continue;
      doc.moveTo(originX + points[0].x, originY + points[0].y);
      for (const p of points.slice(1)) doc.lineTo(originX + p.x, originY + p.y);
      doc.strokeColor(def.color).lineWidth(1.5).stroke();
    }
    let legendY = originY + chartHeight + 10;
    doc.fontSize(9);
    for (const def of seriesDefs) {
      doc.fillColor(def.color).text("—— ", originX, legendY, { continued: true });
      doc.fillColor("#000").text(def.label);
      legendY += 12;
    }
    doc.fillColor("#000");
  }

  if (taskPhotos.length > 0) {
    doc.addPage();
    doc.fontSize(14).text("Capture Images", { underline: true });
    for (const photo of taskPhotos) {
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor("#000").text(photo.label);
      try {
        doc.image(photo.filePath, { width: 200 });
      } catch {
        doc.fontSize(9).fillColor("#999").text("(image could not be loaded)");
        doc.fillColor("#000");
      }
    }
  }

  doc.addPage();
  doc.fontSize(14).text("Research Metadata", { underline: true });
  doc.fontSize(10);
  doc.text(`Protocol: ${report.researchMetadata?.protocol ?? "n/a"}`);
  const memberships = report.researchMetadata?.studyMemberships || [];
  doc.text(`Study memberships: ${memberships.length ? memberships.map((s) => `${s.name} (${s.status})`).join(", ") : "none"}`);
  doc.text(`Audit entries for this session: ${report.auditSummary?.totalEntries ?? 0}`);
  doc.moveDown();

  doc.fontSize(14).text("Limitations", { underline: true });
  doc.fontSize(9).fillColor("#555");
  for (const l of report.limitations) doc.text(`- ${l}`);

  doc.end();
}

/** Draws a plain array-of-objects table as text lines (column headers +
 *  one line per row, tab-separated-looking via fixed-width padding) --
 *  same lightweight "text table" convention writeMalletSection() already
 *  uses elsewhere in this file, not a fresh table-drawing system. */
function writeTextTable(doc, { columns, rows }) {
  doc.fontSize(8).fillColor("#333");
  doc.text(columns.join("  |  "));
  doc.fontSize(8).fillColor("#000");
  for (const row of rows) {
    doc.text(columns.map((c) => String(row[c] ?? "n/a")).join("  |  "));
  }
  if (rows.length === 0) doc.fillColor("#999").text("(no data)").fillColor("#000");
}

/**
 * Streams the Phase 10 Clinical Validation report: participant/methods
 * summary, the structured readiness classification (printed prominently,
 * first thing after the title -- not buried at the end), all 7 discrete
 * publication tables, per-parameter Bland-Altman + AI-vs-clinician scatter
 * figures, the Modified Mallet confusion matrix (as both a text grid and a
 * color-graded heatmap), distribution histograms, repeatability results,
 * and limitations/future work.
 *
 * Establishes this codebase's first doc.circle() (scatter/Bland-Altman
 * points) and doc.rect() (histogram bars, heatmap cells) usage in pdfkit --
 * previously every PDF renderer here only used doc.moveTo/lineTo/stroke
 * (line charts) and doc.text(). Scatter/histogram geometry comes from the
 * SAME shared/reporting/chart-geometry.js functions
 * shared/research-charts.js's on-screen SVG versions use (computeScatterPoints/
 * computeHistogramBins), so the printed figures can't disagree with what a
 * researcher saw live in validation-portal.
 *
 * @param {object} result - the FULL runValidation() output (as stored in
 *   validation_reports.report_json), not just its inner `.report` field.
 * @param {import("express").Response} res
 */
async function renderValidationReportPdf(result, res) {
  const { computeScatterPoints, computeHistogramBins } = await import("../shared/reporting/chart-geometry.js");
  const { report, comparisonResults, repeatabilityResults, malletAgreement, publicationTables, pilotStudySummary } = result;

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  doc.fontSize(18).text("Clinical Validation Report");
  doc.fontSize(11).fillColor("#555").text(report.datasetName);
  doc.text(`Generated ${report.generatedAt}`);
  if (report.isPreliminary) doc.fillColor("#b45309").text(`PRELIMINARY -- sample size below the recommended minimum (n=${report.recommendedMinN}).`);
  doc.fillColor("#000").moveDown();

  // Readiness classification -- printed prominently, right after the title,
  // per this phase's explicit ethical-reporting requirement.
  doc.fontSize(14).text("Readiness Classification", { underline: true });
  doc.fontSize(10);
  const r = pilotStudySummary.readiness;
  for (const [label, entry] of [
    ["Engineering Verification", r.engineeringVerification],
    ["Clinical Validation", r.clinicalValidation],
    ["Clinical Deployment", r.clinicalDeployment],
  ]) {
    doc.font("Helvetica-Bold").text(`${label}: ${entry.status.replaceAll("_", " ")}`);
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(entry.reason);
    doc.fontSize(10).fillColor("#000").moveDown(0.3);
  }
  doc.moveDown();

  doc.fontSize(14).text("Participants & Methods", { underline: true });
  doc.fontSize(9);
  doc.text(`Unique patients: ${report.participants.uniquePatients}  |  Sessions: ${report.participants.totalSessions}  |  Assessments: ${report.participants.totalAssessments}`);
  doc.text(report.methods);
  doc.moveDown();

  doc.addPage();
  doc.fontSize(14).text("Publication Tables", { underline: true });
  for (const table of Object.values(publicationTables)) {
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#000").text(table.tableName);
    writeTextTable(doc, table);
  }

  doc.addPage();
  doc.fontSize(14).text("Agreement Figures (Bland-Altman & AI vs Clinician)", { underline: true });
  for (const [paramKey, r2] of Object.entries(comparisonResults)) {
    if (!r2.pairs?.length) continue;
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#000").text(paramKey);
    doc.fontSize(9).fillColor("#333");
    doc.text(`n=${r2.n}  Pearson r=${fmt(r2.pearsonR)}  ICC(2,1)=${fmt(r2.icc2_1?.value)} (${r2.icc2_1?.interpretation ?? "n/a"})  MAE=${fmt(r2.mae)}  RMSE=${fmt(r2.rmse)}`);

    if (r2.blandAltman?.points?.length) {
      const chartW = 220;
      const chartH = 140;
      const originX = doc.x;
      const originY = doc.y + 6;
      const scatterGeom = computeScatterPoints({ points: r2.blandAltman.points, width: chartW, height: chartH });
      for (const p of scatterGeom.points) {
        doc.circle(originX + p.x, originY + p.y, 2).fillColor("#2FA8A0").fill();
      }
      const biasY = originY + scatterGeom.yScale(r2.blandAltman.bias);
      doc.moveTo(originX + scatterGeom.margin.left, biasY).lineTo(originX + scatterGeom.margin.left + scatterGeom.innerWidth, biasY).strokeColor("#2FA8A0").lineWidth(1).stroke();
      doc.fontSize(7).fillColor("#555").text(`Bland-Altman: bias=${fmt(r2.blandAltman.bias)}, LoA=[${fmt(r2.blandAltman.lowerLoA)}, ${fmt(r2.blandAltman.upperLoA)}]`, originX, originY + chartH + 4);
    }
    doc.fillColor("#000").moveDown(1);
  }

  if (malletAgreement.confusionMatrix) {
    doc.addPage();
    doc.fontSize(14).text("Modified Mallet Confusion Matrix", { underline: true });
    doc.fontSize(9);
    const pa = malletAgreement.percentAgreement;
    const kappa = malletAgreement.weightedKappa;
    doc.text(`Exact agreement: ${pa?.exactMatchPct ?? "n/a"}%  |  Within 1 grade: ${pa?.within1GradePct ?? "n/a"}%  |  Weighted kappa: ${fmt(kappa?.value)} (${kappa?.interpretation ?? "n/a"})`);
    doc.moveDown(0.5);

    const { grades, matrix } = malletAgreement.confusionMatrix;
    const maxCount = Math.max(...matrix.flat(), 1);
    const cellSize = 26;
    const originX = doc.x + 40;
    const originY = doc.y + 20;
    doc.fontSize(7);
    grades.forEach((g, col) => doc.text(g, originX + col * cellSize + 8, originY - 12));
    for (let row = 0; row < grades.length; row++) {
      doc.text(grades[row], originX - 14, originY + row * cellSize + 8);
      for (let col = 0; col < grades.length; col++) {
        const count = matrix[row][col];
        const alpha = count === 0 ? 0.05 : 0.15 + 0.75 * (count / maxCount);
        doc.rect(originX + col * cellSize, originY + row * cellSize, cellSize - 2, cellSize - 2).fillColor("#2FA8A0").fillOpacity(alpha).fill();
        doc.fillOpacity(1).fillColor(alpha > 0.55 ? "#fff" : "#000").fontSize(8).text(String(count), originX + col * cellSize + 8, originY + row * cellSize + 8);
      }
    }
    doc.fillColor("#000").fillOpacity(1);
    doc.y = originY + grades.length * cellSize + 20;
  }

  doc.addPage();
  doc.fontSize(14).text("Distributions", { underline: true });
  for (const [paramKey, r2] of Object.entries(comparisonResults)) {
    const values = r2.pairs?.map((p) => p.appValue).filter((v) => v != null) ?? [];
    const geom = computeHistogramBins({ values, binCount: 8, width: 220, height: 100 });
    if (!geom) continue;
    doc.fontSize(10).fillColor("#000").text(paramKey, { continued: false });
    const originX = doc.x;
    const originY = doc.y + 4;
    for (const b of geom.bins) {
      if (b.height > 0) doc.rect(originX + b.x - geom.margin.left, originY + b.y - geom.margin.top, Math.max(0, b.width), b.height).fillColor("#2FA8A0").fill();
    }
    doc.fillColor("#000");
    doc.y = originY + geom.innerHeight + 14;
  }

  doc.addPage();
  doc.fontSize(14).text("Repeatability", { underline: true });
  doc.fontSize(9);
  for (const [paramKey, p] of Object.entries(repeatabilityResults.betweenSession.perParameter || {})) {
    if (p.n >= 2) {
      doc.text(`${paramKey}: n=${p.n}  mean diff=${fmt(p.meanDifference)}  SD=${fmt(p.diffSd)}  CoV=${fmt(p.coefficientOfVariationPct)}%  Repeatability Coefficient=${fmt(p.repeatabilityCoefficient)}`);
    } else {
      doc.fillColor("#999").text(`${paramKey}: ${p.note}`).fillColor("#000");
    }
  }
  doc.fillColor("#b45309").fontSize(8).text(`Within-session repeatability: ${repeatabilityResults.withinSession.reason}`);
  doc.fillColor("#000");
  doc.moveDown();

  doc.fontSize(14).text("Limitations & Future Work", { underline: true });
  doc.fontSize(9).fillColor("#555");
  for (const l of pilotStudySummary.limitations) doc.text(`- ${l}`);
  doc.moveDown(0.5).fontSize(9).fillColor("#333").text("Future work:");
  for (const f of pilotStudySummary.futureWork) doc.fillColor("#555").text(`- ${f}`);

  doc.end();
}

module.exports = { renderMalletReportPdf, renderResearchReportPdf, renderValidationReportPdf };
