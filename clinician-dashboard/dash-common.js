/**
 * dash-common.js — Phase 9: shared session/nav plumbing for the multi-page
 * clinician dashboard.
 * ----------------------------------------------------------------------------
 * The dashboard is a classic multi-page app (index.html / review.html /
 * studies.html / audit.html), not an SPA -- ApiStorage only holds
 * dashboardToken in memory per page load, so this module persists
 * {dashboardToken, reviewerId, reviewerName} to sessionStorage (cleared
 * when the browser tab closes, matching the 12h server-side token TTL's
 * "spans a shift" intent without outliving the tab) and restores it on
 * every page boot. Any page missing a valid session redirects to
 * index.html's login gate.
 * ----------------------------------------------------------------------------
 */
const STORAGE_KEY = "romDashboardSession";

function saveDashboardSession({ dashboardToken, reviewerId, reviewerName }) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ dashboardToken, reviewerId, reviewerName }));
}

function readDashboardSession() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function clearDashboardSession() {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** Call at the top of every page except index.html. Restores the session
 *  into `storage` and returns it, or redirects to the login gate. */
function requireDashboardSession(storage) {
  const session = readDashboardSession();
  if (!session || !session.dashboardToken || !session.reviewerId) {
    window.location.href = "index.html";
    return null;
  }
  storage.dashboardToken = session.dashboardToken;
  return session;
}

/** Renders the consistent top nav (Patients / Studies / Audit Log +
 *  "Reviewing as: X" + Log out) into `container` on every page but the
 *  login gate. `activePage` highlights the current link. */
function renderDashNav(container, session, activePage) {
  const links = [
    { href: "index.html", label: "Patients", key: "index" },
    { href: "studies.html", label: "Studies", key: "studies" },
    { href: "audit.html", label: "Audit Log", key: "audit" },
  ];
  container.innerHTML = `
    <nav class="dash-nav">
      <div class="dash-nav-links">
        ${links.map((l) => `<a href="${l.href}" class="${l.key === activePage ? "active" : ""}">${l.label}</a>`).join("")}
      </div>
      <div class="dash-nav-reviewer">
        <span class="eyebrow">Reviewing as</span> ${session.reviewerName}
        <button class="btn" id="dashLogoutBtn" style="margin-left:12px; padding:4px 10px; font-size:12px;">Log out</button>
      </div>
    </nav>
  `;
  document.getElementById("dashLogoutBtn").addEventListener("click", () => {
    clearDashboardSession();
    window.location.href = "index.html";
  });
}

export { saveDashboardSession, readDashboardSession, clearDashboardSession, requireDashboardSession, renderDashNav };
