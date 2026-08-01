/**
 * clinical-render.js — Phase 9: shared clinical-data rendering functions.
 * ----------------------------------------------------------------------------
 * Extracted from doctor-portal/portal.js (Phases 1-8, unchanged behavior)
 * so clinician-dashboard/review.js can reuse the SAME ASRI/DMQE/ICQA/
 * Mallet-grade rendering logic instead of a second, drifting copy. Every
 * function here is container-in/HTML-out (or takes an explicit container
 * element to render into) -- none of them reach into a specific page's
 * element IDs, unlike doctor-portal/portal.js's page-specific banner wiring
 * (renderMalletOverallBanner), which stays in portal.js since it's bound to
 * that page's exact DOM.
 *
 * Loaded as a plain classic <script> (not a module), matching
 * shared/api-storage.js's and shared/config.js's existing convention --
 * doctor-portal/portal.js relies on classic-script cross-file globals
 * (e.g. reading BACKEND_URL from config.js as a bare identifier), which
 * only works between classic scripts, not into an ES module's isolated
 * scope. Keeping this a classic script avoids touching that working page's
 * script-loading strategy at all. clinician-dashboard's pages (which DO use
 * type="module" for their own logic, matching validation-portal/app.js's
 * existing precedent) can still read this file's exports off `window`,
 * since module scripts can freely read globals a classic script set.
 *
 * Wrapped in an IIFE: a classic script's top-level `function` declarations
 * become globals (unlike a module's), so an unwrapped `function badgeFor()`
 * here would collide with portal.js's `const { badgeFor } = ClinicalRender`
 * destructuring at its own top level -- confirmed as a real SyntaxError
 * ("Identifier 'badgeFor' has already been declared") in a live browser
 * check before this wrapper was added, not a hypothetical concern.
 * ----------------------------------------------------------------------------
 */
(function () {
"use strict";
const CATEGORY_ORDER = ["rom", "movementQuality", "compensation", "symmetry", "functionalPerformance"];
const MALLET_GRADES = ["I", "II", "III", "IV", "V"];

// measured/estimated/unavailable -- see shared/biomechanics/parameter-schema.js
function badgeFor(measurementType) {
  if (measurementType === "measured") return "measured";
  if (measurementType === "estimated") return "estimated";
  return "unavailable";
}

function fmtParam(p) {
  if (!p) return "—";
  const label = p.value == null ? "—" : `${p.value}°`;
  return `${label} <span class="measure-badge ${badgeFor(p.measurementType)}" title="${p.limitation || ""}">${badgeFor(p.measurementType)}</span>`;
}

function paramRows(p) {
  const rows = [
    ["Shoulder abduction", fmtParam(p.shoulderAbductionDeg)],
    ["Shoulder flexion", fmtParam(p.shoulderFlexionDeg)],
    ["Shoulder elevation", fmtParam(p.shoulderElevationDeg)],
    ["Plane of elevation", fmtParam(p.planeOfElevationDeg)],
    ["External rotation", fmtParam(p.externalRotationDeg)],
    ["Internal rotation", fmtParam(p.internalRotationDeg)],
    ["Scapular upward rotation", fmtParam(p.scapularUpwardRotationDeg)],
    ["Scapular tilt", fmtParam(p.scapularTiltDeg)],
    [
      "Scapular winging",
      `${p.scapularWingingFlag?.value ? "flagged — confirm on image" : "not flagged"} <span class="measure-badge ${badgeFor(p.scapularWingingFlag?.measurementType)}" title="${p.scapularWingingFlag?.limitation || ""}">${badgeFor(p.scapularWingingFlag?.measurementType)}</span>`,
    ],
    ["Trunk lateral lean", `${fmtParam(p.trunkLateralLeanDeg)}${p.trunkCompensationFlag ? " — compensation flagged" : ""}`],
    ["Trunk rotation", fmtParam(p.trunkRotationDeg)],
    ["Movement speed", p.movementSpeed?.value != null ? fmtParam(p.movementSpeed).replace("°", "") : "—"],
    ["Movement smoothness", p.movementSmoothness?.value != null ? fmtParam(p.movementSmoothness).replace("°", "") : "—"],
  ];
  return rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

function renderContribTable(contributions) {
  if (contributions.length === 0) return "";
  const isTaskComposite = contributions[0].compositeScore !== undefined;
  if (isTaskComposite) {
    const rows = contributions
      .map(
        (c) =>
          `<tr><td>${c.taskId.replaceAll("_", " ")}</td><td>${c.romScore ?? "—"}</td><td>${c.movementQualityScore ?? "—"}</td><td>${c.compensationScore ?? "—"}</td><td>${c.compositeScore}</td></tr>`
      )
      .join("");
    return `<table class="contrib-table"><thead><tr><th>Task</th><th>ROM</th><th>Movement Qual.</th><th>Compensation</th><th>Composite</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const rows = contributions
    .map(
      (c) => `<tr>
      <td>${c.parameter}</td>
      <td>${c.rawValue ?? "—"}</td>
      <td>${c.referenceTarget ?? "—"}</td>
      <td>${c.normalizedScore ?? "—"}</td>
      <td>${c.configWeight}</td>
      <td>${c.sourceTaskId ? c.sourceTaskId.replaceAll("_", " ") : "—"}</td>
      <td><span class="measure-badge ${badgeFor(c.measurementType)}">${badgeFor(c.measurementType)}</span></td>
    </tr>`
    )
    .join("");
  return `<table class="contrib-table"><thead><tr><th>Parameter</th><th>Raw</th><th>Target</th><th>Score</th><th>Weight</th><th>Source task</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Renders the ASRI category drill-down panels into `container`. */
function renderCategoryPanels(container, categories) {
  container.innerHTML = CATEGORY_ORDER.filter((key) => categories[key])
    .map((key) => {
      const c = categories[key];
      const scoreText = c.score != null ? c.score : c.status === "insufficient_data" ? "insufficient data" : "—";
      const confText = c.confidencePct != null ? `${c.confidencePct}% confidence` : "";
      const note = c.note ? `<p style="color:var(--slate); font-size:12px; margin-top:8px;">${c.note}</p>` : "";
      const table = renderContribTable(c.contributions || []);
      return `
      <details class="panel category-panel">
        <summary>
          <span>${c.label}</span>
          <span><span class="cat-score">${scoreText}</span><span class="cat-confidence">${confText}</span></span>
        </summary>
        ${note}
        ${table}
      </details>
    `;
    })
    .join("");
}

function renderDmqeSummary(motionAnalysis) {
  if (!motionAnalysis) {
    return `<p style="color:var(--slate); font-size:12px; margin-top:10px;">No motion analysis stored for this task (captured before Phase 3).</p>`;
  }
  if (motionAnalysis.status !== "ok") {
    return `<p style="color:var(--slate); font-size:12px; margin-top:10px;">DMQE: ${motionAnalysis.status.replaceAll("_", " ")} -- no movement window could be identified for this task.</p>`;
  }
  const domainRows = Object.entries(motionAnalysis.domains || {})
    .map(([key, d]) => {
      const value = d.value != null ? `${d.value}${d.unit && d.unit !== "n/a" ? ` ${d.unit}` : ""}` : "—";
      return `<tr>
        <td>${key.replace(/([A-Z])/g, " $1").toLowerCase()}</td>
        <td>${value}</td>
        <td><span class="measure-badge ${badgeFor(d.measurementType)}" title="${d.limitation || ""}">${badgeFor(d.measurementType)}</span></td>
      </tr>`;
    })
    .join("");
  return `
    <details class="panel category-panel" style="margin-top:10px;">
      <summary>
        <span>Dynamic Movement Quality (DMQE)</span>
        <span><span class="cat-score">${motionAnalysis.dmqeScore ?? "—"}</span><span class="cat-confidence">${motionAnalysis.movementConfidencePct != null ? motionAnalysis.movementConfidencePct + "% confidence" : ""}</span></span>
      </summary>
      <table class="contrib-table"><thead><tr><th>Domain</th><th>Value</th><th>Confidence</th></tr></thead><tbody>${domainRows}</tbody></table>
    </details>
  `;
}

function renderCaptureQualitySummary(cameraQuality) {
  if (!cameraQuality || cameraQuality.status !== "ok") {
    return `<p style="color:var(--slate); font-size:12px; margin-top:10px;">No capture-quality data stored for this task (captured before Phase 5, or the gate check never completed).</p>`;
  }
  const overrideNote = cameraQuality.gateOverridden
    ? `<p class="flag" style="margin-top:8px;">Recording was started despite failing the quality gate (caregiver chose "Start anyway") -- interpret this task's measurements with that in mind. Blocking issues at start: ${cameraQuality.blockingCriteriaAtStart.map((c) => c.label).join(", ") || "—"}.</p>`
    : "";
  const subscoreRows = Object.entries(cameraQuality.subscores || {})
    .map(([, s]) => `<tr><td>${s.label}</td><td>${s.score ?? "—"}</td><td>${s.confidencePct != null ? s.confidencePct + "%" : "—"}</td></tr>`)
    .join("");
  const t = cameraQuality.timeline;
  const timelineSummary = t
    ? `<p style="color:var(--slate); font-size:12px; margin-top:10px;">During recording: min CQI ${t.minCqi ?? "—"}, mean CQI ${t.meanCqi ?? "—"}${t.autoPaused ? `, auto-paused ${t.autoPauseEvents.length}×` : ""}.</p>
       <div class="qt-chart-container"></div>
       ${t.warnings.length ? `<ul style="font-size:12px; color:var(--slate); margin:6px 0 0 18px;">${t.warnings.map((w) => `<li>${w.message}</li>`).join("")}</ul>` : ""}`
    : "";
  return `
    <details class="panel category-panel" style="margin-top:10px;">
      <summary>
        <span>Capture Quality (ICQA)</span>
        <span><span class="cat-score">${cameraQuality.cqi ?? "—"}</span><span class="cat-confidence">${cameraQuality.overallConfidencePct != null ? cameraQuality.overallConfidencePct + "% confidence" : ""}</span></span>
      </summary>
      ${overrideNote}
      <table class="contrib-table"><thead><tr><th>Subscore</th><th>Score</th><th>Confidence</th></tr></thead><tbody>${subscoreRows}</tbody></table>
      ${timelineSummary}
    </details>
  `;
}

/** `row` is a taskRows entry from report-generator.js's structured report
 *  (predicted grade + most recent clinician override already merged --
 *  one source of truth, not re-derived here). The returned HTML embeds a
 *  `<form class="override-form" data-task-id="...">` whose submit handler
 *  the CALLER wires up (portal.js and review.js each bind their own
 *  submit-override function, since the API-call/refresh behavior differs
 *  slightly between the two pages). */
function renderMalletGradeSummary(sessionId, taskId, row) {
  if (!row) {
    return `<p style="color:var(--slate); font-size:12px; margin-top:10px;">No Mallet grade stored for this task (captured before Phase 6).</p>`;
  }
  const measurementRows = Object.entries(row.malletMeasurements || {})
    .map(([key, m]) => {
      if (!m || typeof m !== "object") return "";
      const value = m.value == null ? "—" : typeof m.value === "boolean" ? (m.value ? "yes" : "no") : `${m.value}${m.unit && m.unit !== "boolean" && m.unit !== "vertebral_level_bucket" ? ` ${m.unit}` : ""}`;
      return `<tr><td>${key.replace(/([A-Z])/g, " $1").toLowerCase()}</td><td>${value}</td><td><span class="measure-badge ${badgeFor(m.measurementType)}" title="${m.limitation || ""}">${badgeFor(m.measurementType)}</span></td></tr>`;
    })
    .join("");

  const agreementNote = row.agreement
    ? `<p style="font-size:12px; color:${row.agreement.agree ? "var(--signal)" : "var(--amber)"}; margin-top:6px;">${row.agreement.agree ? "Clinician grade matches the prediction exactly." : `Clinician grade differs from the prediction by ${row.agreement.differenceGrades > 0 ? "+" : ""}${row.agreement.differenceGrades}.`}</p>`
    : "";
  const overrideHistory = row.clinicianGrade
    ? `<p class="override-history">Last reviewed by ${row.overrideClinicianName} on ${new Date(row.overrideTimestamp).toLocaleString()}${row.overrideReason ? `: "${row.overrideReason}"` : ""}</p>`
    : "";

  return `
    <details class="panel category-panel" style="margin-top:10px;">
      <summary>
        <span>Modified Mallet Grade</span>
        <span><span class="mallet-grade-badge">${row.predictedGrade ?? "—"}</span><span class="cat-confidence">${row.predictedConfidence != null ? row.predictedConfidence + "% confidence" : row.predictedStatus === "insufficient_data" ? "insufficient data" : ""}</span></span>
      </summary>
      <p style="font-size:13px; margin-top:6px;">${row.reasoning || "No grade could be predicted for this task."}</p>
      ${measurementRows ? `<table class="contrib-table"><thead><tr><th>Measurement</th><th>Value</th><th>Confidence</th></tr></thead><tbody>${measurementRows}</tbody></table>` : ""}
      <div class="override-form">
        <div class="eyebrow" style="margin-bottom:8px;">Clinician review</div>
        ${row.clinicianGrade ? `<p style="font-size:13px;">Current clinician grade: <b>${row.clinicianGrade}</b></p>${agreementNote}${overrideHistory}` : `<p style="font-size:12px; color:var(--slate);">Not yet reviewed by a clinician.</p>`}
        <form class="override-form" data-task-id="${taskId}">
          <div class="field-row">
            <label>Grade</label>
            <select name="clinicianGrade" required>
              <option value="">— select —</option>
              ${MALLET_GRADES.map((g) => `<option value="${g}" ${row.clinicianGrade === g ? "selected" : ""}>${g}</option>`).join("")}
            </select>
          </div>
          <div class="field-row">
            <label>Reason</label>
            <textarea name="overrideReason" rows="2" placeholder="Why does this differ from (or confirm) the prediction?"></textarea>
          </div>
          <div class="field-row">
            <label>Your name</label>
            <input type="text" name="clinicianName" required placeholder="Dr. ..." />
          </div>
          <button type="submit" class="btn primary">${row.clinicianGrade ? "Update grade" : "Save clinician grade"}</button>
        </form>
      </div>
    </details>
  `;
}

/** Quality Timeline chart: CQI over the recording window. Same construction
 *  as validation-portal/app.js's renderBlandAltmanChart() -- manual
 *  xScale/yScale closures, thin marks, a dashed recessive threshold line,
 *  native SVG <title> tooltips instead of a JS hover layer, shaded bands for
 *  any auto-pause windows. */
function renderQualityTimelineChart(container, timeline) {
  const width = 420, height = 180, margin = { top: 14, right: 50, bottom: 24, left: 30 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const samples = timeline.samples;
  const tMax = Math.max(...samples.map((s) => s.tSec), 0.1);
  const xScale = (t) => margin.left + (t / tMax) * plotW;
  const yScale = (cqi) => margin.top + plotH - (Math.max(0, Math.min(100, cqi ?? 0)) / 100) * plotH;

  const pauseBands = (timeline.autoPauseEvents || [])
    .map((e) => {
      const x1 = xScale(e.triggeredAtSec);
      const x2 = xScale(e.resumedAtSec ?? tMax);
      return `<rect class="qt-pause" x="${x1}" y="${margin.top}" width="${Math.max(1, x2 - x1)}" height="${plotH}" />`;
    })
    .join("");

  const linePoints = samples.filter((s) => s.cqi != null).map((s) => `${xScale(s.tSec)},${yScale(s.cqi)}`).join(" ");
  const warnThreshold = timeline.warnCqiThreshold;
  const thresholdLine = warnThreshold != null
    ? `<line class="qt-threshold" x1="${margin.left}" y1="${yScale(warnThreshold)}" x2="${margin.left + plotW}" y2="${yScale(warnThreshold)}" />
       <text class="qt-label" x="${margin.left + plotW + 4}" y="${yScale(warnThreshold) + 3}">warn</text>`
    : "";
  const points = samples
    .filter((s) => s.cqi != null)
    .map((s) => `<circle class="qt-point ${warnThreshold != null && s.cqi < warnThreshold ? "warn" : ""}" cx="${xScale(s.tSec)}" cy="${yScale(s.cqi)}" r="3"><title>t=${s.tSec.toFixed(1)}s, CQI=${s.cqi}</title></circle>`)
    .join("");

  container.innerHTML = `
    <svg class="qt-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${pauseBands}
      ${thresholdLine}
      <polyline class="qt-line" points="${linePoints}" />
      ${points}
      <text class="qt-label" x="${margin.left}" y="${height - 6}">0s</text>
      <text class="qt-label" x="${margin.left + plotW}" y="${height - 6}" text-anchor="end">${tMax.toFixed(1)}s</text>
    </svg>
  `;
}

const ClinicalRender = {
  CATEGORY_ORDER,
  MALLET_GRADES,
  badgeFor,
  fmtParam,
  paramRows,
  renderContribTable,
  renderCategoryPanels,
  renderDmqeSummary,
  renderCaptureQualitySummary,
  renderMalletGradeSummary,
  renderQualityTimelineChart,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = ClinicalRender;
} else {
  window.ClinicalRender = ClinicalRender;
}
})();
