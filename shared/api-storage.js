/**
 * api-storage.js
 * ----------------------------------------------------------------------------
 * Talks to the backend in /backend instead of the browser's local IndexedDB,
 * so a session captured on one device (the child's tablet/phone) can be
 * opened on a different device (the clinician's computer) using the access
 * code. Same method names as the old local-only RomStorage, so app.js /
 * portal.js only need their storage object swapped, not rewritten.
 * ----------------------------------------------------------------------------
 */
class ApiStorage {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.captureToken = null; // held only by the capturing device, in memory
  }

  async _json(path, opts = {}) {
    const res = await fetch(this.baseUrl + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request failed: ${res.status}`);
    }
    return res.json();
  }

  async createSession({ sessionId, patientLabel, side, asriVersion, referenceDatasetVersion, stage01, ageMonths, monthsSinceSurgery, protocol }) {
    const data = await this._json("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionId, patientLabel, side, asriVersion, referenceDatasetVersion, stage01, ageMonths, monthsSinceSurgery, protocol }),
    });
    this.captureToken = data.captureToken;
    return { sessionId: data.sessionId, accessCode: data.accessCode };
  }

  async saveTaskResult(sessionId, taskId, payload) {
    await this._json(`/api/sessions/${sessionId}/tasks/${taskId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.captureToken}` },
      body: JSON.stringify(payload),
    });
  }

  async saveCapture({ sessionId, taskId, blob, parameters, timestamp }) {
    const form = new FormData();
    form.append("photo", blob, "capture.jpg");
    form.append("taskId", taskId);
    form.append("timestamp", String(timestamp ?? ""));
    form.append("parameters", JSON.stringify(parameters ?? {}));
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/captures`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.captureToken}` },
      body: form,
    });
    if (!res.ok) throw new Error("capture upload failed: " + res.status);
    return (await res.json()).captureId;
  }

  /** Doctor-side: verify code against the backend, returns session + captures with photo URLs. */
  async unlockSession(sessionId, accessCode) {
    try {
      const data = await this._json(`/api/sessions/${sessionId}/unlock`, {
        method: "POST",
        body: JSON.stringify({ accessCode }),
      });
      const captures = data.captures.map((c) => ({ ...c, photoUrl: this.baseUrl + c.photoUrl }));
      return { ok: true, session: data.session, taskResults: data.taskResults, captures, asriResult: data.asriResult };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async publishAsriConfig(config) {
    return this._json("/api/asri-config", { method: "POST", body: JSON.stringify(config) });
  }

  async getAsriConfig(version) {
    return this._json(`/api/asri-config/${version}`);
  }

  async getReferenceDatasets(version) {
    return this._json(`/api/reference-datasets/${version}`);
  }

  async getIcqaConfig(version) {
    return this._json(`/api/icqa-config/${version}`);
  }

  async getMalletScoreConfig(version) {
    return this._json(`/api/mallet-score-config/${version}`);
  }

  /** Phase 6: uploads this task's raw+filtered landmark sequence (as one
   *  JSON file) and/or its recorded video clip. Either can be omitted --
   *  a browser without MediaRecorder support just uploads landmarks. */
  async saveTaskData({ sessionId, taskId, videoBlob, rawLandmarks, filteredLandmarks }) {
    const form = new FormData();
    if (videoBlob) form.append("video", videoBlob, "task.webm");
    if (rawLandmarks) {
      const landmarksBlob = new Blob([JSON.stringify({ raw: rawLandmarks, filtered: filteredLandmarks || [] })], { type: "application/json" });
      form.append("landmarks", landmarksBlob, "landmarks.json");
    }
    if (!videoBlob && !rawLandmarks) return null;
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/tasks/${taskId}/data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.captureToken}` },
      body: form,
    });
    if (!res.ok) throw new Error("task-data upload failed: " + res.status);
    return res.json();
  }

  /** Phase 6, resume support: requires this.captureToken to already be set
   *  (restored from localStorage by the caller after a page reload --
   *  this class holds it in memory only, same as every other write here). */
  async resumeSession(sessionId) {
    return this._json(`/api/sessions/${sessionId}/resume`, {
      headers: { Authorization: `Bearer ${this.captureToken}` },
    });
  }

  /** Doctor-side: submit a clinician's review of an AI-predicted Mallet
   *  grade. Append-only server-side -- never overwrites the prediction or
   *  a prior override (see backend/db.js's mallet_grade_overrides table). */
  async submitMalletOverride(sessionId, taskId, { clinicianGrade, overrideReason, clinicianName, supersedesId }) {
    return this._json(`/api/sessions/${sessionId}/tasks/${taskId}/mallet-override`, {
      method: "POST",
      body: JSON.stringify({ clinicianGrade, overrideReason, clinicianName, supersedesId }),
    });
  }

  async getMalletOverrides(sessionId) {
    return this._json(`/api/sessions/${sessionId}/mallet-overrides`);
  }

  malletReportUrl(sessionId, format = "json") {
    return `${this.baseUrl}/api/sessions/${sessionId}/mallet-report/${format}`;
  }

  /** Doctor-portal convenience: fetches the same structured report object
   *  the JSON/PDF endpoints render from, so the portal doesn't need to
   *  re-derive overall-score/agreement logic that already lives in
   *  shared/reporting/report-generator.js -- one source of truth. */
  async getMalletReport(sessionId) {
    return this._json(`/api/sessions/${sessionId}/mallet-report/json`);
  }

  // ---- Phase 9: Clinician Research Dashboard --------------------------------
  // dashboardToken is held the same way captureToken is -- in memory only,
  // set once at login, added as a Bearer header to every dashboard-gated
  // call below. The caller (dashboard.js) is responsible for persisting it
  // to sessionStorage across page navigations within the dashboard and
  // restoring it into this field on each page load.

  _dashHeaders(extra = {}) {
    return { Authorization: `Bearer ${this.dashboardToken}`, ...extra };
  }

  async dashboardLogin(passcode) {
    const data = await this._json("/api/dashboard/login", { method: "POST", body: JSON.stringify({ passcode }) });
    this.dashboardToken = data.dashboardToken;
    return data;
  }

  async getReviewers() {
    return this._json("/api/dashboard/reviewers", { headers: this._dashHeaders() });
  }

  async addReviewer(name) {
    return this._json("/api/dashboard/reviewers", { method: "POST", headers: this._dashHeaders(), body: JSON.stringify({ name }) });
  }

  async pickReviewer(reviewerId) {
    return this._json("/api/dashboard/reviewer-session", { method: "POST", headers: this._dashHeaders(), body: JSON.stringify({ reviewerId }) });
  }

  async getDashboardSessions({ search, side, datasetId, page, pageSize } = {}) {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (side) params.set("side", side);
    if (datasetId) params.set("datasetId", datasetId);
    if (page) params.set("page", page);
    if (pageSize) params.set("pageSize", pageSize);
    return this._json(`/api/dashboard/sessions?${params.toString()}`, { headers: this._dashHeaders() });
  }

  async getSessionSummary(sessionId) {
    return this._json(`/api/dashboard/sessions/${sessionId}/summary`, { headers: this._dashHeaders() });
  }

  async getAngleTimeseries(sessionId, taskId, reviewToken) {
    return this._json(`/api/sessions/${sessionId}/tasks/${taskId}/angle-timeseries?reviewToken=${reviewToken}`);
  }

  async submitParameterOverride(sessionId, { taskId, fieldKey, fieldLabel, overriddenValue, overrideReason, supersedesId }) {
    return this._json(`/api/sessions/${sessionId}/parameter-overrides`, {
      method: "POST",
      headers: this._dashHeaders(),
      body: JSON.stringify({ taskId, fieldKey, fieldLabel, overriddenValue, overrideReason, supersedesId }),
    });
  }

  async getParameterOverrides(sessionId) {
    return this._json(`/api/sessions/${sessionId}/parameter-overrides`, { headers: this._dashHeaders() });
  }

  async getComparison(sessionId) {
    return this._json(`/api/dashboard/sessions/${sessionId}/comparison`, { headers: this._dashHeaders() });
  }

  async submitClinicianAssessment(payload) {
    return this._json("/api/clinician-assessments", { method: "POST", body: JSON.stringify(payload) });
  }

  async getAuditLog({ sessionId, reviewerName, entityType, page, pageSize } = {}) {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    if (reviewerName) params.set("reviewerName", reviewerName);
    if (entityType) params.set("entityType", entityType);
    if (page) params.set("page", page);
    if (pageSize) params.set("pageSize", pageSize);
    return this._json(`/api/dashboard/audit-log?${params.toString()}`, { headers: this._dashHeaders() });
  }

  async getStudies(type) {
    return this._json(`/api/validation-datasets${type ? `?type=${type}` : ""}`);
  }

  async createStudy({ name, type, notes }) {
    return this._json("/api/validation-datasets", { method: "POST", body: JSON.stringify({ name, type, notes }) });
  }

  async assignSession(datasetId, { sessionId, assignedReviewer }) {
    return this._json(`/api/validation-datasets/${datasetId}/sessions`, { method: "POST", body: JSON.stringify({ sessionId, assignedReviewer }) });
  }

  async updateAssignment(datasetId, sessionId, { status, assignedReviewer }) {
    return this._json(`/api/validation-datasets/${datasetId}/sessions/${sessionId}`, {
      method: "PATCH",
      headers: this._dashHeaders(),
      body: JSON.stringify({ status, assignedReviewer }),
    });
  }

  async updateStudyStatus(datasetId, status) {
    return this._json(`/api/validation-datasets/${datasetId}`, { method: "PATCH", headers: this._dashHeaders(), body: JSON.stringify({ status }) });
  }

  async getStudyStats(datasetId) {
    return this._json(`/api/validation-datasets/${datasetId}/stats`, { headers: this._dashHeaders() });
  }

  async getStudyMembers(datasetId) {
    return this._json(`/api/validation-datasets/${datasetId}/sessions`, { headers: this._dashHeaders() });
  }

  researchReportUrl(sessionId, format = "json") {
    return `${this.baseUrl}/api/dashboard/sessions/${sessionId}/research-report/${format}`;
  }

  exportUrl(format, { datasetId, sessionIds } = {}) {
    const params = new URLSearchParams();
    if (datasetId) params.set("datasetId", datasetId);
    if (sessionIds) params.set("sessionIds", sessionIds.join(","));
    return `${this.baseUrl}/api/dashboard/export/${format}?${params.toString()}`;
  }

  /** Every dashboard export/report route requires a Bearer dashboardToken,
   *  unlike malletReportUrl()'s plain public link -- a bare <a href> can't
   *  attach that header, so downloads go through fetch() + a Blob + a
   *  synthetic click on an object URL instead. */
  async downloadWithAuth(url, filename) {
    const res = await fetch(url, { headers: this._dashHeaders() });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ApiStorage };
} else {
  window.ApiStorage = ApiStorage;
}
