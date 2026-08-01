const storage = new ApiStorage(BACKEND_URL);
const { badgeFor, paramRows, renderCategoryPanels, renderDmqeSummary, renderCaptureQualitySummary, renderMalletGradeSummary, renderQualityTimelineChart } = ClinicalRender;

async function boot() {
  document.getElementById("unlockBtn").addEventListener("click", unlock);
}

let _lastUnlockResult = null; // cached so an override submission can refresh the view without re-entering the access code

async function unlock() {
  const sessionId = document.getElementById("sessionIdInput").value.trim();
  const code = document.getElementById("codeInput").value.trim();
  const result = await storage.unlockSession(sessionId, code);
  if (!result.ok) {
    document.getElementById("unlockError").textContent = result.reason;
    return;
  }
  document.getElementById("lockScreen").classList.add("hidden");
  document.getElementById("viewScreen").classList.remove("hidden");
  _lastUnlockResult = { sessionId, ...result };
  await refreshAndRender();
}

/** Re-fetches the Mallet report (which carries predicted grades + any
 *  clinician overrides + the recomputed overall score/agreement -- all
 *  from shared/reporting/report-generator.js, one source of truth rather
 *  than re-deriving agreement logic here) and re-renders the whole view.
 *  Called on initial unlock and again after a clinician submits an
 *  override, so the UI reflects it immediately without a manual reload. */
async function refreshAndRender() {
  const { sessionId, session, taskResults, captures, asriResult } = _lastUnlockResult;
  const malletReport = await storage.getMalletReport(sessionId).catch(() => null);
  render(sessionId, session, taskResults, captures, asriResult, malletReport);
}

function render(sessionId, session, taskResults, captures, asriResult, malletReport) {
  document.getElementById("patientLabel").textContent = session.patientLabel;
  document.getElementById("sessionMeta").textContent =
    `${session.side} side · stage ${session.stage01} · captured ${new Date(session.createdAt).toLocaleString()} · ASRI v${session.asriVersion}`;

  // This score was computed server-side using the ASRI + reference-dataset versions that were
  // ACTIVE at capture time, not necessarily the latest -- versions are immutable, so it always
  // reproduces the exact score the clinician originally saw, regardless of later re-fits.
  document.getElementById("compositeScore").textContent = asriResult?.composite ?? "—";
  document.getElementById("compositeCi").textContent = asriResult?.confidenceInterval
    ? `95% CI ${asriResult.confidenceInterval.low}–${asriResult.confidenceInterval.high} · ${Math.round(asriResult.completeness * 100)}% complete`
    : "insufficient data";
  document.getElementById("overallConfidence").textContent =
    asriResult?.overallConfidencePct != null ? `Overall confidence ${asriResult.overallConfidencePct}%` : "";

  renderCategoryPanels(document.getElementById("categoryPanels"), asriResult?.categories || {});
  renderMalletOverallBanner(sessionId, malletReport);

  const malletRowsByTask = {};
  for (const row of malletReport?.taskRows || []) malletRowsByTask[row.taskId] = row;

  session.taskResults = taskResults; // keep the card-rendering loop below unchanged
  const cardsEl = document.getElementById("taskCards");
  cardsEl.innerHTML = "";
  for (const [taskId, taskResult] of Object.entries(session.taskResults)) {
    const card = document.createElement("div");
    card.className = "panel task-card";
    const taskCaptures = captures.filter((c) => c.taskId === taskId);
    card.innerHTML = `
      <h3>${taskId.replaceAll("_", " ")}</h3>
      <div class="thumbs">${taskCaptures.map((c, i) => `<img data-idx="${i}" data-task="${taskId}" />`).join("")}</div>
      <table class="params-table">${paramRows(taskResult.parameters)}</table>
      ${renderDmqeSummary(taskResult.motionAnalysis)}
      ${renderCaptureQualitySummary(taskResult.cameraQuality)}
      ${renderMalletGradeSummary(sessionId, taskId, malletRowsByTask[taskId])}
    `;
    cardsEl.appendChild(card);
    const qtContainer = card.querySelector(".qt-chart-container");
    if (qtContainer && taskResult.cameraQuality?.timeline?.samples?.length > 1) {
      renderQualityTimelineChart(qtContainer, taskResult.cameraQuality.timeline);
    }
    const imgs = card.querySelectorAll("img");
    taskCaptures.forEach((c, i) => {
      imgs[i].src = c.photoUrl;
      imgs[i].addEventListener("click", () => openLightbox(c.photoUrl));
    });
    const overrideForm = card.querySelector(".override-form");
    if (overrideForm) overrideForm.addEventListener("submit", (e) => submitOverride(e, sessionId, taskId));
  }
}

function renderMalletOverallBanner(sessionId, malletReport) {
  document.getElementById("downloadJsonReportBtn").href = storage.malletReportUrl(sessionId, "json");
  document.getElementById("downloadPdfReportBtn").href = storage.malletReportUrl(sessionId, "pdf");
  const overall = malletReport?.malletOverall;
  const summaryEl = document.getElementById("malletOverallSummary");
  const metaEl = document.getElementById("malletOverallMeta");
  if (!overall || overall.status !== "ok") {
    summaryEl.innerHTML = `<div class="big">—</div>`;
    metaEl.textContent = "insufficient data";
    return;
  }
  summaryEl.innerHTML = `<div class="big">${overall.averageGradeRoman}</div>`;
  const agreement = malletReport.overallAgreement;
  const agreementText =
    agreement?.status === "ok" ? ` · clinician agreement ${agreement.exactAgreementPct}% (n=${agreement.n})` : "";
  metaEl.textContent = `Total ${overall.totalScore} · avg ${overall.averageGrade} · ${overall.tasksGraded}/${overall.tasksTotal} tasks · confidence ${overall.assessmentConfidencePct}%${agreementText}`;
}

async function submitOverride(e, sessionId, taskId) {
  e.preventDefault();
  const form = e.target;
  const clinicianGrade = form.clinicianGrade.value;
  const overrideReason = form.overrideReason.value.trim();
  const clinicianName = form.clinicianName.value.trim();
  if (!clinicianGrade || !clinicianName) return;
  const submitBtn = form.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await storage.submitMalletOverride(sessionId, taskId, { clinicianGrade, overrideReason, clinicianName });
    await refreshAndRender();
  } catch (err) {
    alert(`Could not save the override: ${err.message}`);
    submitBtn.disabled = false;
  }
}

function openLightbox(url) {
  document.getElementById("lightboxImg").src = url;
  document.getElementById("lightbox").classList.remove("hidden");
  document.getElementById("lightbox").onclick = () => document.getElementById("lightbox").classList.add("hidden");
}

window.addEventListener("DOMContentLoaded", boot);
