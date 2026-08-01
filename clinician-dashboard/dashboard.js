/**
 * dashboard.js — Phase 9: login gate, reviewer picker, patient list/search/filter.
 * ----------------------------------------------------------------------------
 * type="module" (unlike doctor-portal/portal.js's classic script) -- matches
 * validation-portal/app.js's existing precedent for this repo's newer pages.
 * Reads ApiStorage/BACKEND_URL off `window` (set by the classic scripts
 * config.js/api-storage.js loaded before this one in index.html), and
 * imports dash-common.js's session helpers as real ES module imports.
 * ----------------------------------------------------------------------------
 */
import { saveDashboardSession, readDashboardSession, requireDashboardSession, renderDashNav } from "./dash-common.js";

const storage = new ApiStorage(BACKEND_URL);

let state = { page: 1, pageSize: 25, search: "", side: "" };

async function boot() {
  // Every listener is wired BEFORE the restored-session branch below. The
  // search/pagination controls live on dashboardScreen, which is exactly the
  // screen a restored session jumps straight to -- returning early here (as
  // this used to) left Search/Prev/Next permanently dead on every visit after
  // the first login, and on every back-navigation from review/studies/audit.
  document.getElementById("loginBtn").addEventListener("click", login);
  document.getElementById("continueBtn").addEventListener("click", pickReviewer);
  document.getElementById("searchBtn").addEventListener("click", () => {
    state.page = 1;
    state.search = document.getElementById("searchInput").value.trim();
    state.side = document.getElementById("sideFilter").value;
    loadSessions();
  });
  document.getElementById("prevPageBtn").addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      loadSessions();
    }
  });
  document.getElementById("nextPageBtn").addEventListener("click", () => {
    state.page += 1;
    loadSessions();
  });

  const existing = readDashboardSession();
  if (existing?.dashboardToken && existing?.reviewerId) {
    storage.dashboardToken = existing.dashboardToken;
    showDashboard(existing);
  }
}

async function login() {
  const passcode = document.getElementById("passcodeInput").value;
  try {
    const data = await storage.dashboardLogin(passcode);
    saveDashboardSession({ dashboardToken: data.dashboardToken, reviewerId: null, reviewerName: null });
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("reviewerScreen").classList.remove("hidden");
    await loadReviewers();
  } catch (err) {
    document.getElementById("loginError").textContent = err.message;
  }
}

async function loadReviewers() {
  const { reviewers } = await storage.getReviewers();
  const select = document.getElementById("reviewerSelect");
  select.innerHTML = `<option value="">— select a reviewer —</option>` + reviewers.map((r) => `<option value="${r.id}">${r.name}</option>`).join("");
}

async function pickReviewer() {
  const selectedId = document.getElementById("reviewerSelect").value;
  const newName = document.getElementById("newReviewerInput").value.trim();
  try {
    let reviewerId = selectedId;
    if (newName) {
      const created = await storage.addReviewer(newName);
      reviewerId = created.id;
    }
    if (!reviewerId) {
      document.getElementById("reviewerError").textContent = "Select an existing reviewer or add a new one.";
      return;
    }
    const result = await storage.pickReviewer(reviewerId);
    const session = { dashboardToken: storage.dashboardToken, reviewerId, reviewerName: result.reviewerName };
    saveDashboardSession(session);
    showDashboard(session);
  } catch (err) {
    document.getElementById("reviewerError").textContent = err.message;
  }
}

function showDashboard(session) {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("reviewerScreen").classList.add("hidden");
  document.getElementById("dashboardScreen").classList.remove("hidden");
  renderDashNav(document.getElementById("navContainer"), session, "index");
  loadSessions();
}

async function loadSessions() {
  const tbody = document.getElementById("sessionsBody");
  tbody.innerHTML = `<tr><td colspan="7" style="color:var(--slate);">Loading...</td></tr>`;
  try {
    const { sessions, total, page, pageSize } = await storage.getDashboardSessions(state);
    if (sessions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--slate);">No patients match this search.</td></tr>`;
    } else {
      tbody.innerHTML = sessions
        .map(
          (s) => `
        <tr data-session-id="${s.sessionId}">
          <td>${s.patientLabel}</td>
          <td>${s.side}</td>
          <td>${s.hospitalId ?? "—"}</td>
          <td>${new Date(s.createdAt).toLocaleDateString()}</td>
          <td>${s.tasksCompleted}/${s.tasksTotal}</td>
          <td><span class="status-pill ${s.reviewStatus}">${s.reviewStatus}</span></td>
          <td>${s.lastReviewedBy ?? "—"}</td>
        </tr>
      `
        )
        .join("");
      tbody.querySelectorAll("tr[data-session-id]").forEach((row) => {
        row.addEventListener("click", () => {
          window.location.href = `review.html?sessionId=${row.dataset.sessionId}`;
        });
      });
    }
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    document.getElementById("pageInfo").textContent = `${start}-${end} of ${total}`;
    document.getElementById("prevPageBtn").disabled = page <= 1;
    document.getElementById("nextPageBtn").disabled = end >= total;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="flag">Could not load patients: ${err.message}</td></tr>`;
  }
}

window.addEventListener("DOMContentLoaded", boot);
