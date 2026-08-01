const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CAPTURES_DIR = path.join(DATA_DIR, "captures");
fs.mkdirSync(CAPTURES_DIR, { recursive: true });

// Phase 6: per-task video + raw/filtered landmark sequences. Same
// file-on-disk-plus-path-in-DB pattern as CAPTURES_DIR above -- large
// per-frame data doesn't belong inlined as a JSON column (DMQE's own
// storage-trimming decision in Phase 3 already flagged this concern for
// much smaller payloads than a full landmark sequence or a video clip).
const TASK_DATA_DIR = path.join(DATA_DIR, "task-data");
fs.mkdirSync(TASK_DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "rom.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS asri_config_versions (
  version      TEXT PRIMARY KEY,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reference_dataset_versions (
  version      TEXT PRIMARY KEY,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Phase 5: Intelligent Camera Quality Assurance. Same versioned/immutable
-- shape as asri_config_versions/reference_dataset_versions above -- ICQA
-- does not import shared/asri/*, but the STORAGE pattern is intentionally
-- identical since it already proved itself for config versioning.
CREATE TABLE IF NOT EXISTS icqa_config_versions (
  version      TEXT PRIMARY KEY,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- Phase 6: Modified Mallet Assessment. Same versioned/immutable shape as
-- asri_config_versions/icqa_config_versions above.
CREATE TABLE IF NOT EXISTS mallet_score_config_versions (
  version      TEXT PRIMARY KEY,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id              TEXT PRIMARY KEY,
  patient_label           TEXT NOT NULL,
  side                    TEXT NOT NULL,
  asri_version            TEXT NOT NULL,
  reference_dataset_version TEXT,
  stage01                 REAL NOT NULL,
  access_code_hash        TEXT NOT NULL,
  capture_token_hash      TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  age_months              REAL,
  months_since_surgery    REAL,
  hospital_id             TEXT,
  protocol                TEXT DEFAULT 'modified_mallet',
  FOREIGN KEY (asri_version) REFERENCES asri_config_versions(version)
);

CREATE TABLE IF NOT EXISTS asri_computations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  computed_at   TEXT NOT NULL,
  asri_version  TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS task_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  domain_scores_json TEXT NOT NULL,
  motion_analysis_json TEXT,
  camera_quality_json TEXT,
  icqa_version    TEXT,
  mallet_grade_json TEXT,
  mallet_score_config_version TEXT,
  raw_landmarks_path TEXT,
  filtered_landmarks_path TEXT,
  video_path      TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE(session_id, task_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

-- Phase 6: AI-predicted Mallet grade overrides. Append-only (never UPDATEd),
-- same immutable-history principle as clinician_assessments -- a clinician
-- correcting a predicted grade inserts a NEW row with supersedes_id
-- pointing at the prior one. Deliberately a SEPARATE table from
-- clinician_assessments (Phase 4): that table holds an independent
-- clinician-entered ground-truth assessment for validation purposes; this
-- one holds a clinician's review of THIS APP's own AI prediction for a
-- specific task -- conflating the two would corrupt Phase 4's app-vs-
-- clinician validation design, which depends on the two staying independent.
CREATE TABLE IF NOT EXISTS mallet_grade_overrides (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  predicted_grade   TEXT,
  clinician_grade   TEXT NOT NULL,
  difference        INTEGER,
  override_reason   TEXT,
  clinician_name    TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  supersedes_id     INTEGER,
  created_at        TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (supersedes_id) REFERENCES mallet_grade_overrides(id)
);

CREATE TABLE IF NOT EXISTS captures (
  capture_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  timestamp       REAL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS review_tokens (
  token       TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Phase 4: Clinical Validation Engine. clinician_assessments is append-only
-- (never UPDATEd) -- a correction inserts a new row with supersedes_id
-- pointing at the prior one, same immutable-history principle already used
-- for asri_config_versions/reference_dataset_versions.
CREATE TABLE IF NOT EXISTS clinician_assessments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL,
  hospital_id           TEXT NOT NULL,
  assessment_date       TEXT NOT NULL,
  affected_side         TEXT,
  age                   REAL,
  sex                   TEXT,
  months_since_surgery  REAL,
  clinician_name        TEXT NOT NULL,
  hospital              TEXT,
  shoulder_abduction    REAL,
  shoulder_flexion      REAL,
  external_rotation     REAL,
  internal_rotation     REAL,
  rom                   REAL,
  mallet_score_json     TEXT,
  ams_score             REAL,
  other_scores_json     TEXT,
  notes                 TEXT,
  version               INTEGER NOT NULL DEFAULT 1,
  supersedes_id         INTEGER,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (supersedes_id) REFERENCES clinician_assessments(id)
);

CREATE TABLE IF NOT EXISTS validation_datasets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  notes        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_dataset_membership (
  session_id   TEXT NOT NULL,
  dataset_id   INTEGER NOT NULL,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, dataset_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (dataset_id) REFERENCES validation_datasets(id)
);

CREATE TABLE IF NOT EXISTS validation_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id       INTEGER,
  generated_at     TEXT NOT NULL,
  report_json      TEXT NOT NULL,
  report_version   TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES validation_datasets(id)
);

-- Phase 9: Clinician Research Dashboard. dashboard_reviewers is just a
-- "known names" registry behind the reviewer picker -- NOT an accounts/auth
-- table (no password, no per-person secret). dashboard_tokens is the
-- dashboard-wide gate's session concept, deliberately separate from
-- review_tokens above: review_tokens gates ONE unlocked patient's photos/
-- video for ~60 minutes; dashboard_tokens gates the WHOLE multi-patient
-- dashboard for a longer shift-length session, and carries a reviewer
-- identity once one is picked.
CREATE TABLE IF NOT EXISTS dashboard_reviewers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_tokens (
  token          TEXT PRIMARY KEY,
  reviewer_id    INTEGER,
  reviewer_name  TEXT,
  issued_at      TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  FOREIGN KEY (reviewer_id) REFERENCES dashboard_reviewers(id)
);

-- Phase 9: the GENERALIZED clinician override mechanism, for any displayed
-- value other than the Mallet grade (which already has its own, unchanged
-- mallet_grade_overrides table above -- this table deliberately does not
-- duplicate that). Append-only, same immutable-history principle as
-- mallet_grade_overrides/clinician_assessments: a correction inserts a new
-- row with supersedes_id, never an UPDATE. original_value_json is
-- snapshotted server-side from task_results.parameters_json at write time
-- (see server.js) -- never trusted from the request body, so it can't be
-- spoofed to manufacture a fake "AI value."
CREATE TABLE IF NOT EXISTS parameter_overrides (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT NOT NULL,
  task_id                TEXT,
  field_key              TEXT NOT NULL,
  field_label            TEXT NOT NULL,
  original_value_json    TEXT,
  overridden_value_json  TEXT NOT NULL,
  override_reason        TEXT,
  reviewer_name          TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  supersedes_id          INTEGER,
  created_at             TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (supersedes_id) REFERENCES parameter_overrides(id)
);

-- Phase 9: full audit trail of every clinician edit (Mallet overrides,
-- parameter overrides, clinician assessments, study assignment/status
-- changes). Written by the recordAudit() helper in server.js inside the
-- SAME db.transaction() as the primary write it's logging, so an audit row
-- can never exist without its write, or vice versa. entity_id is an
-- unenforced polymorphic reference (which table it points into depends on
-- entity_type) -- same looseness validation_reports.dataset_id already has
-- when dataset_id is NULL for a non-dataset-scoped report.
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT,
  entity_type    TEXT NOT NULL,
  entity_id      INTEGER,
  action         TEXT NOT NULL,
  reviewer_name  TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail_json    TEXT,
  created_at     TEXT NOT NULL
);
`);

// ---- migration for databases created before Phase 2 ------------------------
// The old `sessions` table's FOREIGN KEY (theta_version) targets the old
// `theta_versions` table by name. SQLite's ALTER TABLE can rename a column
// (updating references to that column's NAME within the table's own FK
// definitions) but cannot repoint a FK at a DIFFERENT target table -- so a
// pre-Phase-2 sessions table would keep pointing at `theta_versions` (which
// no longer holds the active "2.0.0" asri-config version) even after a
// column rename, and every new INSERT would fail FOREIGN KEY constraint
// checks. Since no real patient data exists yet (only smoke-test sessions
// from earlier phases -- see git history), the correct fix here is a clean
// rebuild of the session-related tables under the new schema, not a
// data-preserving migration. A real deployment with real patient data would
// need an actual data migration instead of this drop-and-recreate.
const tableExists = (name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const columnNames = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

if (tableExists("sessions") && !columnNames("sessions").has("reference_dataset_version")) {
  console.log("[db] Rebuilding session-related tables for the Phase 2 schema (asri_version FK, patient-context columns). Existing sessions were prototype/test data only and are being cleared, not migrated -- see db.js for why.");
  db.exec(`
    DROP TABLE IF EXISTS review_tokens;
    DROP TABLE IF EXISTS asri_computations;
    DROP TABLE IF EXISTS captures;
    DROP TABLE IF EXISTS task_results;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS theta_versions;
  `);
  db.exec(`
    CREATE TABLE sessions (
      session_id              TEXT PRIMARY KEY,
      patient_label           TEXT NOT NULL,
      side                    TEXT NOT NULL,
      asri_version            TEXT NOT NULL,
      reference_dataset_version TEXT,
      stage01                 REAL NOT NULL,
      access_code_hash        TEXT NOT NULL,
      capture_token_hash      TEXT NOT NULL,
      created_at              TEXT NOT NULL,
      age_months              REAL,
      months_since_surgery    REAL,
      hospital_id             TEXT,
      FOREIGN KEY (asri_version) REFERENCES asri_config_versions(version)
    );
    CREATE TABLE asri_computations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      computed_at   TEXT NOT NULL,
      asri_version  TEXT NOT NULL,
      result_json   TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE task_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      domain_scores_json TEXT NOT NULL,
      motion_analysis_json TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE(session_id, task_id),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE captures (
      capture_id      TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      timestamp       REAL,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE review_tokens (
      token       TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );
  `);
}

// ---- migration for databases created before Phase 3 ------------------------
// Purely additive this time (no FK involved) -- a plain ALTER TABLE ADD
// COLUMN is sufficient, unlike the Phase 2 sessions-table rebuild above.
if (tableExists("task_results") && !columnNames("task_results").has("motion_analysis_json")) {
  db.exec("ALTER TABLE task_results ADD COLUMN motion_analysis_json TEXT");
}

// ---- migration for databases created before Phase 4 ------------------------
// Additive: dataset-metadata columns (Part 8) for querying without parsing
// motion_analysis_json every time.
if (tableExists("task_results")) {
  const cols = columnNames("task_results");
  if (!cols.has("dmqe_version")) db.exec("ALTER TABLE task_results ADD COLUMN dmqe_version TEXT");
  if (!cols.has("filter_version")) db.exec("ALTER TABLE task_results ADD COLUMN filter_version TEXT");
}

// ---- migration for databases created before Phase 5 ------------------------
// Additive, same pattern as the Phase 4 block above: ICQA's capture-quality
// result for the task (subscores, gate outcome, quality timeline) and the
// config version it was scored under.
if (tableExists("task_results")) {
  const cols = columnNames("task_results");
  if (!cols.has("camera_quality_json")) db.exec("ALTER TABLE task_results ADD COLUMN camera_quality_json TEXT");
  if (!cols.has("icqa_version")) db.exec("ALTER TABLE task_results ADD COLUMN icqa_version TEXT");
}

// ---- migration for databases created before Phase 6 ------------------------
// Additive: the AI-predicted Mallet grade for the task, the config version
// it was scored under, and file-path references for this task's raw/
// filtered landmark sequences and video (the files themselves live under
// TASK_DATA_DIR, same pattern as CAPTURES_DIR for photos). Also a
// `protocol` column on sessions for the new Assessment Selection screen
// (only "modified_mallet" exists today, but the column makes room for a
// future protocol without another migration).
if (tableExists("task_results")) {
  const cols = columnNames("task_results");
  if (!cols.has("mallet_grade_json")) db.exec("ALTER TABLE task_results ADD COLUMN mallet_grade_json TEXT");
  if (!cols.has("mallet_score_config_version")) db.exec("ALTER TABLE task_results ADD COLUMN mallet_score_config_version TEXT");
  if (!cols.has("raw_landmarks_path")) db.exec("ALTER TABLE task_results ADD COLUMN raw_landmarks_path TEXT");
  if (!cols.has("filtered_landmarks_path")) db.exec("ALTER TABLE task_results ADD COLUMN filtered_landmarks_path TEXT");
  if (!cols.has("video_path")) db.exec("ALTER TABLE task_results ADD COLUMN video_path TEXT");
}
if (tableExists("sessions") && !columnNames("sessions").has("protocol")) {
  db.exec("ALTER TABLE sessions ADD COLUMN protocol TEXT DEFAULT 'modified_mallet'");
}

// ---- migration for databases created before Phase 9 ------------------------
// Additive: the Clinician Assessment Panel's 4 new fields (clinician_assessments
// already covered ROM/Mallet/AMS/notes; this closes the gap against Phase 9's
// spec). Pilot Study Management fields on validation_datasets/
// session_dataset_membership -- a pilot study IS a validation_datasets row
// (type='pilot'); these columns add per-membership assignment/status/
// completion tracking that table never needed for its original Phase 4
// QC-grouping purpose.
if (tableExists("clinician_assessments")) {
  const cols = columnNames("clinician_assessments");
  if (!cols.has("compensation_severity")) db.exec("ALTER TABLE clinician_assessments ADD COLUMN compensation_severity TEXT");
  if (!cols.has("overall_assessment")) db.exec("ALTER TABLE clinician_assessments ADD COLUMN overall_assessment TEXT");
  if (!cols.has("clinician_confidence_pct")) db.exec("ALTER TABLE clinician_assessments ADD COLUMN clinician_confidence_pct REAL");
  if (!cols.has("clinician_recommendation")) db.exec("ALTER TABLE clinician_assessments ADD COLUMN clinician_recommendation TEXT");
}
if (tableExists("validation_datasets") && !columnNames("validation_datasets").has("status")) {
  db.exec("ALTER TABLE validation_datasets ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}
if (tableExists("session_dataset_membership")) {
  const cols = columnNames("session_dataset_membership");
  if (!cols.has("status")) db.exec("ALTER TABLE session_dataset_membership ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  if (!cols.has("assigned_reviewer")) db.exec("ALTER TABLE session_dataset_membership ADD COLUMN assigned_reviewer TEXT");
  if (!cols.has("assigned_at")) db.exec("ALTER TABLE session_dataset_membership ADD COLUMN assigned_at TEXT");
  if (!cols.has("completed_at")) db.exec("ALTER TABLE session_dataset_membership ADD COLUMN completed_at TEXT");
}

module.exports = { db, CAPTURES_DIR, TASK_DATA_DIR };
