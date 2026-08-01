/**
 * review.js — Phase 9: full per-session Assessment Review view.
 * ----------------------------------------------------------------------------
 * Reuses shared/clinical-render.js's ASRI/DMQE/ICQA/Mallet-grade rendering
 * (identical to doctor-portal/portal.js, not a second copy) and adds what's
 * new this phase: video playback + a joint-angle chart synced to it, the
 * Clinician Assessment Panel form, the AI-vs-Clinician comparison table with
 * a generalized override affordance, and a per-session audit history panel.
 * ----------------------------------------------------------------------------
 */
import { requireDashboardSession, renderDashNav } from "./dash-common.js";
import { renderJointAngleChart } from "../shared/joint-angle-chart.js";

const storage = new ApiStorage(BACKEND_URL);
const { paramRows, renderDmqeSummary, renderCaptureQualitySummary, renderMalletGradeSummary, renderQualityTimelineChart } = ClinicalRender;

const sessionId = new URLSearchParams(location.search).get("sessionId");
let dashSession = null;
let summary = null;
let comparison = null;
const nudgeSec = {}; // taskId -> manual video/chart sync offset in seconds

async function boot() {
  dashSession = requireDashboardSession(storage);
  if (!dashSession) return;
  renderDashNav(document.getElementById("navContainer"), dashSession, "index");
  if (!sessionId) {
    showError("No sessionId in the URL.");
    return;
  }

  document.getElementById("downloadResearchJsonBtn").addEventListener("click", () => download(storage.researchReportUrl(sessionId, "json"), `research-report-${sessionId}.json`));
  document.getElementById("downloadResearchPdfBtn").addEventListener("click", () => download(storage.researchReportUrl(sessionId, "pdf"), `research-report-${sessionId}.pdf`));
  document.getElementById("downloadCsvBtn").addEventListener("click", () => download(storage.exportUrl("csv", { sessionIds: [sessionId] }), `export-${sessionId}.csv`));
  document.getElementById("downloadXlsxBtn").addEventListener("click", () => download(storage.exportUrl("xlsx", { sessionIds: [sessionId] }), `export-${sessionId}.xlsx`));
  document.getElementById("assessmentForm").addEventListener("submit", submitAssessment);

  await loadAll();
}

async function download(url, filename) {
  try {
    await storage.downloadWithAuth(url, filename);
  } catch (err) {
    alert(`Download failed: ${err.message}`);
  }
}

function showError(msg) {
  const el = document.getElementById("loadError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function loadAll() {
  try {
    summary = await storage.getSessionSummary(sessionId);
  } catch (err) {
    showError(`Could not load this session: ${err.message}`);
    return;
  }
  comparison = await storage.getComparison(sessionId).catch(() => ({ rows: [], clinicianAssessment: null }));
  document.getElementById("content").classList.remove("hidden");
  renderHeader();
  renderComparison();
  await renderTasks();
  await renderAudit();
  prefillAssessmentForm();
}

function renderHeader() {
  const report = summary.report;
  document.getElementById("patientLabel").textContent = report.session.patientLabel;
  document.getElementById("sessionMeta").textContent = `${report.session.side} side · captured ${new Date(report.session.createdAt).toLocaleString()}`;
  document.getElementById("compositeScore").textContent = report.asri?.composite ?? "—";
  document.getElementById("compositeCi").textContent = report.asri?.confidenceInterval
    ? `95% CI ${report.asri.confidenceInterval.low}–${report.asri.confidenceInterval.high}`
    : "insufficient data";

  const overall = report.malletOverall;
  const summaryEl = document.getElementById("malletOverallSummary");
  const metaEl = document.getElementById("malletOverallMeta");
  if (!overall || overall.status !== "ok") {
    summaryEl.innerHTML = `<div class="big">—</div>`;
    metaEl.textContent = "insufficient data";
  } else {
    summaryEl.innerHTML = `<div class="big">${overall.averageGradeRoman}</div>`;
    const agreement = report.overallAgreement;
    const agreementText = agreement?.status === "ok" ? ` · clinician agreement ${agreement.exactAgreementPct}% (n=${agreement.n})` : "";
    metaEl.textContent = `Total ${overall.totalScore} · avg ${overall.averageGrade} · ${overall.tasksGraded}/${overall.tasksTotal} tasks${agreementText}`;
  }
}

function renderComparison() {
  const tbody = document.getElementById("comparisonBody");
  const rows = comparison.rows || [];
  document.getElementById("disagreementCount").textContent = `${rows.filter((r) => r.agreementStatus === "disagree").length} disagreement(s)`;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--slate);">No comparable clinician-entered values yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r, i) => {
      const overridable = r.field !== "malletGrade" && r.field !== "overallAssessment" && typeof r.aiValue === "number";
      return `
    <tr>
      <td>${r.field}</td>
      <td>${r.taskId ? r.taskId.replaceAll("_", " ") : "—"}</td>
      <td class="${r.agreementStatus === "disagree" ? "disagree" : ""}">${r.aiValue ?? "—"}</td>
      <td class="${r.agreementStatus === "disagree" ? "disagree" : ""}">${r.clinicianValue ?? "—"}</td>
      <td><span class="agreement-tag ${r.agreementStatus}">${r.agreementStatus.replaceAll("_", " ")}</span></td>
      <td>${overridable ? `<button class="btn param-override-btn" data-idx="${i}" type="button">Override</button>` : ""}</td>
    </tr>`;
    })
    .join("");
  tbody.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => openOverridePrompt(rows[Number(btn.dataset.idx)]));
  });
}

async function openOverridePrompt(row) {
  const value = prompt(`New value for ${row.field} (${row.taskId})`, row.clinicianValue ?? row.aiValue ?? "");
  if (value === null || value.trim() === "" || Number.isNaN(Number(value))) return;
  const reason = prompt("Reason for this override (optional):", "") || "";
  try {
    await storage.submitParameterOverride(sessionId, { taskId: row.taskId, fieldKey: row.field, fieldLabel: row.field, overriddenValue: Number(value), overrideReason: reason });
    await loadAll();
  } catch (err) {
    alert(`Could not save override: ${err.message}`);
  }
}

async function renderTasks() {
  const container = document.getElementById("taskPanels");
  container.innerHTML = "";
  const malletRowsByTask = {};
  for (const row of summary.report.taskRows || []) malletRowsByTask[row.taskId] = row;

  for (const row of summary.report.taskRows || []) {
    const taskId = row.taskId;
    const details = summary.taskDetails?.[taskId] || {};
    const media = summary.taskMedia?.[taskId] || {};
    const taskCaptures = (summary.captures || []).filter((c) => c.taskId === taskId);

    const card = document.createElement("div");
    card.className = "panel task-card";
    card.innerHTML = `
      <h3>${taskId.replaceAll("_", " ")}</h3>
      <div class="thumbs">${taskCaptures.map((c, i) => `<img data-idx="${i}" />`).join("")}</div>
      ${media.videoUrl ? `
        <div class="video-panel">
          <video controls preload="metadata"><source src="${BACKEND_URL}${media.videoUrl}" type="video/webm" /></video>
          <div class="sync-nudge">
            <span>Sync nudge</span>
            <input type="range" min="-300" max="300" step="10" value="0" data-task-id="${taskId}" class="nudge-slider" />
            <span class="nudge-value" data-task-id="${taskId}">0ms</span>
          </div>
        </div>
      ` : `<p style="color:var(--slate); font-size:12px;">No video recorded for this task.</p>`}
      <div class="angle-chart-container" data-task-id="${taskId}"></div>
      <table class="params-table">${paramRows(row.measurements || {})}</table>
      ${renderDmqeSummary(details.motionAnalysis)}
      ${renderCaptureQualitySummary(details.cameraQuality)}
      ${renderMalletGradeSummary(sessionId, taskId, malletRowsByTask[taskId])}
    `;
    container.appendChild(card);

    const qtContainer = card.querySelector(".qt-chart-container");
    if (qtContainer && details.cameraQuality?.timeline?.samples?.length > 1) {
      renderQualityTimelineChart(qtContainer, details.cameraQuality.timeline);
    }

    const imgs = card.querySelectorAll(".thumbs img");
    taskCaptures.forEach((c, i) => {
      imgs[i].src = BACKEND_URL + c.photoUrl;
      imgs[i].addEventListener("click", () => openLightbox(BACKEND_URL + c.photoUrl));
    });

    // Same pattern as doctor-portal/portal.js: relies on the submit event
    // bubbling from the inner <form class="override-form"> up to this outer
    // <div class="override-form"> (the first match in document order) --
    // e.target inside the handler still correctly resolves to the <form>.
    const overrideForm = card.querySelector(".override-form");
    if (overrideForm) overrideForm.addEventListener("submit", (e) => submitMalletOverride(e, taskId));

    // Joint-angle chart + video sync, only when a time series is available.
    if (media.angleTimeseriesUrl) {
      const angleData = await fetch(`${BACKEND_URL}${media.angleTimeseriesUrl}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const chartContainer = card.querySelector(".angle-chart-container");
      if (angleData?.frames?.length) {
        renderJointAngleChart(chartContainer, angleData.frames);
        const video = card.querySelector("video");
        const slider = card.querySelector(".nudge-slider");
        const nudgeLabel = card.querySelector(".nudge-value");
        if (video) {
          video.addEventListener("timeupdate", () => {
            const offset = (nudgeSec[taskId] || 0) / 1000;
            renderJointAngleChart(chartContainer, angleData.frames, { currentTSec: video.currentTime + offset });
          });
        }
        if (slider) {
          slider.addEventListener("input", () => {
            nudgeSec[taskId] = Number(slider.value);
            nudgeLabel.textContent = `${slider.value}ms`;
            if (video) renderJointAngleChart(chartContainer, angleData.frames, { currentTSec: video.currentTime + Number(slider.value) / 1000 });
          });
        }
      } else {
        renderJointAngleChart(chartContainer, []);
      }
    }
  }
}

async function submitMalletOverride(e, taskId) {
  e.preventDefault();
  const form = e.target;
  const clinicianGrade = form.clinicianGrade.value;
  const overrideReason = form.overrideReason.value.trim();
  const clinicianName = form.clinicianName.value.trim() || dashSession.reviewerName;
  if (!clinicianGrade || !clinicianName) return;
  const submitBtn = form.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await storage.submitMalletOverride(sessionId, taskId, { clinicianGrade, overrideReason, clinicianName });
    await loadAll();
  } catch (err) {
    alert(`Could not save the override: ${err.message}`);
    submitBtn.disabled = false;
  }
}

function prefillAssessmentForm() {
  const a = comparison.clinicianAssessment;
  if (!a) return;
  const form = document.getElementById("assessmentForm");
  if (a.assessmentDate) form.assessmentDate.value = a.assessmentDate.slice(0, 10);
  if (a.malletScore?.grade) form.malletScoreOverall.value = a.malletScore.grade;
  if (a.rom != null) form.rom.value = a.rom;
  if (a.externalRotation != null) form.externalRotation.value = a.externalRotation;
  if (a.internalRotation != null) form.internalRotation.value = a.internalRotation;
  if (a.compensationSeverity) form.compensationSeverity.value = a.compensationSeverity;
  if (a.overallAssessment) form.overallAssessment.value = a.overallAssessment;
  if (a.notes) form.notes.value = a.notes;
  if (a.clinicianConfidencePct != null) form.clinicianConfidencePct.value = a.clinicianConfidencePct;
  if (a.clinicianRecommendation) form.clinicianRecommendation.value = a.clinicianRecommendation;
}

async function submitAssessment(e) {
  e.preventDefault();
  const form = e.target;
  const savedLabel = document.getElementById("assessmentSaved");
  const grade = form.malletScoreOverall.value;
  try {
    await storage.submitClinicianAssessment({
      sessionId,
      hospitalId: summary.report.session.sessionId,
      assessmentDate: form.assessmentDate.value || new Date().toISOString().slice(0, 10),
      clinicianName: dashSession.reviewerName,
      rom: form.rom.value ? Number(form.rom.value) : null,
      externalRotation: form.externalRotation.value ? Number(form.externalRotation.value) : null,
      internalRotation: form.internalRotation.value ? Number(form.internalRotation.value) : null,
      malletScore: grade ? { grade } : null,
      compensationSeverity: form.compensationSeverity.value || null,
      overallAssessment: form.overallAssessment.value.trim() || null,
      notes: form.notes.value.trim() || null,
      clinicianConfidencePct: form.clinicianConfidencePct.value ? Number(form.clinicianConfidencePct.value) : null,
      clinicianRecommendation: form.clinicianRecommendation.value.trim() || null,
    });
    savedLabel.textContent = "Saved.";
    savedLabel.style.color = "var(--signal)";
    await loadAll();
  } catch (err) {
    savedLabel.textContent = `Could not save: ${err.message}`;
    savedLabel.style.color = "var(--amber)";
  }
}

async function renderAudit() {
  const { entries, total } = await storage.getAuditLog({ sessionId }).catch(() => ({ entries: [], total: 0 }));
  document.getElementById("auditCountLabel").textContent = `${total} entr${total === 1 ? "y" : "ies"}`;
  const list = document.getElementById("auditList");
  if (entries.length === 0) {
    list.innerHTML = `<p style="color:var(--slate); font-size:12px;">No audit entries for this session yet.</p>`;
    return;
  }
  list.innerHTML = entries
    .map(
      (e) => `
    <div class="audit-entry">
      <div>${e.summary}</div>
      <div class="audit-meta">${e.entityType} · ${e.action} · by ${e.reviewerName} · ${new Date(e.createdAt).toLocaleString()}</div>
    </div>
  `
    )
    .join("");
}

function openLightbox(url) {
  document.getElementById("lightboxImg").src = url;
  document.getElementById("lightbox").classList.remove("hidden");
  document.getElementById("lightbox").onclick = () => document.getElementById("lightbox").classList.add("hidden");
}

window.addEventListener("DOMContentLoaded", boot);
