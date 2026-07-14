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

  async createSession({ sessionId, patientLabel, side, thetaVersion, stage01 }) {
    const data = await this._json("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionId, patientLabel, side, thetaVersion, stage01 }),
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
      return { ok: true, session: data.session, taskResults: data.taskResults, captures, thetaResult: data.thetaResult };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async publishThetaConfig(config) {
    return this._json("/api/theta-config", { method: "POST", body: JSON.stringify(config) });
  }

  async getThetaConfig(version) {
    return this._json(`/api/theta-config/${version}`);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ApiStorage };
} else {
  window.ApiStorage = ApiStorage;
}
