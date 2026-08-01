/**
 * audit.js — Phase 9: global, filterable audit history across all sessions.
 * ----------------------------------------------------------------------------
 * Every write endpoint in backend/server.js that mutates a clinical record
 * (Mallet override, parameter override, clinician assessment, study
 * assignment/status) writes one audit_log row inside the SAME
 * db.transaction() as the primary write (see recordAudit() in server.js) --
 * this page is a pure read/filter view over that table via
 * GET /api/dashboard/audit-log, nothing computed client-side.
 * ----------------------------------------------------------------------------
 */
import { requireDashboardSession, renderDashNav } from "./dash-common.js";

const storage = new ApiStorage(BACKEND_URL);
let state = { page: 1, pageSize: 50, sessionId: "", reviewerName: "", entityType: "" };

async function boot() {
  const dashSession = requireDashboardSession(storage);
  if (!dashSession) return;
  renderDashNav(document.getElementById("navContainer"), dashSession, "audit");

  document.getElementById("filterBtn").addEventListener("click", () => {
    state.page = 1;
    state.sessionId = document.getElementById("sessionIdFilter").value.trim();
    state.reviewerName = document.getElementById("reviewerFilter").value.trim();
    state.entityType = document.getElementById("entityTypeFilter").value;
    load();
  });
  document.getElementById("prevPageBtn").addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  document.getElementById("nextPageBtn").addEventListener("click", () => {
    state.page += 1;
    load();
  });

  await load();
}

async function load() {
  const list = document.getElementById("auditList");
  list.innerHTML = `<p style="color:var(--slate);">Loading...</p>`;
  try {
    const { entries, total, page, pageSize } = await storage.getAuditLog(state);
    if (entries.length === 0) {
      list.innerHTML = `<p style="color:var(--slate);">No audit entries match this filter.</p>`;
    } else {
      list.innerHTML = entries
        .map(
          (e) => `
        <div class="audit-entry">
          <div>${e.summary}${e.sessionId ? ` <a href="review.html?sessionId=${e.sessionId}" style="font-size:11px;">(open session)</a>` : ""}</div>
          <div class="audit-meta">${e.entityType} · ${e.action} · by ${e.reviewerName} · ${new Date(e.createdAt).toLocaleString()}</div>
        </div>
      `
        )
        .join("");
    }
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    document.getElementById("pageInfo").textContent = `${start}-${end} of ${total}`;
    document.getElementById("prevPageBtn").disabled = page <= 1;
    document.getElementById("nextPageBtn").disabled = end >= total;
  } catch (err) {
    list.innerHTML = `<p class="flag">Could not load the audit log: ${err.message}</p>`;
  }
}

window.addEventListener("DOMContentLoaded", boot);
