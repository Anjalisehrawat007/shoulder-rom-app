const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CAPTURES_DIR = path.join(DATA_DIR, "captures");
fs.mkdirSync(CAPTURES_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "rom.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS theta_versions (
  version      TEXT PRIMARY KEY,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  patient_label      TEXT NOT NULL,
  side               TEXT NOT NULL,
  theta_version      TEXT NOT NULL,
  stage01            REAL NOT NULL,
  access_code_hash   TEXT NOT NULL,
  capture_token_hash TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  FOREIGN KEY (theta_version) REFERENCES theta_versions(version)
);

CREATE TABLE IF NOT EXISTS task_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  domain_scores_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(session_id, task_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
`);

module.exports = { db, CAPTURES_DIR };
