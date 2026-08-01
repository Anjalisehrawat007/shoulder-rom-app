/**
 * studies.js — Phase 9: Pilot Study Management.
 * ----------------------------------------------------------------------------
 * A pilot study IS a validation_datasets row (type='pilot') -- this page is
 * a thin UI over the existing dataset-membership endpoints extended this
 * phase with status/assignment/stats. Manual status transitions (pending ->
 * in_review -> completed), not auto-derived from data presence -- simpler
 * and more explicit for a clinician, matching the Phase 9 plan's decision.
 * ----------------------------------------------------------------------------
 */
import { requireDashboardSession, renderDashNav } from "./dash-common.js";

const storage = new ApiStorage(BACKEND_URL);
let dashSession = null;
let activeStudyId = null;
let studies = [];

async function boot() {
  dashSession = requireDashboardSession(storage);
  if (!dashSession) return;
  renderDashNav(document.getElementById("navContainer"), dashSession, "studies");

  document.getElementById("createStudyForm").addEventListener("submit", createStudy);
  document.getElementById("assignBtn").addEventListener("click", assignSession);
  document.getElementById("studyStatusSelect").addEventListener("change", updateStudyStatus);

  await loadStudies();
}

async function loadStudies() {
  const listEl = document.getElementById("studiesList");
  try {
    const { datasets } = await storage.getStudies("pilot");
    studies = datasets;
    if (studies.length === 0) {
      listEl.innerHTML = `<p style="color:var(--slate); font-size:13px;">No pilot studies yet -- create one below.</p>`;
      return;
    }
    listEl.innerHTML = studies
      .map((s) => `<div class="study-row" data-id="${s.id}"><span>${s.name} <span class="status-pill ${s.status || "active"}" style="margin-left:8px;">${s.status || "active"}</span></span><span style="color:var(--slate); font-size:12px;">${s.notes || ""}</span></div>`)
      .join("");
    listEl.querySelectorAll(".study-row").forEach((row) => {
      row.addEventListener("click", () => openStudy(Number(row.dataset.id)));
    });
  } catch (err) {
    listEl.innerHTML = `<p class="flag">Could not load studies: ${err.message}</p>`;
  }
}

async function createStudy(e) {
  e.preventDefault();
  const name = document.getElementById("newStudyName").value.trim();
  const notes = document.getElementById("newStudyNotes").value.trim();
  if (!name) return;
  try {
    await storage.createStudy({ name, type: "pilot", notes });
    document.getElementById("newStudyName").value = "";
    document.getElementById("newStudyNotes").value = "";
    await loadStudies();
  } catch (err) {
    alert(`Could not create study: ${err.message}`);
  }
}

async function openStudy(id) {
  activeStudyId = id;
  const study = studies.find((s) => s.id === id);
  document.getElementById("detailPanel").classList.remove("hidden");
  document.getElementById("studyName").textContent = study.name;
  document.getElementById("studyMeta").textContent = `${study.notes || "no notes"} · created ${new Date(study.created_at).toLocaleDateString()}`;
  document.getElementById("studyStatusSelect").value = study.status || "active";
  await refreshStudyDetail();
}

async function refreshStudyDetail() {
  await Promise.all([renderStats(), renderMembers()]);
}

async function renderStats() {
  const stats = await storage.getStudyStats(activeStudyId).catch(() => null);
  const container = document.getElementById("statTiles");
  if (!stats) {
    container.innerHTML = "";
    return;
  }
  const completed = stats.byStatus.find((s) => s.status === "completed")?.n ?? 0;
  const pending = stats.byStatus.find((s) => s.status === "pending")?.n ?? 0;
  const inReview = stats.byStatus.find((s) => s.status === "in_review")?.n ?? 0;
  container.innerHTML = `
    <div class="panel stat-tile"><div class="stat-value">${stats.total}</div><div class="stat-label">Assigned patients</div></div>
    <div class="panel stat-tile"><div class="stat-value">${pending}</div><div class="stat-label">Pending review</div></div>
    <div class="panel stat-tile"><div class="stat-value">${inReview}</div><div class="stat-label">In review</div></div>
    <div class="panel stat-tile"><div class="stat-value">${completed}</div><div class="stat-label">Completed</div></div>
    <div class="panel stat-tile"><div class="stat-value">${stats.percentComplete}%</div><div class="stat-label">Complete</div></div>
  `;
}

async function renderMembers() {
  const tbody = document.getElementById("membersBody");
  const { members } = await storage.getStudyMembers(activeStudyId).catch(() => ({ members: [] }));
  if (members.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--slate);">No patients assigned to this study yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = members
    .map(
      (m) => `
    <tr>
      <td><a href="review.html?sessionId=${m.sessionId}">${m.patientLabel}</a></td>
      <td>${m.assignedReviewer ?? "—"}</td>
      <td><span class="status-pill ${m.status}">${m.status}</span></td>
      <td>
        <select data-session-id="${m.sessionId}" class="status-select">
          <option value="pending" ${m.status === "pending" ? "selected" : ""}>Pending</option>
          <option value="in_review" ${m.status === "in_review" ? "selected" : ""}>In review</option>
          <option value="completed" ${m.status === "completed" ? "selected" : ""}>Completed</option>
        </select>
      </td>
    </tr>
  `
    )
    .join("");
  tbody.querySelectorAll(".status-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      try {
        await storage.updateAssignment(activeStudyId, sel.dataset.sessionId, { status: sel.value });
        await refreshStudyDetail();
      } catch (err) {
        alert(`Could not update status: ${err.message}`);
      }
    });
  });
}

async function assignSession() {
  const sessionId = document.getElementById("assignSessionId").value.trim();
  const assignedReviewer = document.getElementById("assignReviewer").value.trim();
  if (!sessionId) return;
  try {
    await storage.assignSession(activeStudyId, { sessionId, assignedReviewer: assignedReviewer || undefined });
    document.getElementById("assignSessionId").value = "";
    document.getElementById("assignReviewer").value = "";
    await refreshStudyDetail();
  } catch (err) {
    alert(`Could not assign patient: ${err.message}`);
  }
}

async function updateStudyStatus() {
  const status = document.getElementById("studyStatusSelect").value;
  try {
    await storage.updateStudyStatus(activeStudyId, status);
    await loadStudies();
  } catch (err) {
    alert(`Could not update study status: ${err.message}`);
  }
}

window.addEventListener("DOMContentLoaded", boot);
