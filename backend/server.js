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
 * shared/asri/* (the ASRI Engine) is a pure ES module (see
 * shared/asri/package.json), while this backend is CommonJS -- loaded here
 * via a dynamic import() inside the async bootstrap below, Node's standard
 * way to consume an ESM module from a CJS file without converting the whole
 * backend.
 */
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { db, CAPTURES_DIR, TASK_DATA_DIR } = require("./db");
const { renderMalletReportPdf, renderResearchReportPdf, renderValidationReportPdf } = require("./pdf-renderer");
const { renderResearchXlsx } = require("./xlsx-renderer");

const app = express();
app.use(cors()); // NOTE: restrict this to your real frontend origin(s) in production
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
// Task video clips (~7-10s WebM) run larger than a single JPEG still -- a
// separate multer instance with a higher limit, rather than loosening the
// photo-upload limit above for everyone.
const uploadTaskData = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

// ---- helpers ---------------------------------------------------------------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(24).toString("hex");
/** Per-session access code shown once to the clinician and required (with the
 *  session id) to open that session in the doctor portal. Only its sha256 is
 *  persisted; the plaintext is returned exactly once at creation.
 *
 *  Previously a hardcoded "12345" for every session, which meant one guessed
 *  code plus a 7-digit hospital registration number -- sequential and
 *  therefore enumerable -- exposed any patient's photos, video, and
 *  assessment.
 *
 *  crypto.randomInt is a CSPRNG and rejection-samples internally, so the draw
 *  is uniform over the range rather than modulo-biased. The lower bound of
 *  10_000_000 keeps the result exactly 8 digits with no leading zero, so the
 *  code survives any accidental numeric coercion on the way to a clinician
 *  (spreadsheet paste, autofill) at a cost of 90M rather than 100M values.
 *
 *  DIGITS ONLY, deliberately: the unlock route verifies
 *  sha256(accessCode.trim().toUpperCase()) while session creation stores
 *  sha256(accessCode) un-normalized. toUpperCase() is a no-op on digits, so
 *  the two agree. Introducing letters here without also normalizing at the
 *  storage site would make every unlock fail. */
function newAccessCode() {
  return String(crypto.randomInt(10_000_000, 100_000_000));
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

const HOSPITAL_ID_PATTERN = /^\d{7}$/; // CMC-style 7-digit hospital/registration number

// ---- Phase 9: Clinician Research Dashboard -- auth/identity ----------------
// Deliberately NOT a full accounts/authentication system (explicit scope
// decision, see the Phase 9 plan): one shared passcode gates the whole
// multi-patient dashboard, then a lightweight "reviewing as: [name]" picker
// tags actions. Same prototype-grade secret posture newAccessCode() already
// has -- an env var with a loud console warning if unset, not a stricter
// model this phase wasn't asked to build.
const DASHBOARD_PASSCODE = process.env.DASHBOARD_PASSCODE || "research-pilot-2026";
if (!process.env.DASHBOARD_PASSCODE) {
  console.warn("[dashboard] DASHBOARD_PASSCODE not set -- using an insecure default. Set DASHBOARD_PASSCODE before any real deployment.");
}
const DASHBOARD_PASSCODE_HASH = sha256(DASHBOARD_PASSCODE);
const DASHBOARD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h -- spans a full review shift, unlike the 60-min per-patient review token

function requireDashboardToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing dashboard token -- log in again" });
  const row = db.prepare("SELECT * FROM dashboard_tokens WHERE token = ?").get(token);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: "dashboard session expired or invalid -- log in again" });
  }
  req.dashboardToken = row;
  next();
}

// Every write endpoint that needs a reviewer identity uses THIS middleware,
// which attaches req.reviewer from the server-side token record -- never
// from the request body. This is what makes the audit trail non-spoofable:
// a client cannot claim to be a different reviewer than the one who is
// actually logged into that dashboard session.
function requireDashboardReviewer(req, res, next) {
  requireDashboardToken(req, res, () => {
    if (!req.dashboardToken.reviewer_id) {
      return res.status(401).json({ error: "pick a reviewer before performing this action" });
    }
    req.reviewer = { id: req.dashboardToken.reviewer_id, name: req.dashboardToken.reviewer_name };
    next();
  });
}

// Full audit trail helper -- callers pass their own db.transaction() wrapper
// around the primary write + this call so a row can never exist without the
// other (see each call site below).
function recordAudit({ sessionId = null, entityType, entityId = null, action, reviewerName, summary, detail = null }) {
  db.prepare(
    `INSERT INTO audit_log (session_id, entity_type, entity_id, action, reviewer_name, summary, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, entityType, entityId, action, reviewerName, summary, detail ? JSON.stringify(detail) : null, new Date().toISOString());
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
// Trims a full makeParameter() envelope down to the 3 fields a chart/export
// needs (value/measurementType/confidence) -- never re-derives or rounds the
// underlying measurement itself, just narrows the read-only projection.
function pickEnvelope(envelope) {
  if (!envelope) return { value: null, measurementType: "unavailable", confidence: null };
  return { value: envelope.value, measurementType: envelope.measurementType, confidence: envelope.confidence };
}

async function main() {
  const { VersionedConfigStore, AsriEngine } = await import("../shared/asri/asri-engine.js");
  const { resolveReferenceDataset } = await import("../shared/asri/reference-datasets.js");
  const { runValidation } = await import("../shared/validation/validation-engine.js");
  const { runQualityControl } = await import("../shared/validation/quality-control.js");
  const { buildValidationExportRows } = await import("../shared/validation/publication-tables.js");

  const { IcqaEngine } = await import("../shared/icqa/icqa-engine.js");
  const { VersionedConfigStore: IcqaVersionedConfigStore } = await import("../shared/icqa/config-store.js");
  const { ModifiedMalletScoreEngine, GRADE_NUMERIC } = await import("../shared/assessment/ModifiedMalletScoreEngine.js");
  const { VersionedConfigStore: MalletVersionedConfigStore } = await import("../shared/assessment/mallet-score-config-store.js");
  const { TASKS } = await import("../shared/assessment/TaskDefinitions.js");
  const { generateMalletReport } = await import("../shared/reporting/report-generator.js");
  const { buildResearchExportRows } = await import("../shared/reporting/research-export-rows.js");
  const { buildResearchCsv } = await import("../shared/reporting/csv-builder.js");
  const { generateResearchReport } = await import("../shared/reporting/research-report-generator.js");
  // Phase 9: read-only use of the frozen Biomechanical Engine to derive a
  // joint-angle time series for the dashboard's chart -- computeParameters()
  // itself is untouched; this just calls it per stored frame instead of
  // once live, same function, same contract.
  const { computeParameters } = await import("../shared/biomechanics/index.js");

  const asriConfigStore = new VersionedConfigStore();
  const referenceDatasetStore = new VersionedConfigStore();
  const icqaConfigStore = new IcqaVersionedConfigStore();
  const malletScoreConfigStore = new MalletVersionedConfigStore();

  /**
   * THE single authoritative source of a session's ASRI result.
   *
   * Previously three call sites disagreed: /unlock computed AND persisted,
   * buildMalletReport() computed but never persisted (so it silently produced
   * a second, unrecorded evaluation), and the research-report route only ever
   * SELECTed from asri_computations -- so a session that had never been opened
   * in the doctor portal reported `asri: null` in its research report while
   * the dashboard showed a real composite for the very same session. Live
   * execution isolated it exactly: before unlock `asri = null` with 0 rows,
   * after unlock `composite = 69` with 1 row, nothing else changed.
   *
   * Resolution order, and why:
   *  1. If a persisted row exists, return it verbatim. ASRI config and
   *     reference-dataset versions are immutable once published, so a stored
   *     result IS the score the clinician originally saw. Recomputing could
   *     only ever reproduce it or, if the underlying rows were later amended,
   *     silently contradict the record. Existing sessions therefore keep
   *     byte-identical values -- this is what makes the change backward
   *     compatible.
   *  2. Otherwise compute it once, using the session's own captured versions
   *     (not the latest), persist it, and return it. Persisting here is what
   *     removes the ordering dependency on the doctor portal: whichever
   *     surface asks first materialises the record for every other surface.
   *  3. If the versions or task data needed are absent, return null -- the
   *     same "insufficient data, do not fabricate" contract used everywhere
   *     else. Nothing is persisted in that case, so a later request can still
   *     succeed once the data exists.
   *
   * The scoring call itself is unchanged and appears exactly once in the
   * codebase now; no ASRI mathematics is touched.
   */
  function resolveAsriResult(session, perTaskParameters) {
    const existing = db
      .prepare("SELECT result_json FROM asri_computations WHERE session_id = ? ORDER BY computed_at DESC LIMIT 1")
      .get(session.session_id);
    if (existing) return JSON.parse(existing.result_json);

    const asriConfigRow = db.prepare("SELECT config_json FROM asri_config_versions WHERE version = ?").get(session.asri_version);
    const referenceConfigRow = session.reference_dataset_version
      ? db.prepare("SELECT config_json FROM reference_dataset_versions WHERE version = ?").get(session.reference_dataset_version)
      : null;
    if (!asriConfigRow || !referenceConfigRow || Object.keys(perTaskParameters).length === 0) return null;

    const engine = new AsriEngine(JSON.parse(asriConfigRow.config_json));
    const referenceTargets = resolveReferenceDataset(JSON.parse(referenceConfigRow.config_json), {
      ageMonths: session.age_months,
      monthsSinceSurgery: session.months_since_surgery,
      side: session.side,
      hospitalId: session.hospital_id,
    }).targets;
    const asriResult = engine.score({ perTaskParameters, referenceTargets, stage01: session.stage01 });

    db.prepare("INSERT INTO asri_computations (session_id, computed_at, asri_version, result_json) VALUES (?, ?, ?, ?)").run(
      session.session_id,
      new Date().toISOString(),
      session.asri_version,
      JSON.stringify(asriResult)
    );
    return asriResult;
  }

  /** Same resolver for callers that hold only a session id -- loads the session
   *  row and its per-task parameters, then delegates. Exists so no route has to
   *  re-implement that loading step and drift from the others again. */
  function resolveAsriForSession(sessionId) {
    const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    if (!session) return null;
    const perTaskParameters = {};
    for (const row of db.prepare("SELECT task_id, parameters_json FROM task_results WHERE session_id = ?").all(sessionId)) {
      perTaskParameters[row.task_id] = JSON.parse(row.parameters_json);
    }
    return resolveAsriResult(session, perTaskParameters);
  }

  // ---- config bootstrap -----------------------------------------------------
  // On boot, load config/asri-config*.json into asri_config_versions,
  // config/reference-datasets*.json into reference_dataset_versions, and
  // config/icqa-config*.json into icqa_config_versions. Other files in
  // config/ (e.g. the historical theta-config.v1.json from before the
  // Phase 2 rewrite) are left alone -- kept in the repo for the record, not
  // loaded by any engine.
  function bootstrapConfigs() {
    const configDir = path.join(__dirname, "..", "config");
    if (!fs.existsSync(configDir)) return;
    for (const file of fs.readdirSync(configDir).sort()) {
      if (!file.endsWith(".json")) continue;
      let table, store;
      if (file.startsWith("asri-config")) {
        table = "asri_config_versions";
        store = asriConfigStore;
      } else if (file.startsWith("reference-datasets")) {
        table = "reference_dataset_versions";
        store = referenceDatasetStore;
      } else if (file.startsWith("icqa-config")) {
        table = "icqa_config_versions";
        store = icqaConfigStore;
      } else if (file.startsWith("mallet-score-config")) {
        table = "mallet_score_config_versions";
        store = malletScoreConfigStore;
      } else {
        continue;
      }
      const cfg = JSON.parse(fs.readFileSync(path.join(configDir, file), "utf8"));
      const existing = db.prepare(`SELECT version FROM ${table} WHERE version = ?`).get(cfg.version);
      if (!existing) {
        db.prepare(`INSERT INTO ${table} (version, config_json, created_at) VALUES (?, ?, ?)`).run(
          cfg.version,
          JSON.stringify(cfg),
          new Date().toISOString()
        );
      }
      store.versions.set(cfg.version, Object.freeze(cfg));
      store.activeVersion = cfg.version;
    }
  }
  bootstrapConfigs();

  // ---- asri config versions --------------------------------------------------
  app.post("/api/asri-config", (req, res) => {
    const cfg = req.body;
    if (!cfg || !cfg.version) return res.status(400).json({ error: "config with a version string is required" });
    const existing = db.prepare("SELECT version FROM asri_config_versions WHERE version = ?").get(cfg.version);
    if (existing) return res.status(409).json({ error: `version ${cfg.version} already published; bump the version to re-fit` });
    db.prepare("INSERT INTO asri_config_versions (version, config_json, created_at) VALUES (?, ?, ?)").run(
      cfg.version,
      JSON.stringify(cfg),
      new Date().toISOString()
    );
    asriConfigStore.publish(cfg);
    res.json({ ok: true, version: cfg.version });
  });

  app.get("/api/asri-config", (_req, res) => {
    const rows = db.prepare("SELECT version, created_at FROM asri_config_versions ORDER BY created_at ASC").all();
    res.json({ versions: rows, active: asriConfigStore.activeVersion });
  });

  app.get("/api/asri-config/:version", (req, res) => {
    const row = db.prepare("SELECT config_json FROM asri_config_versions WHERE version = ?").get(req.params.version);
    if (!row) return res.status(404).json({ error: "version not found" });
    res.json(JSON.parse(row.config_json));
  });

  // ---- reference dataset versions --------------------------------------------
  app.post("/api/reference-datasets", (req, res) => {
    const cfg = req.body;
    if (!cfg || !cfg.version) return res.status(400).json({ error: "config with a version string is required" });
    const existing = db.prepare("SELECT version FROM reference_dataset_versions WHERE version = ?").get(cfg.version);
    if (existing) return res.status(409).json({ error: `version ${cfg.version} already published; bump the version to re-fit` });
    db.prepare("INSERT INTO reference_dataset_versions (version, config_json, created_at) VALUES (?, ?, ?)").run(
      cfg.version,
      JSON.stringify(cfg),
      new Date().toISOString()
    );
    referenceDatasetStore.publish(cfg);
    res.json({ ok: true, version: cfg.version });
  });

  app.get("/api/reference-datasets", (_req, res) => {
    const rows = db.prepare("SELECT version, created_at FROM reference_dataset_versions ORDER BY created_at ASC").all();
    res.json({ versions: rows, active: referenceDatasetStore.activeVersion });
  });

  app.get("/api/reference-datasets/:version", (req, res) => {
    const row = db.prepare("SELECT config_json FROM reference_dataset_versions WHERE version = ?").get(req.params.version);
    if (!row) return res.status(404).json({ error: "version not found" });
    res.json(JSON.parse(row.config_json));
  });

  // ---- icqa config versions (Phase 5) ----------------------------------------
  // Structurally identical to the asri-config trio above -- ICQA doesn't
  // import shared/asri/*, but there's no reason for its version-publishing
  // HTTP contract to differ from a pattern that already works.
  app.post("/api/icqa-config", (req, res) => {
    const cfg = req.body;
    if (!cfg || !cfg.version) return res.status(400).json({ error: "config with a version string is required" });
    const existing = db.prepare("SELECT version FROM icqa_config_versions WHERE version = ?").get(cfg.version);
    if (existing) return res.status(409).json({ error: `version ${cfg.version} already published; bump the version to re-fit` });
    db.prepare("INSERT INTO icqa_config_versions (version, config_json, created_at) VALUES (?, ?, ?)").run(
      cfg.version,
      JSON.stringify(cfg),
      new Date().toISOString()
    );
    icqaConfigStore.publish(cfg);
    res.json({ ok: true, version: cfg.version });
  });

  app.get("/api/icqa-config", (_req, res) => {
    const rows = db.prepare("SELECT version, created_at FROM icqa_config_versions ORDER BY created_at ASC").all();
    res.json({ versions: rows, active: icqaConfigStore.activeVersion });
  });

  app.get("/api/icqa-config/:version", (req, res) => {
    const row = db.prepare("SELECT config_json FROM icqa_config_versions WHERE version = ?").get(req.params.version);
    if (!row) return res.status(404).json({ error: "version not found" });
    res.json(JSON.parse(row.config_json));
  });

  // ---- mallet-score config versions (Phase 6) --------------------------------
  // Structurally identical to the asri-config/icqa-config trios above.
  app.post("/api/mallet-score-config", (req, res) => {
    const cfg = req.body;
    if (!cfg || !cfg.version) return res.status(400).json({ error: "config with a version string is required" });
    const existing = db.prepare("SELECT version FROM mallet_score_config_versions WHERE version = ?").get(cfg.version);
    if (existing) return res.status(409).json({ error: `version ${cfg.version} already published; bump the version to re-fit` });
    db.prepare("INSERT INTO mallet_score_config_versions (version, config_json, created_at) VALUES (?, ?, ?)").run(
      cfg.version,
      JSON.stringify(cfg),
      new Date().toISOString()
    );
    malletScoreConfigStore.publish(cfg);
    res.json({ ok: true, version: cfg.version });
  });

  app.get("/api/mallet-score-config", (_req, res) => {
    const rows = db.prepare("SELECT version, created_at FROM mallet_score_config_versions ORDER BY created_at ASC").all();
    res.json({ versions: rows, active: malletScoreConfigStore.activeVersion });
  });

  app.get("/api/mallet-score-config/:version", (req, res) => {
    const row = db.prepare("SELECT config_json FROM mallet_score_config_versions WHERE version = ?").get(req.params.version);
    if (!row) return res.status(404).json({ error: "version not found" });
    res.json(JSON.parse(row.config_json));
  });

  // ---- sessions ---------------------------------------------------------------
  app.post("/api/sessions", (req, res) => {
    const {
      sessionId,
      patientLabel,
      side,
      asriVersion,
      referenceDatasetVersion,
      stage01,
      ageMonths,
      monthsSinceSurgery,
      hospitalId,
      protocol,
    } = req.body || {};
    if (!sessionId || !patientLabel || !side || !asriVersion) {
      return res.status(400).json({ error: "sessionId (hospital ID), patientLabel, side and asriVersion are required" });
    }
    if (!HOSPITAL_ID_PATTERN.test(sessionId)) {
      return res.status(400).json({ error: "sessionId must be a 7-digit hospital ID, e.g. 1234567" });
    }
    const versionRow = db.prepare("SELECT version FROM asri_config_versions WHERE version = ?").get(asriVersion);
    if (!versionRow) return res.status(400).json({ error: `unknown asri version ${asriVersion}` });

    const resolvedReferenceVersion = referenceDatasetVersion || referenceDatasetStore.activeVersion || null;
    if (resolvedReferenceVersion) {
      const refRow = db.prepare("SELECT version FROM reference_dataset_versions WHERE version = ?").get(resolvedReferenceVersion);
      if (!refRow) return res.status(400).json({ error: `unknown reference dataset version ${resolvedReferenceVersion}` });
    }

    const existing = db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId);
    if (existing) return res.status(409).json({ error: `a session already exists for hospital ID ${sessionId}` });

    const accessCode = newAccessCode();
    const captureToken = newToken();

    db.prepare(
      `INSERT INTO sessions (session_id, patient_label, side, asri_version, reference_dataset_version, stage01, access_code_hash, capture_token_hash, created_at, age_months, months_since_surgery, hospital_id, protocol)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      patientLabel,
      side,
      asriVersion,
      resolvedReferenceVersion,
      stage01 ?? 0.5,
      sha256(accessCode),
      sha256(captureToken),
      new Date().toISOString(),
      ageMonths ?? null,
      monthsSinceSurgery ?? null,
      hospitalId ?? null,
      protocol || "modified_mallet"
    );

    // accessCode and captureToken are each returned exactly once; only their hashes persist.
    res.json({ sessionId, accessCode, captureToken });
  });

  app.post("/api/sessions/:sessionId/tasks/:taskId", requireCaptureToken, (req, res) => {
    const { parameters, domainScores, motionAnalysis, cameraQuality, malletGrade } = req.body || {};
    if (!parameters) return res.status(400).json({ error: "parameters required" });
    db.prepare(
      `INSERT INTO task_results (session_id, task_id, parameters_json, domain_scores_json, motion_analysis_json, dmqe_version, filter_version, camera_quality_json, icqa_version, mallet_grade_json, mallet_score_config_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, task_id) DO UPDATE SET parameters_json = excluded.parameters_json,
         domain_scores_json = excluded.domain_scores_json, motion_analysis_json = excluded.motion_analysis_json,
         dmqe_version = excluded.dmqe_version, filter_version = excluded.filter_version,
         camera_quality_json = excluded.camera_quality_json, icqa_version = excluded.icqa_version,
         mallet_grade_json = excluded.mallet_grade_json, mallet_score_config_version = excluded.mallet_score_config_version,
         created_at = excluded.created_at`
    ).run(
      req.params.sessionId,
      req.params.taskId,
      JSON.stringify(parameters),
      JSON.stringify(domainScores ?? {}),
      motionAnalysis ? JSON.stringify(motionAnalysis) : null,
      motionAnalysis?.dmqeVersion ?? null,
      motionAnalysis?.filterVersion ?? null,
      cameraQuality ? JSON.stringify(cameraQuality) : null,
      cameraQuality?.icqaVersion ?? null,
      malletGrade ? JSON.stringify(malletGrade) : null,
      malletGrade?.gradeConfigVersion ?? null,
      new Date().toISOString()
    );
    res.json({ ok: true });
  });

  // Task-data upload (Phase 6): raw/filtered landmark sequences (as a single
  // JSON file with {raw, filtered} arrays) and/or the task's recorded video
  // clip. Separate from the main task-result POST above -- these are large
  // payloads written straight to TASK_DATA_DIR (mirrors CAPTURES_DIR's
  // file-on-disk-plus-path-in-DB pattern for photos), not inlined as JSON
  // columns. Either field can be uploaded independently (e.g. a browser
  // without MediaRecorder support still uploads landmarks).
  app.post(
    "/api/sessions/:sessionId/tasks/:taskId/data",
    requireCaptureToken,
    uploadTaskData.fields([{ name: "video", maxCount: 1 }, { name: "landmarks", maxCount: 1 }]),
    (req, res) => {
      const sessionDir = path.join(TASK_DATA_DIR, req.params.sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });

      let videoPath = null;
      let rawPath = null;
      let filteredPath = null;

      const videoFile = req.files?.video?.[0];
      if (videoFile) {
        videoPath = path.join(sessionDir, `${req.params.taskId}-video.webm`);
        fs.writeFileSync(videoPath, videoFile.buffer);
      }

      const landmarksFile = req.files?.landmarks?.[0];
      if (landmarksFile) {
        let parsed;
        try {
          parsed = JSON.parse(landmarksFile.buffer.toString("utf8"));
        } catch {
          return res.status(400).json({ error: "landmarks file must be valid JSON with {raw, filtered} arrays" });
        }
        rawPath = path.join(sessionDir, `${req.params.taskId}-raw.json`);
        filteredPath = path.join(sessionDir, `${req.params.taskId}-filtered.json`);
        fs.writeFileSync(rawPath, JSON.stringify(parsed.raw ?? []));
        fs.writeFileSync(filteredPath, JSON.stringify(parsed.filtered ?? []));
      }

      if (!videoPath && !rawPath) return res.status(400).json({ error: "at least one of video/landmarks required" });

      db.prepare(
        `UPDATE task_results SET
           video_path = COALESCE(?, video_path),
           raw_landmarks_path = COALESCE(?, raw_landmarks_path),
           filtered_landmarks_path = COALESCE(?, filtered_landmarks_path)
         WHERE session_id = ? AND task_id = ?`
      ).run(videoPath, rawPath, filteredPath, req.params.sessionId, req.params.taskId);

      res.json({ ok: true, videoStored: !!videoPath, landmarksStored: !!rawPath });
    }
  );

  // Session resume (Phase 6): capture-token-gated (only the capturing
  // device, which still holds the token from localStorage after a reload,
  // may resume) -- returns a compact per-task summary AssessmentController.
  // resumeFrom() can reconstruct progress from, without exposing anything
  // an unauthenticated party couldn't already get via the access-code-gated
  // unlock endpoint's fuller data.
  app.get("/api/sessions/:sessionId/resume", requireCaptureToken, (req, res) => {
    const taskRows = db.prepare("SELECT task_id, parameters_json, mallet_grade_json, camera_quality_json, created_at FROM task_results WHERE session_id = ?").all(req.params.sessionId);
    const completedTasks = {};
    for (const row of taskRows) {
      completedTasks[row.task_id] = {
        taskId: row.task_id,
        asriInputParameters: JSON.parse(row.parameters_json),
        malletGrade: row.mallet_grade_json ? JSON.parse(row.mallet_grade_json) : null,
        cameraQuality: row.camera_quality_json ? JSON.parse(row.camera_quality_json) : null,
        timestamp: row.created_at,
      };
    }
    res.json({
      session: { sessionId: req.session.session_id, patientLabel: req.session.patient_label, side: req.session.side, protocol: req.session.protocol },
      completedTasks,
    });
  });

  app.post("/api/sessions/:sessionId/captures", requireCaptureToken, upload.single("photo"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "photo file required" });
    const { taskId, timestamp } = req.body;
    let parameters = {};
    try {
      parameters = JSON.parse(req.body.parameters || "{}");
    } catch {
      /* leave empty */
    }

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
    const perTaskParameters = {};
    for (const row of taskRows) {
      const parameters = JSON.parse(row.parameters_json);
      taskResults[row.task_id] = {
        parameters,
        domainScores: JSON.parse(row.domain_scores_json),
        motionAnalysis: row.motion_analysis_json ? JSON.parse(row.motion_analysis_json) : null,
        cameraQuality: row.camera_quality_json ? JSON.parse(row.camera_quality_json) : null,
        malletGrade: row.mallet_grade_json ? JSON.parse(row.mallet_grade_json) : null,
        hasVideo: !!row.video_path,
        hasLandmarks: !!row.raw_landmarks_path,
      };
      perTaskParameters[row.task_id] = parameters;
    }

    const captureRows = db.prepare("SELECT capture_id, task_id, parameters_json, timestamp FROM captures WHERE session_id = ?").all(session.session_id);
    const captures = captureRows.map((c) => ({
      captureId: c.capture_id,
      taskId: c.task_id,
      parameters: JSON.parse(c.parameters_json),
      timestamp: c.timestamp,
      photoUrl: `/api/captures/${c.capture_id}/photo?reviewToken=${reviewToken}`,
    }));

    // Scored via resolveAsriResult(): the session's own captured ASRI +
    // reference-dataset versions (immutable once published), reused from the
    // persisted row when one already exists so repeat unlocks cannot produce a
    // second, differing evaluation.
    const asriResult = resolveAsriResult(session, perTaskParameters);

    res.json({
      session: {
        sessionId: session.session_id,
        patientLabel: session.patient_label,
        side: session.side,
        asriVersion: session.asri_version,
        stage01: session.stage01,
        createdAt: session.created_at,
        ageMonths: session.age_months,
        monthsSinceSurgery: session.months_since_surgery,
      },
      taskResults,
      captures,
      asriResult,
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

  // Task video / landmark retrieval (Phase 6) -- same reviewToken-gated
  // pattern as the photo endpoint above.
  app.get("/api/sessions/:sessionId/tasks/:taskId/video", (req, res) => {
    const { reviewToken } = req.query;
    const row = db.prepare("SELECT video_path, session_id FROM task_results WHERE session_id = ? AND task_id = ?").get(req.params.sessionId, req.params.taskId);
    if (!row || !row.video_path) return res.status(404).end();
    const tokenRow = db.prepare("SELECT * FROM review_tokens WHERE token = ? AND session_id = ?").get(reviewToken, row.session_id);
    if (!tokenRow || new Date(tokenRow.expires_at) < new Date()) {
      return res.status(401).json({ error: "review session expired or invalid — unlock again" });
    }
    res.sendFile(row.video_path);
  });

  app.get("/api/sessions/:sessionId/tasks/:taskId/landmarks", (req, res) => {
    const { reviewToken } = req.query;
    const row = db.prepare("SELECT raw_landmarks_path, filtered_landmarks_path, session_id FROM task_results WHERE session_id = ? AND task_id = ?").get(req.params.sessionId, req.params.taskId);
    if (!row || !row.raw_landmarks_path) return res.status(404).end();
    const tokenRow = db.prepare("SELECT * FROM review_tokens WHERE token = ? AND session_id = ?").get(reviewToken, row.session_id);
    if (!tokenRow || new Date(tokenRow.expires_at) < new Date()) {
      return res.status(401).json({ error: "review session expired or invalid — unlock again" });
    }
    res.json({
      raw: JSON.parse(fs.readFileSync(row.raw_landmarks_path, "utf8")),
      filtered: row.filtered_landmarks_path ? JSON.parse(fs.readFileSync(row.filtered_landmarks_path, "utf8")) : null,
    });
  });

  // Phase 9: joint-angle time series for the dashboard's chart. Same
  // reviewToken-gating pattern as /video and /landmarks above. Prefers the
  // filtered (smoothed) frame sequence -- same sequence rotation-trajectory.js
  // already treats as primary -- falling back to raw only if filtering never
  // ran. Recomputed fresh on every request via the frozen, unmodified
  // computeParameters(), never cached, same "always recompute from the
  // frozen engine" principle /unlock already uses for asriResult.
  app.get("/api/sessions/:sessionId/tasks/:taskId/angle-timeseries", (req, res) => {
    const { reviewToken } = req.query;
    const row = db
      .prepare("SELECT filtered_landmarks_path, raw_landmarks_path, session_id FROM task_results WHERE session_id = ? AND task_id = ?")
      .get(req.params.sessionId, req.params.taskId);
    if (!row || (!row.filtered_landmarks_path && !row.raw_landmarks_path)) return res.status(404).end();
    const tokenRow = db.prepare("SELECT * FROM review_tokens WHERE token = ? AND session_id = ?").get(reviewToken, row.session_id);
    if (!tokenRow || new Date(tokenRow.expires_at) < new Date()) {
      return res.status(401).json({ error: "review session expired or invalid — unlock again" });
    }
    const session = db.prepare("SELECT side FROM sessions WHERE session_id = ?").get(req.params.sessionId);
    const framesPath = row.filtered_landmarks_path || row.raw_landmarks_path;
    const frames = JSON.parse(fs.readFileSync(framesPath, "utf8"));
    if (!Array.isArray(frames) || frames.length === 0) {
      return res.json({ taskId: req.params.taskId, side: session.side, frames: [] });
    }

    const t0 = frames[0].t;
    const series = [];
    for (const f of frames) {
      if (!f.lm) continue;
      const params = computeParameters(f.lm, session.side);
      series.push({
        tSec: round2((f.t - t0) / 1000),
        shoulderAbductionDeg: pickEnvelope(params.shoulderAbductionDeg),
        shoulderFlexionDeg: pickEnvelope(params.shoulderFlexionDeg),
        shoulderElevationDeg: pickEnvelope(params.shoulderElevationDeg),
        externalRotationDeg: pickEnvelope(params.externalRotationDeg),
        internalRotationDeg: pickEnvelope(params.internalRotationDeg),
      });
    }
    res.json({ taskId: req.params.taskId, side: session.side, frames: series });
  });

  // ---- Phase 6: Modified Mallet grade overrides ------------------------------
  // Append-only, same immutable-history principle as clinician_assessments
  // (Phase 4) -- a clinician correcting a predicted grade is a NEW row with
  // supersedesId set, never an UPDATE to the prior one. Deliberately
  // separate from clinician_assessments: this reviews THIS APP's own
  // prediction for one task, not an independent clinical assessment (see
  // backend/db.js's comment on mallet_grade_overrides for why conflating
  // the two would corrupt Phase 4's validation design).
  app.post("/api/sessions/:sessionId/tasks/:taskId/mallet-override", (req, res) => {
    const o = req.body || {};
    if (!o.clinicianGrade || !o.clinicianName) {
      return res.status(400).json({ error: "clinicianGrade and clinicianName are required" });
    }
    let version = 1;
    let supersedesId = null;
    if (o.supersedesId) {
      const prior = db.prepare("SELECT * FROM mallet_grade_overrides WHERE id = ?").get(o.supersedesId);
      if (!prior) return res.status(400).json({ error: `supersedesId ${o.supersedesId} not found` });
      version = prior.version + 1;
      supersedesId = prior.id;
    }

    const taskRow = db.prepare("SELECT mallet_grade_json FROM task_results WHERE session_id = ? AND task_id = ?").get(req.params.sessionId, req.params.taskId);
    const predictedGrade = taskRow?.mallet_grade_json ? JSON.parse(taskRow.mallet_grade_json).grade : null;
    const difference = predictedGrade && GRADE_NUMERIC[o.clinicianGrade] != null ? GRADE_NUMERIC[o.clinicianGrade] - GRADE_NUMERIC[predictedGrade] : null;

    let insertedId;
    const txn = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO mallet_grade_overrides (session_id, task_id, predicted_grade, clinician_grade, difference, override_reason, clinician_name, version, supersedes_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.params.sessionId, req.params.taskId, predictedGrade, o.clinicianGrade, difference, o.overrideReason ?? null, o.clinicianName, version, supersedesId, new Date().toISOString());
      insertedId = info.lastInsertRowid;
      // Phase 9: audit every override, including ones submitted from the
      // original doctor-portal form (clinicianName there is still a free-text
      // field, unchanged) -- audit attribution uses whatever name was given,
      // same as clinician-assessments' audit entry above.
      recordAudit({
        sessionId: req.params.sessionId,
        entityType: "mallet_override",
        entityId: insertedId,
        action: version > 1 ? "update" : "create",
        reviewerName: o.clinicianName,
        summary: `${o.clinicianName} set Mallet grade for ${req.params.taskId} to ${o.clinicianGrade}${predictedGrade ? ` (AI predicted ${predictedGrade})` : ""}`,
        detail: { predictedGrade, clinicianGrade: o.clinicianGrade, difference, reason: o.overrideReason ?? null },
      });
    });
    txn();

    res.json({ ok: true, id: insertedId, version, predictedGrade, difference });
  });

  app.get("/api/sessions/:sessionId/mallet-overrides", (req, res) => {
    const rows = db.prepare("SELECT * FROM mallet_grade_overrides WHERE session_id = ? ORDER BY created_at ASC").all(req.params.sessionId);
    res.json({ overrides: rows });
  });

  // ---- Phase 6: combined Mallet report (JSON + PDF) --------------------------
  // Assembles the SAME structured object (shared/reporting/report-generator.js's
  // generateMalletReport()) both endpoints use -- one data source, two
  // renderers (res.json() here, pdf-renderer.js for the PDF route).
  function buildMalletReport(sessionId) {
    const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    if (!session) return null;

    const taskRows = db.prepare("SELECT * FROM task_results WHERE session_id = ?").all(sessionId);
    const taskResults = {};
    const perTaskParameters = {};
    for (const row of taskRows) {
      const parameters = JSON.parse(row.parameters_json);
      taskResults[row.task_id] = {
        parameters,
        motionAnalysis: row.motion_analysis_json ? JSON.parse(row.motion_analysis_json) : null,
        cameraQuality: row.camera_quality_json ? JSON.parse(row.camera_quality_json) : null,
        malletGrade: row.mallet_grade_json ? JSON.parse(row.mallet_grade_json) : null,
      };
      perTaskParameters[row.task_id] = parameters;
    }

    const overrideRows = db.prepare("SELECT * FROM mallet_grade_overrides WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
    const gradeOverrides = {};
    for (const row of overrideRows) {
      // later rows (more recent) overwrite earlier ones in this loop, so
      // the "most recent version per task" convention used elsewhere holds
      gradeOverrides[row.task_id] = { clinicianGrade: row.clinician_grade, overrideReason: row.override_reason, clinicianName: row.clinician_name, createdAt: row.created_at };
    }

    // Same authoritative resolver the unlock route uses. This previously
    // computed a parallel, unpersisted result, which is how the Mallet report
    // and the research report could disagree about one session's ASRI.
    const asriResult = resolveAsriResult(session, perTaskParameters);

    const malletGrades = Object.values(taskResults).map((t) => t.malletGrade).filter(Boolean);
    const malletOverallResult = malletScoreConfigStore.activeVersion
      ? new ModifiedMalletScoreEngine(malletScoreConfigStore.getActive()).scoreOverall(malletGrades)
      : { status: "insufficient_data", totalScore: null };

    const taskLabels = {};
    for (const t of TASKS) taskLabels[t.id] = t.label;

    return generateMalletReport({
      session: { sessionId: session.session_id, patientLabel: session.patient_label, side: session.side, createdAt: session.created_at },
      taskResults,
      asriResult,
      malletOverallResult,
      gradeOverrides,
      taskLabels,
      validationMetadata: {
        malletScoreConfigVersion: malletScoreConfigStore.activeVersion,
        asriVersion: session.asri_version,
        referenceDatasetVersion: session.reference_dataset_version,
      },
    });
  }

  app.get("/api/sessions/:sessionId/mallet-report/json", (req, res) => {
    const report = buildMalletReport(req.params.sessionId);
    if (!report) return res.status(404).json({ error: "session not found" });
    res.json(report);
  });

  app.get("/api/sessions/:sessionId/mallet-report/pdf", (req, res) => {
    const report = buildMalletReport(req.params.sessionId);
    if (!report) return res.status(404).json({ error: "session not found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="mallet-report-${req.params.sessionId}.pdf"`);
    renderMalletReportPdf(report, res);
  });

  // ---- Phase 4: Clinical Validation Engine -----------------------------------
  // NOTE: these endpoints have no auth layer, same as the rest of this
  // prototype (see the CORS NOTE above) -- fine for local/research use, not
  // for a deployment reachable by untrusted clients. Flagged here rather than
  // silently assumed away; see docs/validation.md regulatory considerations.

  // Append-only: a correction is a NEW row with supersedesId set, never an
  // UPDATE to an existing row -- same immutable-history principle as
  // asri_config_versions.
  app.post("/api/clinician-assessments", (req, res) => {
    const a = req.body || {};
    if (!a.sessionId || !a.hospitalId || !a.assessmentDate || !a.clinicianName) {
      return res.status(400).json({ error: "sessionId, hospitalId, assessmentDate and clinicianName are required" });
    }
    let version = 1;
    let supersedesId = null;
    if (a.supersedesId) {
      const prior = db.prepare("SELECT * FROM clinician_assessments WHERE id = ?").get(a.supersedesId);
      if (!prior) return res.status(400).json({ error: `supersedesId ${a.supersedesId} not found` });
      version = prior.version + 1;
      supersedesId = prior.id;
    }
    const info = db
      .prepare(
        `INSERT INTO clinician_assessments
         (session_id, hospital_id, assessment_date, affected_side, age, sex, months_since_surgery, clinician_name, hospital,
          shoulder_abduction, shoulder_flexion, external_rotation, internal_rotation, rom, mallet_score_json, ams_score,
          other_scores_json, notes, version, supersedes_id, created_at,
          compensation_severity, overall_assessment, clinician_confidence_pct, clinician_recommendation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.sessionId,
        a.hospitalId,
        a.assessmentDate,
        a.affectedSide ?? null,
        a.age ?? null,
        a.sex ?? null,
        a.monthsSinceSurgery ?? null,
        a.clinicianName,
        a.hospital ?? null,
        a.shoulderAbduction ?? null,
        a.shoulderFlexion ?? null,
        a.externalRotation ?? null,
        a.internalRotation ?? null,
        a.rom ?? null,
        a.malletScore ? JSON.stringify(a.malletScore) : null,
        a.amsScore ?? null,
        a.otherScores ? JSON.stringify(a.otherScores) : null,
        a.notes ?? null,
        version,
        supersedesId,
        new Date().toISOString(),
        // Phase 9: Clinician Assessment Panel additions -- optional, backward
        // compatible with the Phase 4 validation-portal form which doesn't send them.
        a.compensationSeverity ?? null,
        a.overallAssessment ?? null,
        a.clinicianConfidencePct ?? null,
        a.clinicianRecommendation ?? null
      );
    if (a.sessionId) {
      recordAudit({
        sessionId: a.sessionId,
        entityType: "clinician_assessment",
        entityId: info.lastInsertRowid,
        action: version > 1 ? "update" : "create",
        reviewerName: a.clinicianName,
        summary: `${a.clinicianName} recorded a clinician assessment${version > 1 ? ` (revision ${version})` : ""}`,
        detail: { version, supersedesId },
      });
    }
    res.json({ ok: true, id: info.lastInsertRowid, version });
  });

  function rowToAssessment(row) {
    return {
      id: row.id,
      sessionId: row.session_id,
      hospitalId: row.hospital_id,
      assessmentDate: row.assessment_date,
      affectedSide: row.affected_side,
      age: row.age,
      sex: row.sex,
      monthsSinceSurgery: row.months_since_surgery,
      clinicianName: row.clinician_name,
      hospital: row.hospital,
      shoulderAbduction: row.shoulder_abduction,
      shoulderFlexion: row.shoulder_flexion,
      externalRotation: row.external_rotation,
      internalRotation: row.internal_rotation,
      rom: row.rom,
      malletScore: row.mallet_score_json ? JSON.parse(row.mallet_score_json) : null,
      amsScore: row.ams_score,
      otherScores: row.other_scores_json ? JSON.parse(row.other_scores_json) : null,
      notes: row.notes,
      version: row.version,
      supersedesId: row.supersedes_id,
      createdAt: row.created_at,
      compensationSeverity: row.compensation_severity,
      overallAssessment: row.overall_assessment,
      clinicianConfidencePct: row.clinician_confidence_pct,
      clinicianRecommendation: row.clinician_recommendation,
    };
  }

  app.get("/api/clinician-assessments", (_req, res) => {
    const rows = db.prepare("SELECT * FROM clinician_assessments ORDER BY created_at ASC").all();
    res.json({ assessments: rows.map(rowToAssessment) });
  });

  app.get("/api/clinician-assessments/:sessionId", (req, res) => {
    const rows = db.prepare("SELECT * FROM clinician_assessments WHERE session_id = ? ORDER BY created_at ASC").all(req.params.sessionId);
    res.json({ assessments: rows.map(rowToAssessment) });
  });

  // ---- validation datasets (Part 8) ------------------------------------------
  app.post("/api/validation-datasets", (req, res) => {
    const { name, type, notes } = req.body || {};
    const validTypes = ["pilot", "training", "validation", "hospital", "research"];
    if (!name || !validTypes.includes(type)) {
      return res.status(400).json({ error: `name and type (one of ${validTypes.join(", ")}) are required` });
    }
    const info = db.prepare("INSERT INTO validation_datasets (name, type, notes, created_at) VALUES (?, ?, ?, ?)").run(name, type, notes ?? null, new Date().toISOString());
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  app.get("/api/validation-datasets", (req, res) => {
    const rows = req.query.type
      ? db.prepare("SELECT * FROM validation_datasets WHERE type = ? ORDER BY created_at ASC").all(req.query.type)
      : db.prepare("SELECT * FROM validation_datasets ORDER BY created_at ASC").all();
    res.json({ datasets: rows });
  });

  app.post("/api/validation-datasets/:id/sessions", (req, res) => {
    // Phase 9: optional assignedReviewer, additive/backward compatible --
    // a plain validation-QC grouping (no reviewer) still works exactly as
    // it did in Phase 4; a pilot-study assignment also sets who's reviewing it.
    const { sessionId, assignedReviewer } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const dataset = db.prepare("SELECT id FROM validation_datasets WHERE id = ?").get(req.params.id);
    if (!dataset) return res.status(404).json({ error: "dataset not found" });
    const session = db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO session_dataset_membership (session_id, dataset_id, added_at, status, assigned_reviewer, assigned_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(session_id, dataset_id) DO UPDATE SET assigned_reviewer = excluded.assigned_reviewer, assigned_at = excluded.assigned_at`
    ).run(sessionId, req.params.id, now, assignedReviewer ?? null, assignedReviewer ? now : null);
    res.json({ ok: true });
  });

  // ---- Phase 9: Pilot Study Management ---------------------------------------
  // A pilot study IS a validation_datasets row (type='pilot') -- these
  // endpoints only add assignment/status/completion tracking on top of the
  // existing dataset-membership grain, they don't duplicate dataset CRUD.
  app.patch("/api/validation-datasets/:datasetId/sessions/:sessionId", requireDashboardReviewer, (req, res) => {
    const { status, assignedReviewer } = req.body || {};
    const validStatuses = ["pending", "in_review", "completed"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${validStatuses.join(", ")}` });
    }
    const membership = db
      .prepare("SELECT * FROM session_dataset_membership WHERE dataset_id = ? AND session_id = ?")
      .get(req.params.datasetId, req.params.sessionId);
    if (!membership) return res.status(404).json({ error: "membership not found" });

    const completedAt = status === "completed" ? new Date().toISOString() : membership.completed_at;
    const txn = db.transaction(() => {
      db.prepare(
        `UPDATE session_dataset_membership SET
           status = COALESCE(?, status),
           assigned_reviewer = COALESCE(?, assigned_reviewer),
           assigned_at = CASE WHEN ? IS NOT NULL THEN ? ELSE assigned_at END,
           completed_at = ?
         WHERE dataset_id = ? AND session_id = ?`
      ).run(status ?? null, assignedReviewer ?? null, assignedReviewer ?? null, new Date().toISOString(), completedAt, req.params.datasetId, req.params.sessionId);
      recordAudit({
        sessionId: req.params.sessionId,
        entityType: "study_assignment",
        entityId: Number(req.params.datasetId),
        action: "status_change",
        reviewerName: req.reviewer.name,
        summary: `${req.reviewer.name} updated study #${req.params.datasetId} assignment for session ${req.params.sessionId}${status ? ` -> ${status}` : ""}`,
        detail: { status, assignedReviewer },
      });
    });
    txn();
    res.json({ ok: true });
  });

  // Member sessions of a study, joined with patient info for display --
  // the write-side (assign/PATCH status) endpoints above have no
  // corresponding read, which studies.js's member table needs.
  app.get("/api/validation-datasets/:id/sessions", requireDashboardReviewer, (req, res) => {
    const dataset = db.prepare("SELECT id FROM validation_datasets WHERE id = ?").get(req.params.id);
    if (!dataset) return res.status(404).json({ error: "dataset not found" });
    const rows = db
      .prepare(
        `SELECT m.session_id, m.status, m.assigned_reviewer, m.assigned_at, m.completed_at, m.added_at,
                s.patient_label, s.side, s.hospital_id, s.created_at
         FROM session_dataset_membership m
         JOIN sessions s ON s.session_id = m.session_id
         WHERE m.dataset_id = ?
         ORDER BY m.added_at ASC`
      )
      .all(req.params.id);
    res.json({
      members: rows.map((r) => ({
        sessionId: r.session_id,
        patientLabel: r.patient_label,
        side: r.side,
        hospitalId: r.hospital_id,
        status: r.status,
        assignedReviewer: r.assigned_reviewer,
        assignedAt: r.assigned_at,
        completedAt: r.completed_at,
        addedAt: r.added_at,
      })),
    });
  });

  app.get("/api/validation-datasets/:id/stats", requireDashboardReviewer, (req, res) => {
    const total = db.prepare("SELECT COUNT(*) as n FROM session_dataset_membership WHERE dataset_id = ?").get(req.params.id).n;
    const byStatus = db
      .prepare("SELECT status, COUNT(*) as n FROM session_dataset_membership WHERE dataset_id = ? GROUP BY status")
      .all(req.params.id);
    const byReviewer = db
      .prepare(
        `SELECT assigned_reviewer, status, COUNT(*) as n FROM session_dataset_membership
         WHERE dataset_id = ? AND assigned_reviewer IS NOT NULL GROUP BY assigned_reviewer, status`
      )
      .all(req.params.id);
    const completed = byStatus.find((s) => s.status === "completed")?.n ?? 0;
    res.json({
      total,
      byStatus,
      byReviewer,
      percentComplete: total > 0 ? round2((completed / total) * 100) : 0,
    });
  });

  app.patch("/api/validation-datasets/:id", requireDashboardReviewer, (req, res) => {
    const { status } = req.body || {};
    const validStatuses = ["active", "completed", "archived"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${validStatuses.join(", ")}` });
    }
    const dataset = db.prepare("SELECT id FROM validation_datasets WHERE id = ?").get(req.params.id);
    if (!dataset) return res.status(404).json({ error: "dataset not found" });
    const txn = db.transaction(() => {
      db.prepare("UPDATE validation_datasets SET status = ? WHERE id = ?").run(status, req.params.id);
      recordAudit({
        entityType: "study_status",
        entityId: Number(req.params.id),
        action: "status_change",
        reviewerName: req.reviewer.name,
        summary: `${req.reviewer.name} set study #${req.params.id} status to ${status}`,
        detail: { status },
      });
    });
    txn();
    res.json({ ok: true });
  });

  // ---- quality control (Part 11) ---------------------------------------------
  function loadSessionsForValidation(datasetId) {
    const sessionRows = datasetId
      ? db
          .prepare(
            `SELECT s.* FROM sessions s
             JOIN session_dataset_membership m ON m.session_id = s.session_id
             WHERE m.dataset_id = ?`
          )
          .all(datasetId)
      : db.prepare("SELECT * FROM sessions").all();

    return sessionRows.map((s) => {
      const taskRows = db.prepare("SELECT * FROM task_results WHERE session_id = ?").all(s.session_id);
      const taskResults = {};
      for (const t of taskRows) {
        taskResults[t.task_id] = {
          parameters: JSON.parse(t.parameters_json),
          // Phase 10: cameraQuality wasn't included here before -- quality-control.js's
          // new checkCaptureQuality() needs the per-task CQI, which lives in this
          // column but was never surfaced to the validation-loading path.
          cameraQuality: t.camera_quality_json ? JSON.parse(t.camera_quality_json) : null,
        };
      }
      return {
        sessionId: s.session_id,
        hospitalId: s.hospital_id,
        side: s.side,
        createdAt: s.created_at,
        asriVersion: s.asri_version,
        referenceDatasetVersion: s.reference_dataset_version,
        taskResults,
      };
    });
  }

  // Phase 10: gathers everything runValidation()'s new sections need beyond
  // what loadSessionsForValidation()/clinician_assessments already provide
  // -- mallet_grade_overrides (predicted-vs-clinician grade pairs, never
  // aggregated across sessions before this phase), parameter_overrides,
  // and dataset membership status counts. Dataset-scoped the same way
  // loadSessionsForValidation() is (JOIN session_dataset_membership when a
  // datasetId is given, else all rows).
  function loadValidationExtras(datasetId) {
    const sessionFilter = datasetId
      ? `WHERE session_id IN (SELECT session_id FROM session_dataset_membership WHERE dataset_id = ${Number(datasetId)})`
      : "";
    const malletOverrideRows = db.prepare(`SELECT * FROM mallet_grade_overrides ${sessionFilter} ORDER BY created_at ASC`).all();
    const parameterOverrideRows = db.prepare(`SELECT * FROM parameter_overrides ${sessionFilter} ORDER BY created_at ASC`).all();

    // Latest override per (session_id, task_id) -- same "later rows in the
    // loop overwrite earlier ones" convention buildMalletReport() already
    // uses for its own gradeOverrides map, kept consistent here rather than
    // inventing a different "most recent" rule for the same underlying data.
    const latestByTask = {};
    for (const row of malletOverrideRows) latestByTask[`${row.session_id}::${row.task_id}`] = row;
    const malletGradePairs = Object.values(latestByTask).map((row) => ({
      taskId: row.task_id,
      predictedGrade: row.predicted_grade,
      clinicianGrade: row.clinician_grade,
      difference: row.difference,
      createdAt: row.created_at,
    }));

    const datasetMemberships = datasetId ? db.prepare("SELECT * FROM session_dataset_membership WHERE dataset_id = ?").all(datasetId) : [];

    return { malletGradePairs, malletOverrideRows, parameterOverrideRows, datasetMemberships };
  }

  app.get("/api/validation/quality-control", (req, res) => {
    const sessions = loadSessionsForValidation(req.query.datasetId ? Number(req.query.datasetId) : null);
    const assessmentRows = db.prepare("SELECT * FROM clinician_assessments ORDER BY created_at ASC").all();
    const assessments = assessmentRows.map(rowToAssessment);
    res.json(runQualityControl(sessions, assessments));
  });

  // ---- run validation (Parts 1, 3-6, 9, 10) ----------------------------------
  app.post("/api/validation/run", (req, res) => {
    const { datasetId, datasetName } = req.body || {};
    const sessions = loadSessionsForValidation(datasetId ?? null);
    const assessmentRows = db.prepare("SELECT * FROM clinician_assessments ORDER BY created_at ASC").all();
    const assessments = assessmentRows.map(rowToAssessment);

    // Reference targets for normalizedError / calibration recommendations:
    // use the most recently published reference dataset (best-effort; a
    // validation run spanning multiple reference-dataset versions is
    // exactly what checkVersionMismatches() in quality-control.js flags).
    const refRow = db.prepare("SELECT config_json FROM reference_dataset_versions ORDER BY created_at DESC LIMIT 1").get();
    const referenceTargets = refRow ? resolveReferenceDataset(JSON.parse(refRow.config_json), {}).targets : {};

    const { malletGradePairs, malletOverrideRows, parameterOverrideRows, datasetMemberships } = loadValidationExtras(datasetId ?? null);
    const result = runValidation({
      sessions,
      assessments,
      referenceTargets,
      datasetName: datasetName ?? (datasetId ? `dataset ${datasetId}` : "all sessions"),
      malletGradePairs,
      malletOverrideRows,
      parameterOverrideRows,
      datasetMemberships,
    });

    db.prepare("INSERT INTO validation_reports (dataset_id, generated_at, report_json, report_version) VALUES (?, ?, ?, ?)").run(
      datasetId ?? null,
      result.report.generatedAt,
      JSON.stringify(result),
      // Phase 10: bumped 1.0.0 -> 1.1.0 -- runValidation()'s output shape
      // grew (malletAgreement, repeatabilityResults, publicationTables,
      // pilotStudySummary), same "bump the version to signal the schema
      // grew" convention used for config files elsewhere in this project.
      "1.1.0"
    );

    res.json(result);
  });

  app.get("/api/validation/reports", (_req, res) => {
    const rows = db.prepare("SELECT id, dataset_id, generated_at, report_version FROM validation_reports ORDER BY generated_at DESC").all();
    res.json({ reports: rows });
  });

  app.get("/api/validation/reports/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM validation_reports WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "report not found" });
    res.json(JSON.parse(row.report_json));
  });

  // ---- Phase 10: export a STORED validation report as PDF/CSV/XLSX ----------
  // Same "one stored report, N renderers" pattern already established twice
  // (mallet-report json/pdf, research-report json/pdf) -- all three read
  // the already-persisted report_json (no re-computation), matching
  // GET /api/validation/reports/:id's own existing behavior.
  app.get("/api/validation/reports/:id/pdf", async (req, res) => {
    const row = db.prepare("SELECT * FROM validation_reports WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "report not found" });
    const result = JSON.parse(row.report_json);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="validation-report-${req.params.id}.pdf"`);
    await renderValidationReportPdf(result, res);
  });

  app.get("/api/validation/reports/:id/csv", (req, res) => {
    const row = db.prepare("SELECT * FROM validation_reports WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "report not found" });
    const result = JSON.parse(row.report_json);
    if (!result.publicationTables) return res.status(409).json({ error: "this report predates the Phase 10 publication tables -- re-run validation to generate an exportable report" });
    const csv = buildResearchCsv(buildValidationExportRows(result.publicationTables));
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="validation-report-${req.params.id}.csv"`);
    res.send(csv);
  });

  app.get("/api/validation/reports/:id/xlsx", async (req, res) => {
    const row = db.prepare("SELECT * FROM validation_reports WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "report not found" });
    const result = JSON.parse(row.report_json);
    if (!result.publicationTables) return res.status(409).json({ error: "this report predates the Phase 10 publication tables -- re-run validation to generate an exportable report" });
    res.setHeader("Content-Disposition", `attachment; filename="validation-report-${req.params.id}.xlsx"`);
    await renderResearchXlsx(buildValidationExportRows(result.publicationTables), res);
  });

  // ---- Phase 9: Clinician Research Dashboard ---------------------------------

  app.post("/api/dashboard/login", (req, res) => {
    const { passcode } = req.body || {};
    if (!passcode || sha256(passcode) !== DASHBOARD_PASSCODE_HASH) {
      return res.status(401).json({ error: "invalid passcode" });
    }
    const token = newToken();
    const expires = new Date(Date.now() + DASHBOARD_TOKEN_TTL_MS).toISOString();
    db.prepare("INSERT INTO dashboard_tokens (token, reviewer_id, reviewer_name, issued_at, expires_at) VALUES (?, NULL, NULL, ?, ?)").run(
      token,
      new Date().toISOString(),
      expires
    );
    res.json({ dashboardToken: token, expiresAt: expires });
  });

  app.get("/api/dashboard/reviewers", requireDashboardToken, (_req, res) => {
    const rows = db.prepare("SELECT id, name FROM dashboard_reviewers ORDER BY name ASC").all();
    res.json({ reviewers: rows });
  });

  app.post("/api/dashboard/reviewers", requireDashboardToken, (req, res) => {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    db.prepare("INSERT OR IGNORE INTO dashboard_reviewers (name, created_at) VALUES (?, ?)").run(name, new Date().toISOString());
    const row = db.prepare("SELECT id, name FROM dashboard_reviewers WHERE name = ?").get(name);
    res.json(row);
  });

  app.post("/api/dashboard/reviewer-session", requireDashboardToken, (req, res) => {
    const reviewer = db.prepare("SELECT id, name FROM dashboard_reviewers WHERE id = ?").get(req.body?.reviewerId);
    if (!reviewer) return res.status(404).json({ error: "reviewer not found" });
    db.prepare("UPDATE dashboard_tokens SET reviewer_id = ?, reviewer_name = ? WHERE token = ?").run(reviewer.id, reviewer.name, req.dashboardToken.token);
    res.json({ ok: true, reviewerName: reviewer.name });
  });

  // Patient list, with search/filter/pagination. Query shape reused from
  // loadSessionsForValidation() below, extended with search + pagination +
  // per-session completion/review-status summary.
  app.get("/api/dashboard/sessions", requireDashboardReviewer, (req, res) => {
    const { search, side, datasetId } = req.query;
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

    let where = "1=1";
    const params = [];
    let joinClause = "";
    if (datasetId) {
      joinClause = "JOIN session_dataset_membership m ON m.session_id = s.session_id AND m.dataset_id = ?";
      params.push(Number(datasetId));
    }
    if (search) {
      where += " AND (s.patient_label LIKE ? OR s.hospital_id LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }
    if (side) {
      where += " AND s.side = ?";
      params.push(side);
    }

    const total = db.prepare(`SELECT COUNT(*) as n FROM sessions s ${joinClause} WHERE ${where}`).get(...params).n;
    const rows = db
      .prepare(`SELECT s.* FROM sessions s ${joinClause} WHERE ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, size, (pageNum - 1) * size);

    const sessions = rows.map((s) => {
      const tasksCompleted = db.prepare("SELECT COUNT(*) as n FROM task_results WHERE session_id = ?").get(s.session_id).n;
      const lastAssessment = db
        .prepare("SELECT clinician_name, created_at FROM clinician_assessments WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(s.session_id);
      const lastOverride = db
        .prepare("SELECT clinician_name, created_at FROM mallet_grade_overrides WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(s.session_id);
      const last = [lastAssessment, lastOverride].filter(Boolean).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
      return {
        sessionId: s.session_id,
        patientLabel: s.patient_label,
        side: s.side,
        hospitalId: s.hospital_id,
        createdAt: s.created_at,
        protocol: s.protocol,
        tasksCompleted,
        tasksTotal: TASKS.length,
        reviewStatus: last ? "reviewed" : "pending",
        lastReviewedBy: last?.clinician_name ?? null,
        lastReviewedAt: last?.created_at ?? null,
      };
    });

    res.json({ sessions, total, page: pageNum, pageSize: size });
  });

  // Full per-session summary for the Review view. Reuses buildMalletReport()
  // unchanged (defined above) rather than re-querying/re-scoring from
  // scratch, and issues a review_tokens row exactly like /unlock does, so
  // the returned URLs work against the existing reviewToken-gated routes
  // with zero changes to those routes.
  app.get("/api/dashboard/sessions/:sessionId/summary", requireDashboardReviewer, (req, res) => {
    const report = buildMalletReport(req.params.sessionId);
    if (!report) return res.status(404).json({ error: "session not found" });

    const reviewToken = newToken();
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO review_tokens (token, session_id, expires_at) VALUES (?, ?, ?)").run(reviewToken, req.params.sessionId, expires);

    const overrideCount =
      db.prepare("SELECT COUNT(*) as n FROM mallet_grade_overrides WHERE session_id = ?").get(req.params.sessionId).n +
      db.prepare("SELECT COUNT(*) as n FROM parameter_overrides WHERE session_id = ?").get(req.params.sessionId).n;
    const auditCount = db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE session_id = ?").get(req.params.sessionId).n;
    const datasets = db
      .prepare(
        `SELECT d.id, d.name, d.type, m.status, m.assigned_reviewer FROM validation_datasets d
         JOIN session_dataset_membership m ON m.dataset_id = d.id WHERE m.session_id = ?`
      )
      .all(req.params.sessionId);

    const taskRows = db.prepare("SELECT * FROM task_results WHERE session_id = ?").all(req.params.sessionId);
    const taskMedia = {};
    // Full per-task motionAnalysis/cameraQuality objects -- report.taskRows
    // only carries the numeric cqi/dmqeScore summary generateMalletReport()
    // needs, not the full objects ClinicalRender.renderDmqeSummary()/
    // renderCaptureQualitySummary() (reused as-is from doctor-portal) require.
    // Same shape /unlock already returns per task, so this is additive, not
    // a second competing data shape.
    const taskDetails = {};
    for (const t of taskRows) {
      taskMedia[t.task_id] = {
        videoUrl: t.video_path ? `/api/sessions/${req.params.sessionId}/tasks/${t.task_id}/video?reviewToken=${reviewToken}` : null,
        landmarksUrl: t.raw_landmarks_path ? `/api/sessions/${req.params.sessionId}/tasks/${t.task_id}/landmarks?reviewToken=${reviewToken}` : null,
        angleTimeseriesUrl: t.raw_landmarks_path ? `/api/sessions/${req.params.sessionId}/tasks/${t.task_id}/angle-timeseries?reviewToken=${reviewToken}` : null,
      };
      taskDetails[t.task_id] = {
        motionAnalysis: t.motion_analysis_json ? JSON.parse(t.motion_analysis_json) : null,
        cameraQuality: t.camera_quality_json ? JSON.parse(t.camera_quality_json) : null,
      };
    }
    const captureRows = db.prepare("SELECT capture_id, task_id, timestamp FROM captures WHERE session_id = ?").all(req.params.sessionId);
    const captures = captureRows.map((c) => ({ captureId: c.capture_id, taskId: c.task_id, timestamp: c.timestamp, photoUrl: `/api/captures/${c.capture_id}/photo?reviewToken=${reviewToken}` }));

    res.json({ report, reviewToken, reviewTokenExpiresAt: expires, overrideCount, auditCount, datasets, taskMedia, taskDetails, captures });
  });

  // ---- Phase 9: generalized clinician override (any field besides the
  // Mallet grade, which keeps using mallet_grade_overrides/mallet-override
  // above, unchanged). Append-only; the "original AI value" is snapshotted
  // SERVER-SIDE from task_results.parameters_json at write time -- never
  // trusted from the request body, so a client can't manufacture a fake
  // "before" value to make an override look more or less significant than
  // it really was.
  app.post("/api/sessions/:sessionId/parameter-overrides", requireDashboardReviewer, (req, res) => {
    const o = req.body || {};
    if (!o.fieldKey || !o.fieldLabel || o.overriddenValue === undefined) {
      return res.status(400).json({ error: "fieldKey, fieldLabel and overriddenValue are required" });
    }
    let version = 1;
    let supersedesId = null;
    if (o.supersedesId) {
      const prior = db.prepare("SELECT * FROM parameter_overrides WHERE id = ?").get(o.supersedesId);
      if (!prior) return res.status(400).json({ error: `supersedesId ${o.supersedesId} not found` });
      version = prior.version + 1;
      supersedesId = prior.id;
    }

    let originalValue = null;
    if (o.taskId) {
      const taskRow = db.prepare("SELECT parameters_json FROM task_results WHERE session_id = ? AND task_id = ?").get(req.params.sessionId, o.taskId);
      const params = taskRow ? JSON.parse(taskRow.parameters_json) : null;
      originalValue = params?.[o.fieldKey] ?? null;
    } else {
      // Shared resolver, so a session-level override snapshots a real original
      // value instead of null merely because nobody had opened the portal yet.
      const asri = resolveAsriForSession(req.params.sessionId);
      originalValue = asri?.[o.fieldKey] ?? null;
    }

    let insertedId;
    const txn = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO parameter_overrides
           (session_id, task_id, field_key, field_label, original_value_json, overridden_value_json, override_reason, reviewer_name, version, supersedes_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.params.sessionId,
          o.taskId ?? null,
          o.fieldKey,
          o.fieldLabel,
          JSON.stringify(originalValue),
          JSON.stringify(o.overriddenValue),
          o.overrideReason ?? null,
          req.reviewer.name,
          version,
          supersedesId,
          new Date().toISOString()
        );
      insertedId = info.lastInsertRowid;
      recordAudit({
        sessionId: req.params.sessionId,
        entityType: "parameter_override",
        entityId: insertedId,
        action: version > 1 ? "update" : "create",
        reviewerName: req.reviewer.name,
        summary: `${req.reviewer.name} overrode ${o.fieldLabel}${o.taskId ? ` (${o.taskId})` : ""}`,
        detail: { fieldKey: o.fieldKey, originalValue, overriddenValue: o.overriddenValue, reason: o.overrideReason ?? null },
      });
    });
    txn();

    res.json({ ok: true, id: insertedId, version, originalValue });
  });

  app.get("/api/sessions/:sessionId/parameter-overrides", requireDashboardReviewer, (req, res) => {
    const rows = db.prepare("SELECT * FROM parameter_overrides WHERE session_id = ? ORDER BY created_at ASC").all(req.params.sessionId);
    res.json({
      overrides: rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        taskId: r.task_id,
        fieldKey: r.field_key,
        fieldLabel: r.field_label,
        originalValue: r.original_value_json ? JSON.parse(r.original_value_json) : null,
        overriddenValue: JSON.parse(r.overridden_value_json),
        overrideReason: r.override_reason,
        reviewerName: r.reviewer_name,
        version: r.version,
        supersedesId: r.supersedes_id,
        createdAt: r.created_at,
      })),
    });
  });

  // ---- Phase 9: AI vs Clinician comparison (derived; no new storage) --------
  // Joins task_results (AI), the latest clinician_assessments row, the
  // latest-per-task mallet_grade_overrides row, and the latest-per-field
  // parameter_overrides row -- never changes any of the underlying values.
  // Derived AI-vs-Clinician comparison rows -- delegates to
  // buildComparisonRows() (defined below, hoisted within this closure) so
  // this endpoint and generateResearchReport()'s comparison section can
  // never compute different answers to the same question.
  app.get("/api/dashboard/sessions/:sessionId/comparison", requireDashboardReviewer, (req, res) => {
    const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    const latestAssessment = db.prepare("SELECT * FROM clinician_assessments WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, rows: buildComparisonRows(req.params.sessionId), clinicianAssessment: latestAssessment ? rowToAssessment(latestAssessment) : null });
  });

  app.get("/api/dashboard/audit-log", requireDashboardReviewer, (req, res) => {
    const { sessionId, reviewerName, entityType } = req.query;
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    let where = "1=1";
    const params = [];
    if (sessionId) {
      where += " AND session_id = ?";
      params.push(sessionId);
    }
    if (reviewerName) {
      where += " AND reviewer_name = ?";
      params.push(reviewerName);
    }
    if (entityType) {
      where += " AND entity_type = ?";
      params.push(entityType);
    }
    const total = db.prepare(`SELECT COUNT(*) as n FROM audit_log WHERE ${where}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, size, (pageNum - 1) * size);
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        action: r.action,
        reviewerName: r.reviewer_name,
        summary: r.summary,
        detail: r.detail_json ? JSON.parse(r.detail_json) : null,
        createdAt: r.created_at,
      })),
      total,
      page: pageNum,
      pageSize: size,
    });
  });

  // ---- Phase 9: bulk research export (CSV / JSON / XLSX) ---------------------
  // Assembles the SAME "session bundle" shape buildResearchExportRows()
  // consumes, reusing buildMalletReport() (defined above) so this never
  // re-derives Mallet/ASRI results independently -- one source of truth, three
  // format renderers, matching the "one data source, N renderers" pattern
  // the existing mallet-report json/pdf pair already established.
  function buildSessionBundle(sessionId) {
    const report = buildMalletReport(sessionId);
    if (!report) return null;
    const clinicianAssessmentRow = db.prepare("SELECT * FROM clinician_assessments WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId);
    const malletOverrides = db.prepare("SELECT * FROM mallet_grade_overrides WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
    const parameterOverrides = db.prepare("SELECT * FROM parameter_overrides WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
    return {
      session: report.session,
      taskRows: report.taskRows,
      malletOverall: report.malletOverall,
      asri: report.asri,
      clinicianAssessment: clinicianAssessmentRow ? rowToAssessment(clinicianAssessmentRow) : null,
      malletOverrides,
      parameterOverrides,
    };
  }

  // Gathers everything generateResearchReport() needs beyond what
  // buildMalletReport() already assembles: the same comparison-row logic
  // the dashboard's /comparison endpoint uses (factored out below so the
  // two never disagree), full override history, this session's audit
  // entries, and its study memberships.
  function buildComparisonRows(sessionId) {
    const taskRows = db.prepare("SELECT task_id, parameters_json, mallet_grade_json FROM task_results WHERE session_id = ?").all(sessionId);
    const malletOverrideRows = db.prepare("SELECT * FROM mallet_grade_overrides WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
    const latestMalletOverrideByTask = {};
    for (const r of malletOverrideRows) latestMalletOverrideByTask[r.task_id] = r;
    const paramOverrideRows = db.prepare("SELECT * FROM parameter_overrides WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
    const latestParamOverrideByField = {};
    for (const r of paramOverrideRows) latestParamOverrideByField[`${r.task_id ?? ""}:${r.field_key}`] = r;

    const rows = [];
    for (const t of taskRows) {
      const params = JSON.parse(t.parameters_json);
      const malletGrade = t.mallet_grade_json ? JSON.parse(t.mallet_grade_json) : null;
      const override = latestMalletOverrideByTask[t.task_id];
      if (malletGrade || override) {
        rows.push({
          field: "malletGrade",
          taskId: t.task_id,
          aiValue: malletGrade?.grade ?? null,
          aiMeasurementType: malletGrade ? "estimated" : "unavailable",
          clinicianValue: override?.clinician_grade ?? null,
          source: override ? "mallet_override" : null,
          difference: override?.difference ?? null,
          agreementStatus: override ? (override.difference === 0 ? "agree" : "disagree") : "not_reviewed",
        });
      }
      for (const fieldKey of ["shoulderAbductionDeg", "shoulderFlexionDeg", "externalRotationDeg", "internalRotationDeg"]) {
        const aiEnv = params[fieldKey];
        const paramOverride = latestParamOverrideByField[`${t.task_id}:${fieldKey}`];
        if (!aiEnv && !paramOverride) continue;
        const overriddenValue = paramOverride ? JSON.parse(paramOverride.overridden_value_json) : null;
        rows.push({
          field: fieldKey,
          taskId: t.task_id,
          aiValue: aiEnv?.value ?? null,
          aiMeasurementType: aiEnv?.measurementType ?? "unavailable",
          clinicianValue: overriddenValue,
          source: paramOverride ? "parameter_override" : null,
          difference: paramOverride && aiEnv?.value != null && typeof overriddenValue === "number" ? round2(overriddenValue - aiEnv.value) : null,
          agreementStatus: paramOverride ? "disagree" : "not_reviewed",
        });
      }
    }

    // Session-level clinician-assessment field, compared against the most
    // recent ASRI computation where available.
    const latestAssessment = db.prepare("SELECT * FROM clinician_assessments WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId);
    if (latestAssessment) {
      const asri = resolveAsriForSession(sessionId);
      rows.push({
        field: "overallAssessment",
        taskId: null,
        aiValue: asri?.composite ?? null,
        aiMeasurementType: asri ? "estimated" : "unavailable",
        clinicianValue: latestAssessment.overall_assessment,
        source: "clinician_assessment",
        difference: null,
        agreementStatus: "not_applicable",
      });
    }
    return rows;
  }

  function buildResearchReport(sessionId) {
    const bundle = buildSessionBundle(sessionId);
    if (!bundle) return null;
    const auditRows = db.prepare("SELECT * FROM audit_log WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
    const studyMemberships = db
      .prepare(
        `SELECT d.id, d.name, d.type, m.status, m.assigned_reviewer as assignedReviewer FROM validation_datasets d
         JOIN session_dataset_membership m ON m.dataset_id = d.id WHERE m.session_id = ?`
      )
      .all(sessionId);

    const taskRows = db.prepare("SELECT * FROM task_results WHERE session_id = ?").all(sessionId);
    const taskResults = {};
    for (const row of taskRows) {
      taskResults[row.task_id] = {
        parameters: JSON.parse(row.parameters_json),
        motionAnalysis: row.motion_analysis_json ? JSON.parse(row.motion_analysis_json) : null,
        cameraQuality: row.camera_quality_json ? JSON.parse(row.camera_quality_json) : null,
        malletGrade: row.mallet_grade_json ? JSON.parse(row.mallet_grade_json) : null,
      };
    }
    const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    const taskLabels = {};
    for (const t of TASKS) taskLabels[t.id] = t.label;
    const gradeOverrides = {};
    for (const o of bundle.malletOverrides) {
      gradeOverrides[o.task_id] = { clinicianGrade: o.clinician_grade, overrideReason: o.override_reason, clinicianName: o.clinician_name, createdAt: o.created_at };
    }
    // Was a bare SELECT, which returned null for any session never opened in
    // the doctor portal -- the research report then silently omitted ASRI for
    // exactly the sessions a cohort export is most likely to touch. Routed
    // through the shared resolver, which materialises the record on first
    // access and reuses the persisted row thereafter.
    const perTaskParameters = {};
    for (const [taskId, t] of Object.entries(taskResults)) perTaskParameters[taskId] = t.parameters;

    return generateResearchReport({
      session: { sessionId: session.session_id, patientLabel: session.patient_label, side: session.side, createdAt: session.created_at, protocol: session.protocol },
      taskResults,
      asriResult: resolveAsriResult(session, perTaskParameters),
      malletOverallResult: bundle.malletOverall,
      gradeOverrides,
      taskLabels,
      validationMetadata: { malletScoreConfigVersion: malletScoreConfigStore.activeVersion, asriVersion: session.asri_version, referenceDatasetVersion: session.reference_dataset_version },
      clinicianAssessment: bundle.clinicianAssessment,
      malletOverrides: bundle.malletOverrides,
      parameterOverrides: bundle.parameterOverrides,
      comparisonRows: buildComparisonRows(sessionId),
      auditEntries: auditRows.map((r) => ({ id: r.id, entityType: r.entity_type, action: r.action, reviewerName: r.reviewer_name, summary: r.summary, createdAt: r.created_at })),
      studyMemberships,
    });
  }

  app.get("/api/dashboard/sessions/:sessionId/research-report/json", requireDashboardReviewer, (req, res) => {
    const report = buildResearchReport(req.params.sessionId);
    if (!report) return res.status(404).json({ error: "session not found" });
    res.json(report);
  });

  app.get("/api/dashboard/sessions/:sessionId/research-report/pdf", requireDashboardReviewer, async (req, res) => {
    const report = buildResearchReport(req.params.sessionId);
    if (!report) return res.status(404).json({ error: "session not found" });

    // Best-effort extras -- a representative photo per task and one task's
    // angle time series, if present. Missing data degrades gracefully
    // (renderResearchReportPdf skips sections it has nothing for), never
    // blocks report generation.
    const captureRows = db
      .prepare("SELECT task_id, file_path FROM captures WHERE session_id = ? GROUP BY task_id HAVING MIN(rowid)")
      .all(req.params.sessionId);
    const taskLabelMap = {};
    for (const t of TASKS) taskLabelMap[t.id] = t.label;
    const taskPhotos = captureRows.map((c) => ({ label: taskLabelMap[c.task_id] || c.task_id, filePath: c.file_path }));

    let angleSeries = null;
    const firstTaskWithLandmarks = db
      .prepare("SELECT task_id, filtered_landmarks_path, raw_landmarks_path FROM task_results WHERE session_id = ? AND (filtered_landmarks_path IS NOT NULL OR raw_landmarks_path IS NOT NULL) LIMIT 1")
      .get(req.params.sessionId);
    if (firstTaskWithLandmarks) {
      const session = db.prepare("SELECT side FROM sessions WHERE session_id = ?").get(req.params.sessionId);
      const framesPath = firstTaskWithLandmarks.filtered_landmarks_path || firstTaskWithLandmarks.raw_landmarks_path;
      const frames = JSON.parse(fs.readFileSync(framesPath, "utf8"));
      if (Array.isArray(frames) && frames.length > 0) {
        const t0 = frames[0].t;
        angleSeries = frames
          .filter((f) => f.lm)
          .map((f) => {
            const params = computeParameters(f.lm, session.side);
            return {
              tSec: round2((f.t - t0) / 1000),
              shoulderAbductionDeg: pickEnvelope(params.shoulderAbductionDeg),
              externalRotationDeg: pickEnvelope(params.externalRotationDeg),
              internalRotationDeg: pickEnvelope(params.internalRotationDeg),
            };
          });
      }
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="research-report-${req.params.sessionId}.pdf"`);
    await renderResearchReportPdf(report, res, { angleSeries, taskPhotos });
  });

  function resolveExportSessionIds(query) {
    if (query.sessionIds) {
      return String(query.sessionIds).split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (query.datasetId) {
      return db.prepare("SELECT session_id FROM session_dataset_membership WHERE dataset_id = ?").all(query.datasetId).map((r) => r.session_id);
    }
    return db.prepare("SELECT session_id FROM sessions").all().map((r) => r.session_id);
  }

  app.get("/api/dashboard/export/json", requireDashboardReviewer, (req, res) => {
    const bundles = resolveExportSessionIds(req.query).map(buildSessionBundle).filter(Boolean);
    res.json(buildResearchExportRows({ sessionBundles: bundles }));
  });

  app.get("/api/dashboard/export/csv", requireDashboardReviewer, (req, res) => {
    const bundles = resolveExportSessionIds(req.query).map(buildSessionBundle).filter(Boolean);
    const csv = buildResearchCsv(buildResearchExportRows({ sessionBundles: bundles }));
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="research-export-${Date.now()}.csv"`);
    res.send(csv);
  });

  app.get("/api/dashboard/export/xlsx", requireDashboardReviewer, async (req, res) => {
    const bundles = resolveExportSessionIds(req.query).map(buildSessionBundle).filter(Boolean);
    res.setHeader("Content-Disposition", `attachment; filename="research-export-${Date.now()}.xlsx"`);
    await renderResearchXlsx(buildResearchExportRows({ sessionBundles: bundles }), res);
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`shoulder-rom-backend listening on :${PORT}`));
}

main().catch((err) => {
  console.error("Fatal error during server bootstrap:", err);
  process.exit(1);
});
