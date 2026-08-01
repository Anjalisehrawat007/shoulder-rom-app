/**
 * validation-portal/app.js — Clinical Validation Engine UI
 * ----------------------------------------------------------------------------
 * Talks to the /api/clinician-assessments, /api/validation-datasets, and
 * /api/validation/* endpoints (backend/server.js) directly via fetch --
 * doesn't reuse shared/api-storage.js since that's scoped to the capture-
 * session flow (capture token / access code), a different auth model than
 * this internal research tool has (none, currently -- see docs/validation.md).
 *
 * Phase 10: new panels (Repeatability, Mallet Confusion Matrix, Distributions,
 * Publication Tables, Pilot Study Summary) added to renderValidationResults()
 * below, reading the new sections runValidation() now returns
 * (repeatabilityResults/malletAgreement/publicationTables/pilotStudySummary).
 * renderBlandAltmanChart is untouched (already correct).
 * ----------------------------------------------------------------------------
 */
import { renderScatterChart, renderHistogramChart, renderHeatmapChart } from "../shared/research-charts.js";

// ---- tabs -------------------------------------------------------------------
function initTabs() {
  const buttons = document.querySelectorAll(".tabs .btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".shell > section[id^='tab-']").forEach((s) => s.classList.add("hidden"));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
      if (btn.dataset.tab === "datasets") loadDatasets();
      if (btn.dataset.tab === "validation") loadDatasetOptions();
      if (btn.dataset.tab === "reports") loadReports();
    });
  });
}

async function api(path, opts = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

// ---- New Assessment -----------------------------------------------------------
async function submitAssessment() {
  const val = (id) => document.getElementById(id).value.trim();
  const num = (id) => (val(id) ? Number(val(id)) : null);

  const malletScore = {
    globalAbduction: num("a_mallet_abd"),
    globalExternalRotation: num("a_mallet_er"),
    handToNeck: num("a_mallet_neck"),
    handToSpine: num("a_mallet_spine"),
    handToMouth: num("a_mallet_mouth"),
  };
  let otherScores = null;
  if (val("a_otherScores")) {
    try {
      otherScores = JSON.parse(val("a_otherScores"));
    } catch {
      document.getElementById("assessmentStatus").textContent = "Other scores must be valid JSON.";
      return;
    }
  }

  const payload = {
    sessionId: val("a_sessionId"),
    hospitalId: val("a_sessionId"),
    assessmentDate: val("a_assessmentDate"),
    affectedSide: val("a_side"),
    age: num("a_age"),
    sex: val("a_sex"),
    monthsSinceSurgery: num("a_monthsSinceSurgery"),
    clinicianName: val("a_clinicianName"),
    hospital: val("a_hospital"),
    shoulderAbduction: num("a_shoulderAbduction"),
    shoulderFlexion: num("a_shoulderFlexion"),
    externalRotation: num("a_externalRotation"),
    internalRotation: num("a_internalRotation"),
    rom: num("a_rom"),
    malletScore: Object.values(malletScore).some((v) => v != null) ? malletScore : null,
    amsScore: num("a_ams"),
    otherScores,
    notes: val("a_notes"),
  };

  try {
    const result = await api("/api/clinician-assessments", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("assessmentStatus").textContent = `Saved (id=${result.id}, version=${result.version}).`;
  } catch (e) {
    document.getElementById("assessmentStatus").textContent = `Error: ${e.message}`;
  }
}

// ---- Datasets -----------------------------------------------------------------
async function createDataset() {
  const name = document.getElementById("d_name").value.trim();
  const type = document.getElementById("d_type").value;
  if (!name) return;
  try {
    await api("/api/validation-datasets", { method: "POST", body: JSON.stringify({ name, type }) });
    document.getElementById("datasetStatus").textContent = "Dataset created.";
    document.getElementById("d_name").value = "";
    loadDatasets();
  } catch (e) {
    document.getElementById("datasetStatus").textContent = `Error: ${e.message}`;
  }
}

async function loadDatasets() {
  const { datasets } = await api("/api/validation-datasets");
  const container = document.getElementById("datasetList");
  container.innerHTML = datasets.length
    ? `<table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Created</th></tr></thead><tbody>${datasets
        .map((d) => `<tr><td>${d.name}</td><td>${d.type}</td><td>${new Date(d.created_at).toLocaleDateString()}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p style="color:var(--slate); font-size:13px;">No datasets yet.</p>`;
}

async function loadDatasetOptions() {
  const { datasets } = await api("/api/validation-datasets");
  const select = document.getElementById("v_datasetId");
  select.innerHTML = `<option value="">All sessions</option>` + datasets.map((d) => `<option value="${d.id}">${d.name} (${d.type})</option>`).join("");
}

// ---- Run Validation / Dashboard ------------------------------------------------
async function runValidationClick() {
  const datasetId = document.getElementById("v_datasetId").value || null;
  const container = document.getElementById("validationResults");
  container.innerHTML = `<p style="color:var(--slate);">Running…</p>`;
  try {
    const result = await api("/api/validation/run", { method: "POST", body: JSON.stringify({ datasetId: datasetId ? Number(datasetId) : null }) });
    renderValidationResults(result);
  } catch (e) {
    container.innerHTML = `<p class="flag">Error: ${e.message}</p>`;
  }
}

function badgeClassFor(measurementType) {
  if (measurementType === "measured") return "measured";
  if (measurementType === "estimated") return "estimated";
  return "unavailable";
}

function renderValidationResults(result) {
  const { report, comparisonResults, reliabilityResults, calibrationReport, qcResults, repeatabilityResults, malletAgreement, publicationTables, pilotStudySummary } = result;
  const container = document.getElementById("validationResults");
  container.innerHTML = "";

  // Summary banner
  const banner = document.createElement("div");
  banner.className = "panel score-banner";
  banner.innerHTML = `
    <div>
      <div class="eyebrow">${report.datasetName}</div>
      <div style="color:var(--slate); font-size:13px;">${report.participants.uniquePatients} patient(s) · ${report.participants.totalSessions} session(s) · ${report.participants.totalAssessments} assessment(s)</div>
      ${report.isPreliminary ? `<div class="flag" style="margin-top:6px;">⚠ PRELIMINARY — sample size below recommended minimum (n=${report.recommendedMinN})</div>` : ""}
    </div>
    <div style="text-align:right;">
      <div class="big">${result.pairedSessionCount}</div>
      <div class="readout" style="font-size:12px; color:var(--slate);">paired session(s)</div>
    </div>
  `;
  container.appendChild(banner);

  // Per-parameter comparison panels (with Bland-Altman charts)
  for (const [paramKey, r] of Object.entries(comparisonResults)) {
    const panel = document.createElement("details");
    panel.className = "panel category-panel";
    const iccText = r.icc2_1 ? `ICC(2,1)=${r.icc2_1.value?.toFixed(2)} (${r.icc2_1.interpretation})` : "ICC n/a";
    panel.innerHTML = `
      <summary>
        <span>${paramKey}</span>
        <span><span class="cat-score">n=${r.n}</span><span class="cat-confidence">${iccText}</span></span>
      </summary>
      ${r.note ? `<p style="color:var(--amber); font-size:12px; margin-top:8px;">${r.note}</p>` : ""}
      <div class="card-row" style="margin-top:12px;">
        <div>
          <table class="contrib-table">
            <thead><tr><th>Stat</th><th>Value</th></tr></thead>
            <tbody>
              <tr><td>Pearson r (95% CI)</td><td>${fmt(r.pearsonR)} ${r.pearsonR95CI ? `[${fmt(r.pearsonR95CI.low)}, ${fmt(r.pearsonR95CI.high)}]` : ""}</td></tr>
              <tr><td>Spearman ρ</td><td>${fmt(r.spearmanRho)}</td></tr>
              <tr><td>ICC(2,1) — absolute agreement (bootstrap 95% CI)</td><td>${fmt(r.icc2_1?.value)} ${r.icc2_1?.ci ? `[${fmt(r.icc2_1.ci.low)}, ${fmt(r.icc2_1.ci.high)}]` : ""} (${r.icc2_1?.interpretation ?? "n/a"})</td></tr>
              <tr><td>ICC(3,1) — consistency</td><td>${fmt(r.icc3_1?.value)} (${r.icc3_1?.interpretation ?? "n/a"})</td></tr>
              <tr><td>MAE</td><td>${fmt(r.mae)}°</td></tr>
              <tr><td>RMSE</td><td>${fmt(r.rmse)}°</td></tr>
              <tr><td>Bias (95% CI)</td><td>${fmt(r.bias)}° ${r.confidenceInterval95 ? `[${fmt(r.confidenceInterval95.low)}, ${fmt(r.confidenceInterval95.high)}]` : ""}</td></tr>
              <tr><td>Within ±${r.withinTolerancePct.toleranceDeg}°</td><td>${fmt(r.withinTolerancePct.value)}%</td></tr>
              <tr><td>Recommended statistic</td><td>${r.recommendedStatistic.statistic} — ${r.recommendedStatistic.reason}</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <div class="chart-title">Bland-Altman</div>
          <div id="ba-${paramKey}"></div>
        </div>
        <div>
          <div class="chart-title">AI vs Clinician</div>
          <div id="scatter-${paramKey}"></div>
        </div>
      </div>
    `;
    container.appendChild(panel);
    if (r.blandAltman) renderBlandAltmanChart(panel.querySelector(`#ba-${paramKey}`), r.blandAltman);
    if (r.pairs?.length) renderScatterChart(panel.querySelector(`#scatter-${paramKey}`), r.pairs.map((p) => ({ x: p.appValue, y: p.clinicianValue })), { xLabel: "AI (deg)", yLabel: "Clinician (deg)" });
  }

  // Reliability
  const relPanel = document.createElement("details");
  relPanel.className = "panel category-panel";
  relPanel.innerHTML = `<summary><span>Reliability</span><span class="cat-confidence">test-retest / inter-rater / intra-rater</span></summary>` + renderReliabilityTable(reliabilityResults);
  container.appendChild(relPanel);

  // Calibration
  const calPanel = document.createElement("details");
  calPanel.className = "panel category-panel";
  calPanel.innerHTML = `<summary><span>Calibration Recommendations</span><span class="cat-confidence">${calibrationReport.recommendations.length} parameter(s)</span></summary>
    <ul style="font-size:12px; margin-top:10px; padding-left:18px;">
      ${calibrationReport.recommendations.map((rec) => `<li style="margin-bottom:6px;"><strong>${rec.parameter}</strong> (${rec.status}): ${rec.message}</li>`).join("")}
    </ul>
    <p style="color:var(--slate); font-size:11px; margin-top:8px;">${calibrationReport.disclaimer}</p>`;
  container.appendChild(calPanel);

  // Quality control
  const excludedSessions = Object.entries(qcResults.exclusionRecommendations || {}).filter(([, e]) => e.excludeFromAnalysis);
  const qcPanel = document.createElement("details");
  qcPanel.className = "panel category-panel";
  qcPanel.innerHTML = `<summary><span>Quality Control</span><span class="cat-confidence">${qcResults.totalIssues} issue(s): ${qcResults.bySeverity.error} error, ${qcResults.bySeverity.warning} warning, ${qcResults.bySeverity.info} info</span></summary>
    ${excludedSessions.length ? `<p class="flag" style="margin-top:8px;">Recommended for exclusion: ${excludedSessions.map(([id]) => id).join(", ")} (data-quality error -- see issues below). This is a recommendation, not an automatic filter.</p>` : ""}
    <div style="margin-top:10px;">
      ${qcResults.issues.map((i) => `<div class="qc-issue ${i.severity}">${i.sessionId ? `[${i.sessionId}] ` : ""}${i.field ? `<strong>${i.field}</strong>: ` : ""}${i.message}</div>`).join("") || "<p style='color:var(--slate); font-size:13px;'>No issues found.</p>"}
    </div>`;
  container.appendChild(qcPanel);

  // ---- Phase 10 additions -----------------------------------------------
  container.appendChild(buildRepeatabilityPanel(repeatabilityResults));
  container.appendChild(buildMalletAgreementPanel(malletAgreement));
  container.appendChild(buildDistributionsPanel(comparisonResults, malletAgreement));
  container.appendChild(buildPublicationTablesPanel(publicationTables));
  container.appendChild(buildPilotStudySummaryPanel(pilotStudySummary));
}

// ---- Phase 10: Repeatability -------------------------------------------------
function buildRepeatabilityPanel(repeatabilityResults) {
  const panel = document.createElement("details");
  panel.className = "panel category-panel";
  const rows = Object.entries(repeatabilityResults.betweenSession.perParameter || {})
    .map(([param, p]) =>
      p.n >= 2
        ? `<tr><td>${param}</td><td>${p.n}</td><td>${fmt(p.meanDifference)}°</td><td>${fmt(p.diffSd)}°</td><td>${fmt(p.coefficientOfVariationPct)}%</td><td>${fmt(p.repeatabilityCoefficient)}°</td></tr>`
        : `<tr><td>${param}</td><td colspan="5" style="color:var(--slate);">${p.note}</td></tr>`
    )
    .join("");
  panel.innerHTML = `
    <summary><span>Repeatability</span><span class="cat-confidence">between-session: ${repeatabilityResults.betweenSession.groupsFound} pair(s) found</span></summary>
    <table class="contrib-table" style="margin-top:10px;">
      <thead><tr><th>Parameter</th><th>n</th><th>Mean diff</th><th>SD of diff</th><th>CoV</th><th>Repeatability Coeff.</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="color:var(--slate);">No repeat sessions found within the pairing window.</td></tr>`}</tbody>
    </table>
    <p class="flag" style="margin-top:10px;">Within-session repeatability: ${repeatabilityResults.withinSession.reason}</p>
  `;
  return panel;
}

// ---- Phase 10: Mallet Confusion Matrix ---------------------------------------
function buildMalletAgreementPanel(malletAgreement) {
  const panel = document.createElement("details");
  panel.className = "panel category-panel";
  const pa = malletAgreement.percentAgreement;
  const kappa = malletAgreement.weightedKappa;
  const matrix = malletAgreement.confusionMatrix;
  const summaryText = pa?.n ? `n=${pa.n} · exact ${pa.exactMatchPct}% · within-1-grade ${pa.within1GradePct}%` : "no paired grades yet";
  panel.innerHTML = `
    <summary><span>Modified Mallet Confusion Matrix</span><span class="cat-confidence">${summaryText}</span></summary>
    <div class="card-row" style="margin-top:12px;">
      <div>
        <table class="contrib-table">
          <thead><tr><th>Stat</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Exact agreement</td><td>${pa?.exactMatchPct != null ? pa.exactMatchPct + "%" : "n/a"}</td></tr>
            <tr><td>Within 1 grade</td><td>${pa?.within1GradePct != null ? pa.within1GradePct + "%" : "n/a"}</td></tr>
            <tr><td>Weighted kappa (${kappa?.weighting ?? "linear"})</td><td>${kappa?.value != null ? fmt(kappa.value) + ` (${kappa.interpretation})` : kappa?.note ?? "n/a"}</td></tr>
          </tbody>
        </table>
      </div>
      <div id="mallet-heatmap"></div>
    </div>
  `;
  if (matrix) renderHeatmapChart(panel.querySelector("#mallet-heatmap"), matrix);
  return panel;
}

// ---- Phase 10: Distributions --------------------------------------------------
function buildDistributionsPanel(comparisonResults, malletAgreement) {
  const panel = document.createElement("details");
  panel.className = "panel category-panel";
  const paramKeys = Object.keys(comparisonResults);
  panel.innerHTML = `
    <summary><span>Distributions</span><span class="cat-confidence">AI-measured value distributions per parameter</span></summary>
    <div class="chart-grid" style="margin-top:12px;">
      ${paramKeys.map((k) => `<div><div class="chart-title">${k}</div><div id="hist-${k}"></div></div>`).join("")}
    </div>
    ${malletAgreement.confusionMatrix ? `<div style="margin-top:12px;"><div class="chart-title">Modified Mallet grade counts (predicted)</div><table class="contrib-table"><tbody>${malletAgreement.confusionMatrix.grades.map((g, i) => `<tr><td>${g}</td><td>${malletAgreement.confusionMatrix.rowTotals[i]}</td></tr>`).join("")}</tbody></table></div>` : ""}
  `;
  for (const k of paramKeys) {
    const values = comparisonResults[k].pairs.map((p) => p.appValue).filter((v) => v != null);
    renderHistogramChart(panel.querySelector(`#hist-${k}`), values, { binCount: 8 });
  }
  return panel;
}

// ---- Phase 10: Publication Tables ----------------------------------------------
function buildPublicationTablesPanel(publicationTables) {
  const panel = document.createElement("details");
  panel.className = "panel category-panel";
  const sections = Object.values(publicationTables)
    .map((t) => {
      const cols = t.columns;
      const rows = t.rows
        .map((row) => `<tr>${cols.map((c) => `<td>${row[c] ?? "—"}</td>`).join("")}</tr>`)
        .join("");
      return `<div style="margin-top:14px;"><strong style="font-size:12px;">${t.tableName}</strong>
        <table class="contrib-table"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${cols.length}" style="color:var(--slate);">no data</td></tr>`}</tbody></table>
      </div>`;
    })
    .join("");
  panel.innerHTML = `<summary><span>Publication Tables</span><span class="cat-confidence">7 discrete tables, ready for CSV/Excel/PDF export</span></summary>${sections}`;
  return panel;
}

// ---- Phase 10: Pilot Study Summary ---------------------------------------------
function buildPilotStudySummaryPanel(summary) {
  const panel = document.createElement("details");
  panel.className = "panel category-panel";
  panel.open = true;
  const r = summary.readiness;
  const readinessBadge = (label, status, reason) => `
    <div class="readiness-badge readiness-${status}">
      <div class="readiness-label">${label}</div>
      <div class="readiness-status">${status.replaceAll("_", " ")}</div>
      <div class="readiness-reason">${reason}</div>
    </div>`;
  panel.innerHTML = `
    <summary><span>Pilot Study Summary</span><span class="cat-confidence">${summary.patients.uniquePatients} patients · ${summary.patients.totalSessions} sessions</span></summary>
    <div class="readiness-row" style="margin-top:12px;">
      ${readinessBadge("Engineering Verification", r.engineeringVerification.status, r.engineeringVerification.reason)}
      ${readinessBadge("Clinical Validation", r.clinicalValidation.status, r.clinicalValidation.reason)}
      ${readinessBadge("Clinical Deployment", r.clinicalDeployment.status, r.clinicalDeployment.reason)}
    </div>
    <table class="contrib-table" style="margin-top:14px;">
      <tbody>
        <tr><td>Patients / Sessions / Assessments</td><td>${summary.patients.uniquePatients} / ${summary.patients.totalSessions} / ${summary.patients.totalAssessments}</td></tr>
        <tr><td>Clinician agreement (Mallet exact / kappa)</td><td>${summary.clinicianAgreement.malletExactAgreementPct ?? "n/a"}% / ${fmt(summary.clinicianAgreement.malletWeightedKappa) ?? "n/a"}</td></tr>
        <tr><td>Failure rate (zero-task sessions)</td><td>${summary.failureRate.failureRatePct ?? "n/a"}% (${summary.failureRate.failedSessions}/${summary.failureRate.totalSessions})</td></tr>
        <tr><td>Mean capture quality (CQI)</td><td>${summary.captureQuality.meanCqi ?? "n/a"}</td></tr>
        <tr><td>Mean confidence (weighted proxy)</td><td>${summary.averageConfidence.meanConfidencePct ?? "n/a"}%</td></tr>
        <tr><td>Overrides (Mallet grade / parameter)</td><td>${summary.overrideStatistics.malletGradeOverrideCount} / ${summary.overrideStatistics.parameterOverrideCount}</td></tr>
      </tbody>
    </table>
    <div style="margin-top:12px;">
      <strong style="font-size:12px;">Limitations</strong>
      <ul style="font-size:12px; padding-left:18px;">${summary.limitations.map((l) => `<li>${l}</li>`).join("")}</ul>
      <strong style="font-size:12px;">Future Work</strong>
      <ul style="font-size:12px; padding-left:18px;">${summary.futureWork.map((f) => `<li>${f}</li>`).join("")}</ul>
    </div>
  `;
  return panel;
}

function renderReliabilityTable(reliabilityResults) {
  return Object.entries(reliabilityResults)
    .map(([type, result]) => {
      const groups = result.groupsFound ?? result.sessionsWithMultipleRaters ?? 0;
      const rows = Object.entries(result.perParameter || {})
        .map(([param, p]) => {
          const icc = p.icc1_1 ?? p.icc2_1;
          return `<tr><td>${param}</td><td>${p.n}</td><td>${icc ? `${icc.value?.toFixed(2)} (${icc.interpretation})` : "n/a"}</td></tr>`;
        })
        .join("");
      return `<div style="margin-top:12px;"><strong style="font-size:12px;">${type}</strong> — ${groups} group(s) found
        <table class="contrib-table"><thead><tr><th>Parameter</th><th>n</th><th>ICC</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    })
    .join("");
}

function fmt(n) {
  return n == null ? "n/a" : (Math.round(n * 100) / 100).toString();
}

// ---- Bland-Altman chart (SVG, dataviz-skill mark specs: thin marks, 2px
// lines, recessive gridlines, direct labels instead of a legend since each
// line's meaning is unambiguous once labeled) ------------------------------
function renderBlandAltmanChart(container, ba) {
  const width = 380;
  const height = 220;
  const margin = { top: 16, right: 60, bottom: 30, left: 40 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const xs = ba.points.map((p) => p.x);
  const ys = ba.points.map((p) => p.y);
  const yMin = Math.min(ba.lowerLoA, ...ys) - 2;
  const yMax = Math.max(ba.upperLoA, ...ys) + 2;
  const xMin = Math.min(...xs) - 2;
  const xMax = Math.max(...xs) + 2;

  const xScale = (x) => margin.left + ((x - xMin) / (xMax - xMin || 1)) * plotW;
  const yScale = (y) => margin.top + plotH - ((y - yMin) / (yMax - yMin || 1)) * plotH;

  const line = (yVal, cls, label) => `
    <line class="ba-line ${cls}" x1="${margin.left}" y1="${yScale(yVal)}" x2="${margin.left + plotW}" y2="${yScale(yVal)}" />
    <text class="ba-label" x="${margin.left + plotW + 4}" y="${yScale(yVal) + 3}">${label}</text>
  `;

  const points = ba.points
    .map((p) => `<circle class="ba-point ${p.outlier ? "outlier" : ""}" cx="${xScale(p.x)}" cy="${yScale(p.y)}" r="4"><title>mean=${p.x.toFixed(1)}, diff=${p.y.toFixed(1)}</title></circle>`)
    .join("");

  container.innerHTML = `
    <svg class="ba-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${line(ba.bias, "bias", `bias ${ba.bias.toFixed(1)}`)}
      ${line(ba.upperLoA, "", `+1.96SD ${ba.upperLoA.toFixed(1)}`)}
      ${line(ba.lowerLoA, "", `-1.96SD ${ba.lowerLoA.toFixed(1)}`)}
      ${points}
      <text class="ba-label" x="${margin.left}" y="${height - 6}">mean of app &amp; clinician (deg)</text>
    </svg>
  `;
}

// ---- Reports --------------------------------------------------------------
async function loadReports() {
  const { reports } = await api("/api/validation/reports");
  const container = document.getElementById("reportsList");
  container.innerHTML = reports.length
    ? `<table class="data-table"><thead><tr><th>ID</th><th>Generated</th><th>Version</th><th></th></tr></thead><tbody>${reports
        .map(
          (r) => `<tr><td>${r.id}</td><td>${new Date(r.generated_at).toLocaleString()}</td><td>${r.report_version}</td><td>
            <button class="btn" data-report-id="${r.id}">View</button>
            <a class="btn" href="${BACKEND_URL}/api/validation/reports/${r.id}/pdf" target="_blank">PDF</a>
            <a class="btn" href="${BACKEND_URL}/api/validation/reports/${r.id}/csv" target="_blank">CSV</a>
            <a class="btn" href="${BACKEND_URL}/api/validation/reports/${r.id}/xlsx" target="_blank">Excel</a>
          </td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p style="color:var(--slate); font-size:13px;">No reports generated yet — run a validation first.</p>`;
  container.querySelectorAll("[data-report-id]").forEach((btn) => btn.addEventListener("click", () => viewReport(btn.dataset.reportId)));
}

async function viewReport(id) {
  const result = await api(`/api/validation/reports/${id}`);
  const view = document.getElementById("reportView");
  view.classList.remove("hidden");
  view.innerHTML = `<pre class="report-markdown">${escapeHtml(result.reportMarkdown)}</pre>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- boot -------------------------------------------------------------------
function boot() {
  initTabs();
  document.getElementById("submitAssessmentBtn").addEventListener("click", submitAssessment);
  document.getElementById("createDatasetBtn").addEventListener("click", createDataset);
  document.getElementById("runValidationBtn").addEventListener("click", runValidationClick);
}

window.addEventListener("DOMContentLoaded", boot);
