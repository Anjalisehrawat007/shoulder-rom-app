/**
 * storage.js
 * ----------------------------------------------------------------------------
 * Local-first storage for sessions, captured photos and computed parameters.
 * Uses IndexedDB (this is a prototype; a production deployment should sync
 * this to a HIPAA/GDPR-appropriate encrypted backend rather than keeping
 * PHI only on-device). Access codes are never stored in plain text -- only
 * their SHA-256 hash, via the Web Crypto API.
 * ----------------------------------------------------------------------------
 */

const DB_NAME = "shoulder_rom_db";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains("captures")) {
        const store = db.createObjectStore("captures", { keyPath: "captureId" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomAccessCode() {
  // 8-character human-friendly code, unambiguous alphabet (no 0/O/1/I).
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out.match(/.{1,4}/g).join("-");
}

class RomStorage {
  async _db() {
    if (!this._dbPromise) this._dbPromise = openDb();
    return this._dbPromise;
  }

  async createSession({ patientLabel, side, thetaVersion, stage01 }) {
    const db = await this._db();
    const accessCode = randomAccessCode();
    const accessCodeHash = await sha256Hex(accessCode);
    const session = {
      sessionId: crypto.randomUUID(),
      patientLabel,
      side,
      thetaVersion,
      stage01,
      accessCodeHash,
      createdAt: new Date().toISOString(),
      taskResults: {}, // taskId -> {parameters, thetaScore}
    };
    await new Promise((res, rej) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    // Return the plaintext code ONCE -- caller must show it to the clinician/patient now.
    return { sessionId: session.sessionId, accessCode };
  }

  async saveTaskResult(sessionId, taskId, payload) {
    const db = await this._db();
    const session = await this.getSessionRaw(sessionId);
    session.taskResults[taskId] = payload;
    await new Promise((res, rej) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  async saveCapture({ sessionId, taskId, blob, parameters, timestamp }) {
    const db = await this._db();
    const capture = {
      captureId: crypto.randomUUID(),
      sessionId,
      taskId,
      blob,
      parameters,
      timestamp,
    };
    await new Promise((res, rej) => {
      const tx = db.transaction("captures", "readwrite");
      tx.objectStore("captures").put(capture);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    return capture.captureId;
  }

  async getSessionRaw(sessionId) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").get(sessionId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Doctor-side: verify code, and if valid return the session + its captures (without exposing the hash). */
  async unlockSession(sessionId, accessCode) {
    const session = await this.getSessionRaw(sessionId);
    if (!session) return { ok: false, reason: "session not found" };
    const hash = await sha256Hex(accessCode.trim().toUpperCase());
    if (hash !== session.accessCodeHash) return { ok: false, reason: "invalid access code" };

    const db = await this._db();
    const captures = await new Promise((resolve, reject) => {
      const tx = db.transaction("captures", "readonly");
      const idx = tx.objectStore("captures").index("sessionId");
      const req = idx.getAll(sessionId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const { accessCodeHash, ...safeSession } = session;
    return { ok: true, session: safeSession, captures };
  }

  async listSessionIds() {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { RomStorage };
} else {
  window.RomStorage = RomStorage;
}
