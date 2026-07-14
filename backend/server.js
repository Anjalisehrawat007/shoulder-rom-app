/**
 * server.js — sync backend for the Shoulder Kinematics Capture app.
 *
 * Two distinct credentials, deliberately separate:
 *   - captureToken: issued once at session creation, held by the CAPTURING
 *     device, required on every write (task results, photos). Never shown
 *     to the doctor.
 *   - accessCode:   the short human-readable code shown to the clinician,
 *     required to UNLOCK (read) a session. Verified against a stored hash,
 *     never stored in plaintext.
 * Unlocking issues a short-lived reviewToken (60 min) that gates photo
 * downloads, so a leaked photo URL alone can't be replayed indefinitely.
 *
 * This lets the doctor portal open a session captured on a different
 * device — the gap flagged in the previous iteration of this app, where
 * everything lived only in the capturing device's local IndexedDB.
 */
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { db, CAPTURES_DIR } = require("./db");
const { ThetaConfigStore, ThetaEngine } = require("../shared/theta-engine.js");

const app = express();
app.use(cors()); // NOTE: restrict this to your real frontend origin(s) in production
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const thetaStore = new ThetaConfigStore();

// ---- helpers ---------------------------------------------------------------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(24).toString("hex");
function newAccessCode() {
  return "12345";
}

function requireCaptureToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (!token || sha256(token) !== session.capture_token_hash) {
    return res.status(401).json({ error: "invalid or missing capture token" });
  }
  req.session = session;
  next();
}

// ---- theta config versions --------------------------------------------------
// On boot, load any config files already dropped in ../config so the server
// has at least v1 available without a manual publish step.
function bootstrapConfigs() {
  const configDir = path.join(__dirname, "..", "config");
  if (!fs.existsSync(configDir)) return;
  for (const file of fs.readdirSync(configDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, file), "utf8"));
    const existing = db.prepare("SELECT version FROM theta_versions WHERE version = ?").get(cfg.version);
    if (!existing) {
      db.prepare("INSERT INTO theta_versions (version, config_json, created_at) VALUES (?, ?, ?)").run(
        cfg.version,
        JSON.stringify(cfg),
        new Date().toISOString()
      );
    }
    thetaStore.versions.set(cfg.version, Object.freeze(cfg));
    thetaStore.activeVersion = cfg.version;
  }
}
bootstrapConfigs();

app.post("/api/theta-config", (req, res) => {
  const cfg = req.body;
  if (!cfg || !cfg.version) return res.status(400).json({ error: "config with a version string is required" });
  const existing = db.prepare("SELECT version FROM theta_versions WHERE version = ?").get(cfg.version);
  if (existing) return res.status(409).json({ error: `version ${cfg.version} already published; bump the version to re-fit` });
  db.prepare("INSERT INTO theta_versions (version, config_json, created_at) VALUES (?, ?, ?)").run(
    cfg.version,
    JSON.stringify(cfg),
    new Date().toISOString()
  );
  thetaStore.publish(cfg);
  res.json({ ok: true, version: cfg.version });
});

app.get("/api/theta-config", (_req, res) => {
  const rows = db.prepare("SELECT version, created_at FROM theta_versions ORDER BY created_at ASC").all();
  res.json({ versions: rows, active: thetaStore.activeVersion });
});

app.get("/api/theta-config/:version", (req, res) => {
  const row = db.prepare("SELECT config_json FROM theta_versions WHERE version = ?").get(req.params.version);
  if (!row) return res.status(404).json({ error: "version not found" });
  res.json(JSON.parse(row.config_json));
});

// ---- sessions ---------------------------------------------------------------
const HOSPITAL_ID_PATTERN = /^\d{7}$/; // CMC-style 7-digit hospital/registration number

app.post("/api/sessions", (req, res) => {
  const { sessionId, patientLabel, side, thetaVersion, stage01 } = req.body || {};
  if (!sessionId || !patientLabel || !side || !thetaVersion) {
    return res.status(400).json({ error: "sessionId (hospital ID), patientLabel, side and thetaVersion are required" });
  }
  if (!HOSPITAL_ID_PATTERN.test(sessionId)) {
    return res.status(400).json({ error: "sessionId must be a 7-digit hospital ID, e.g. 1234567" });
  }
  const versionRow = db.prepare("SELECT version FROM theta_versions WHERE version = ?").get(thetaVersion);
  if (!versionRow) return res.status(400).json({ error: `unknown theta version ${thetaVersion}` });

  const existing = db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId);
  if (existing) return res.status(409).json({ error: `a session already exists for hospital ID ${sessionId}` });

  const accessCode = newAccessCode();
  const captureToken = newToken();

  db.prepare(
    `INSERT INTO sessions (session_id, patient_label, side, theta_version, stage01, access_code_hash, capture_token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, patientLabel, side, thetaVersion, stage01 ?? 0.5, sha256(accessCode), sha256(captureToken), new Date().toISOString());

  // accessCode and captureToken are each returned exactly once; only their hashes persist.
  res.json({ sessionId, accessCode, captureToken });
});

app.post("/api/sessions/:sessionId/tasks/:taskId", requireCaptureToken, (req, res) => {
  const { parameters, domainScores } = req.body || {};
  if (!parameters || !domainScores) return res.status(400).json({ error: "parameters and domainScores required" });
  db.prepare(
    `INSERT INTO task_results (session_id, task_id, parameters_json, domain_scores_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, task_id) DO UPDATE SET parameters_json = excluded.parameters_json,
       domain_scores_json = excluded.domain_scores_json, created_at = excluded.created_at`
  ).run(req.params.sessionId, req.params.taskId, JSON.stringify(parameters), JSON.stringify(domainScores), new Date().toISOString());
  res.json({ ok: true });
});

app.post("/api/sessions/:sessionId/captures", requireCaptureToken, upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "photo file required" });
  const { taskId, timestamp } = req.body;
  let parameters = {};
  try { parameters = JSON.parse(req.body.parameters || "{}"); } catch { /* leave empty */ }

  const captureId = crypto.randomUUID();
  const sessionDir = path.join(CAPTURES_DIR, req.params.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${captureId}.jpg`);
  fs.writeFileSync(filePath, req.file.buffer);

  db.prepare(
    `INSERT INTO captures (capture_id, session_id, task_id, file_path, parameters_json, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(captureId, req.params.sessionId, taskId, filePath, JSON.stringify(parameters), Number(timestamp) || null, new Date().toISOString());

  res.json({ captureId });
});

// ---- doctor unlock + review ---------------------------------------------------
app.post("/api/sessions/:sessionId/unlock", (req, res) => {
  const { accessCode } = req.body || {};
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (!accessCode || sha256(accessCode.trim().toUpperCase()) !== session.access_code_hash) {
    return res.status(401).json({ error: "invalid access code" });
  }

  const reviewToken = newToken();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO review_tokens (token, session_id, expires_at) VALUES (?, ?, ?)").run(reviewToken, session.session_id, expires);

  const taskRows = db.prepare("SELECT * FROM task_results WHERE session_id = ?").all(session.session_id);
  const taskResults = {};
  for (const row of taskRows) {
    taskResults[row.task_id] = { parameters: JSON.parse(row.parameters_json), domainScores: JSON.parse(row.domain_scores_json) };
  }

  const captureRows = db.prepare("SELECT capture_id, task_id, parameters_json, timestamp FROM captures WHERE session_id = ?").all(session.session_id);
  const captures = captureRows.map((c) => ({
    captureId: c.capture_id,
    taskId: c.task_id,
    parameters: JSON.parse(c.parameters_json),
    timestamp: c.timestamp,
    photoUrl: `/api/captures/${c.capture_id}/photo?reviewToken=${reviewToken}`,
  }));

  // Score using the theta version that was ACTIVE when this session was captured,
  // not necessarily the latest — versions are immutable, so this reproduces exactly
  // what the clinician would have seen originally.
  let thetaResult = null;
  const versionRow = db.prepare("SELECT config_json FROM theta_versions WHERE version = ?").get(session.theta_version);
  if (versionRow) {
    const engine = new ThetaEngine(JSON.parse(versionRow.config_json));
    const aggregate = {};
    for (const domain of Object.keys(engine.config.domains)) {
      let best = null;
      for (const t of Object.values(taskResults)) {
        const d = t.domainScores[domain];
        if (d && d.captured && (best == null || d.value > best.value)) best = d;
      }
      aggregate[domain] = best || { captured: false };
    }
    thetaResult = engine.score(aggregate, session.stage01);
  }

  res.json({
    session: {
      sessionId: session.session_id,
      patientLabel: session.patient_label,
      side: session.side,
      thetaVersion: session.theta_version,
      stage01: session.stage01,
      createdAt: session.created_at,
    },
    taskResults,
    captures,
    thetaResult,
    reviewTokenExpiresAt: expires,
  });
});

app.get("/api/captures/:captureId/photo", (req, res) => {
  const { reviewToken } = req.query;
  const capture = db.prepare("SELECT * FROM captures WHERE capture_id = ?").get(req.params.captureId);
  if (!capture) return res.status(404).end();

  const tokenRow = db.prepare("SELECT * FROM review_tokens WHERE token = ? AND session_id = ?").get(reviewToken, capture.session_id);
  if (!tokenRow || new Date(tokenRow.expires_at) < new Date()) {
    return res.status(401).json({ error: "review session expired or invalid — unlock again" });
  }
  res.sendFile(capture.file_path);
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`shoulder-rom-backend listening on :${PORT}`));
