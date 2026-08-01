#!/usr/bin/env node
/**
 * verify-dashboard-api.mjs — Phase 9 backend integration test suite
 * ----------------------------------------------------------------------------
 * The first real backend-integration test in this repo (every prior
 * verify-*.mjs is a pure-function test against shared/*). Spawns
 * backend/server.js as a real child process against a throwaway DATA_DIR
 * and exercises the new Phase 9 routes with real HTTP requests via fetch,
 * asserting status codes, response shapes, and append-only/audit semantics
 * end to end -- not just that the handler functions exist.
 *
 * Run: node scripts/verify-dashboard-api.mjs
 * ----------------------------------------------------------------------------
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PORT = 4571;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = path.join("/tmp", `rom-dashboard-api-test-${Date.now()}`);
const PASSCODE = "test-passcode-9";

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn("node", ["backend/server.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT), DASHBOARD_PASSCODE: PASSCODE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));
  return { child, getLog: () => out };
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function json(method, urlPath, body, headers = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

async function main() {
  const { child, getLog } = startServer();
  const up = await waitForHealth();
  assertTrue("server boots against a throwaway DATA_DIR and responds to /api/health", up);
  if (!up) {
    console.log("--- server log ---\n" + getLog());
    child.kill();
    process.exit(1);
  }

  try {
    // ---- 1. Dashboard login / reviewer identity ----------------------------
    const wrongLogin = await json("POST", "/api/dashboard/login", { passcode: "wrong" });
    assertTrue("login: wrong passcode -> 401", wrongLogin.status === 401);

    const login = await json("POST", "/api/dashboard/login", { passcode: PASSCODE });
    assertTrue("login: correct passcode -> dashboardToken issued", login.status === 200 && !!login.data.dashboardToken);
    const dashAuth = { authorization: `Bearer ${login.data.dashboardToken}` };

    const sessionsNoReviewer = await json("GET", "/api/dashboard/sessions", undefined, dashAuth);
    assertTrue("dashboard-token-only (no reviewer picked yet) -> 401 on a reviewer-gated route", sessionsNoReviewer.status === 401);

    const addReviewer = await json("POST", "/api/dashboard/reviewers", { name: "Dr. Test Reviewer" }, dashAuth);
    assertTrue("reviewer registry: add a new reviewer", addReviewer.status === 200 && addReviewer.data.name === "Dr. Test Reviewer");

    const listReviewers = await json("GET", "/api/dashboard/reviewers", undefined, dashAuth);
    assertTrue("reviewer registry: newly added reviewer appears in the list", listReviewers.data.reviewers.some((r) => r.name === "Dr. Test Reviewer"));

    const pickReviewer = await json("POST", "/api/dashboard/reviewer-session", { reviewerId: addReviewer.data.id }, dashAuth);
    assertTrue("reviewer-session: picking a reviewer succeeds", pickReviewer.status === 200 && pickReviewer.data.reviewerName === "Dr. Test Reviewer");

    // ---- 2. Seed a real session + task result (via the existing, unchanged capture API) ----
    const sessionId = String(1000000 + Math.floor(Math.random() * 8999999));
    const createSession = await json("POST", "/api/sessions", {
      sessionId,
      patientLabel: "PHASE9-API-TEST",
      side: "right",
      asriVersion: "2.0.0",
    });
    assertTrue("seed: session created via the existing, unchanged POST /api/sessions", createSession.status === 200, JSON.stringify(createSession.data));
    const captureAuth = { authorization: `Bearer ${createSession.data.captureToken}` };

    const shoulderAbductionDeg = { value: 62, unit: "deg", measurementType: "measured", confidence: "high" };
    const externalRotationDeg = { value: 30, unit: "deg", measurementType: "estimated", confidence: "moderate" };
    const taskResult = await json(
      "POST",
      `/api/sessions/${sessionId}/tasks/global_abduction`,
      { parameters: { shoulderAbductionDeg, externalRotationDeg }, domainScores: {}, malletGrade: { grade: "III", gradeConfigVersion: "1.0.0" } },
      captureAuth
    );
    assertTrue("seed: task result recorded via the existing, unchanged task-result endpoint", taskResult.status === 200);

    // ---- 3. Dashboard session list / summary --------------------------------
    const list = await json("GET", `/api/dashboard/sessions?search=PHASE9-API-TEST`, undefined, dashAuth);
    assertTrue("dashboard sessions list: the seeded session is findable by search", list.status === 200 && list.data.sessions.some((s) => s.sessionId === sessionId));
    const listed = list.data.sessions.find((s) => s.sessionId === sessionId);
    assertTrue("dashboard sessions list: task-completion count reflects the one recorded task", listed?.tasksCompleted === 1);

    const summary = await json("GET", `/api/dashboard/sessions/${sessionId}/summary`, undefined, dashAuth);
    assertTrue("session summary: reuses buildMalletReport() and returns a reviewToken", summary.status === 200 && !!summary.data.reviewToken && !!summary.data.report);
    assertTrue("session summary: taskMedia is present for the recorded task", !!summary.data.taskMedia?.global_abduction);

    // ---- 4. Generalized parameter override (append-only + audit) -----------
    const badOverride = await json("POST", `/api/sessions/${sessionId}/parameter-overrides`, { fieldKey: "shoulderAbductionDeg", fieldLabel: "Shoulder Abduction", overriddenValue: 70 });
    assertTrue("parameter-override: unauthenticated request -> 401", badOverride.status === 401);

    const override1 = await json(
      "POST",
      `/api/sessions/${sessionId}/parameter-overrides`,
      { taskId: "global_abduction", fieldKey: "shoulderAbductionDeg", fieldLabel: "Shoulder Abduction", overriddenValue: 70, overrideReason: "Clinician re-measured" },
      dashAuth
    );
    assertTrue("parameter-override: authenticated write succeeds, version 1", override1.status === 200 && override1.data.version === 1);
    assertTrue("parameter-override: original AI value snapshotted server-side matches the stored task_results value (never trusted from the client)", override1.data.originalValue?.value === 62);

    const override2 = await json(
      "POST",
      `/api/sessions/${sessionId}/parameter-overrides`,
      { taskId: "global_abduction", fieldKey: "shoulderAbductionDeg", fieldLabel: "Shoulder Abduction", overriddenValue: 72, overrideReason: "Refined re-measure", supersedesId: override1.data.id },
      dashAuth
    );
    assertTrue("parameter-override: a correction supersedes the prior row, version 2", override2.status === 200 && override2.data.version === 2);

    const overrideList = await json("GET", `/api/sessions/${sessionId}/parameter-overrides`, undefined, dashAuth);
    assertTrue("parameter-override: append-only -- BOTH rows still exist (2 total), never overwritten", overrideList.data.overrides.length === 2);
    assertTrue("parameter-override: the second row's supersedesId chains to the first", overrideList.data.overrides[1].supersedesId === override1.data.id);
    assertTrue("parameter-override: original task_results value is untouched by the override (never mutated)", (await json("GET", `/api/dashboard/sessions/${sessionId}/summary`, undefined, dashAuth)).data.report.taskRows.find((t) => t.taskId === "global_abduction").measurements.shoulderAbductionDeg.value === 62);

    // ---- 5. Mallet-grade override (existing endpoint) now also audits ------
    const malletOverride = await json("POST", `/api/sessions/${sessionId}/tasks/global_abduction/mallet-override`, { clinicianGrade: "IV", clinicianName: "Dr. Test Reviewer", overrideReason: "Fuller ROM observed" });
    assertTrue("mallet-override: existing endpoint (unchanged request shape) still works", malletOverride.status === 200 && malletOverride.data.predictedGrade === "III");

    // ---- 6. AI vs Clinician comparison (derived) ----------------------------
    const comparison = await json("GET", `/api/dashboard/sessions/${sessionId}/comparison`, undefined, dashAuth);
    const abductionRow = comparison.data.rows.find((r) => r.field === "shoulderAbductionDeg" && r.taskId === "global_abduction");
    assertTrue("comparison: shows the AI value untouched (62) alongside the latest override (72)", abductionRow?.aiValue === 62 && abductionRow?.clinicianValue === 72);
    assertTrue("comparison: flags disagreement for an overridden field", abductionRow?.agreementStatus === "disagree");
    const malletRow = comparison.data.rows.find((r) => r.field === "malletGrade" && r.taskId === "global_abduction");
    assertTrue("comparison: Mallet-grade row shows AI III vs clinician IV, disagreement", malletRow?.aiValue === "III" && malletRow?.clinicianValue === "IV" && malletRow?.agreementStatus === "disagree");

    // ---- 7. Audit log completeness ------------------------------------------
    const audit = await json("GET", `/api/dashboard/audit-log?sessionId=${sessionId}`, undefined, dashAuth);
    const paramAuditEntries = audit.data.entries.filter((e) => e.entityType === "parameter_override");
    const malletAuditEntries = audit.data.entries.filter((e) => e.entityType === "mallet_override");
    assertTrue("audit log: exactly 2 parameter_override entries (one per write)", paramAuditEntries.length === 2, `got ${paramAuditEntries.length}`);
    assertTrue("audit log: exactly 1 mallet_override entry", malletAuditEntries.length === 1, `got ${malletAuditEntries.length}`);
    assertTrue("audit log: reviewer_name is sourced from the server-side token, matches the picked reviewer", paramAuditEntries.every((e) => e.reviewerName === "Dr. Test Reviewer"));

    // ---- 8. Clinician Assessment Panel extension ----------------------------
    const assessment = await json("POST", "/api/clinician-assessments", {
      sessionId,
      hospitalId: sessionId,
      assessmentDate: new Date().toISOString().slice(0, 10),
      clinicianName: "Dr. Test Reviewer",
      compensationSeverity: "mild",
      overallAssessment: "Good functional recovery",
      clinicianConfidencePct: 85,
      clinicianRecommendation: "Continue home program",
    });
    assertTrue("clinician-assessments: new Phase 9 fields accepted", assessment.status === 200);
    const assessmentGet = await json("GET", `/api/clinician-assessments/${sessionId}`, undefined);
    const savedAssessment = assessmentGet.data.assessments[0];
    assertTrue("clinician-assessments: new fields round-trip correctly", savedAssessment.compensationSeverity === "mild" && savedAssessment.clinicianConfidencePct === 85 && savedAssessment.clinicianRecommendation === "Continue home program");
    const assessmentAudit = await json("GET", `/api/dashboard/audit-log?sessionId=${sessionId}&entityType=clinician_assessment`, undefined, dashAuth);
    assertTrue("clinician-assessments: also produces exactly one audit entry", assessmentAudit.data.entries.length === 1);

    // ---- 9. Angle time series (read-only use of the frozen biomechanics engine) ----
    const noLandmarks = await json("GET", `/api/sessions/${sessionId}/tasks/global_abduction/angle-timeseries?reviewToken=${summary.data.reviewToken}`, undefined);
    assertTrue("angle-timeseries: 404 when no landmark data was ever uploaded for this task (honest, not fabricated)", noLandmarks.status === 404);

    // ---- 10. Pilot Study Management -----------------------------------------
    const createStudy = await json("POST", "/api/validation-datasets", { name: "Phase 9 API Test Pilot", type: "pilot", notes: "test" });
    assertTrue("pilot study: create (reuses existing validation-datasets endpoint)", createStudy.status === 200);
    const studyId = createStudy.data.id;

    const assign = await json("POST", `/api/validation-datasets/${studyId}/sessions`, { sessionId, assignedReviewer: "Dr. Test Reviewer" });
    assertTrue("pilot study: assign session + reviewer", assign.status === 200);

    const patchStatus = await json("PATCH", `/api/validation-datasets/${studyId}/sessions/${sessionId}`, { status: "completed" }, dashAuth);
    assertTrue("pilot study: mark assignment completed (authenticated)", patchStatus.status === 200);

    const patchStatusUnauth = await json("PATCH", `/api/validation-datasets/${studyId}/sessions/${sessionId}`, { status: "pending" });
    assertTrue("pilot study: status change requires a dashboard reviewer -> 401 without one", patchStatusUnauth.status === 401);

    const stats = await json("GET", `/api/validation-datasets/${studyId}/stats`, undefined, dashAuth);
    assertTrue("pilot study: stats show 100% complete (1 of 1 assigned sessions completed)", stats.data.total === 1 && stats.data.percentComplete === 100, JSON.stringify(stats.data));

    const patchDataset = await json("PATCH", `/api/validation-datasets/${studyId}`, { status: "completed" }, dashAuth);
    assertTrue("pilot study: dataset-level status update", patchDataset.status === 200);

    const studyAudit = await json("GET", `/api/dashboard/audit-log?entityType=study_assignment`, undefined, dashAuth);
    assertTrue("pilot study: assignment status change produced an audit entry", studyAudit.data.entries.length >= 1);
    const studyStatusAudit = await json("GET", `/api/dashboard/audit-log?entityType=study_status`, undefined, dashAuth);
    assertTrue("pilot study: dataset status change produced an audit entry", studyStatusAudit.data.entries.length >= 1);

    // ---- 11. Research export: JSON / CSV / XLSX ------------------------------
    const exportJson = await fetch(`${BASE}/api/dashboard/export/json?sessionIds=${sessionId}`, { headers: dashAuth });
    const exportJsonBody = await exportJson.json();
    assertTrue("export/json: returns the 4 categorized row groups", exportJson.status === 200 && ["measurements", "clinicianScores", "agreement", "overrideHistory"].every((k) => Array.isArray(exportJsonBody[k])));
    assertTrue("export/json: measurements includes the seeded shoulderAbductionDeg row (AI value, untouched by overrides)", exportJsonBody.measurements.some((r) => r.field === "shoulderAbductionDeg" && r.value === 62));
    assertTrue("export/json: overrideHistory includes both parameter-override versions (append-only, not collapsed)", exportJsonBody.overrideHistory.filter((r) => r.field === "shoulderAbductionDeg").length === 2);
    assertTrue("export/json: clinicianScores row carries the Clinician Assessment Panel fields", exportJsonBody.clinicianScores[0]?.clinicianOverallAssessment === "Good functional recovery");
    assertTrue("export/json: clinicianScores row carries a real ASRI composite number (field-name regression check)", typeof exportJsonBody.clinicianScores[0]?.asriComposite === "number", JSON.stringify(exportJsonBody.clinicianScores[0]));

    const exportCsvRes = await fetch(`${BASE}/api/dashboard/export/csv?sessionIds=${sessionId}`, { headers: dashAuth });
    const csvText = await exportCsvRes.text();
    assertTrue("export/csv: content-type is text/csv", exportCsvRes.headers.get("content-type")?.includes("text/csv"));
    assertTrue("export/csv: contains a section header per category", ["## measurements", "## clinicianScores", "## agreement", "## overrideHistory"].every((h) => csvText.includes(h)));
    assertTrue("export/csv: measurement row values match the JSON export (same shared row-shaping function)", csvText.includes("shoulderAbductionDeg") && csvText.includes("62"));

    const exportXlsxRes = await fetch(`${BASE}/api/dashboard/export/xlsx?sessionIds=${sessionId}`, { headers: dashAuth });
    const xlsxBuffer = Buffer.from(await exportXlsxRes.arrayBuffer());
    assertTrue("export/xlsx: content-type is a real spreadsheet MIME type", exportXlsxRes.headers.get("content-type")?.includes("spreadsheetml"));
    assertTrue("export/xlsx: non-empty binary payload with the .xlsx (ZIP) magic bytes 'PK'", xlsxBuffer.length > 1000 && xlsxBuffer[0] === 0x50 && xlsxBuffer[1] === 0x4b);

    // Round-trip check: actually parse the bytes we just downloaded with
    // exceljs (installed under backend/node_modules) to confirm it's a
    // genuine, readable workbook -- not just plausible-looking bytes. Run
    // from a child process with cwd=backend/ since exceljs isn't resolvable
    // from scripts/'s own module path.
    const xlsxTmpPath = path.join(DATA_DIR, "export-roundtrip-test.xlsx");
    fs.writeFileSync(xlsxTmpPath, xlsxBuffer);
    const roundTripScript = `
      const ExcelJS = require("exceljs");
      (async () => {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(${JSON.stringify(xlsxTmpPath)});
        const summary = {};
        wb.eachSheet((sheet) => { summary[sheet.name] = sheet.rowCount; });
        console.log(JSON.stringify(summary));
      })();
    `;
    const roundTrip = await new Promise((resolve) => {
      const p = spawn("node", ["-e", roundTripScript], { cwd: path.join(REPO_ROOT, "backend"), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", () => resolve({ stdout, stderr }));
    });
    let sheetSummary = {};
    try {
      sheetSummary = JSON.parse(roundTrip.stdout.trim());
    } catch {
      /* leave empty, assertion below fails with detail */
    }
    assertTrue(
      "export/xlsx: exceljs can genuinely re-read the workbook it just wrote (round-trip), with a header row + data rows in Measurements",
      sheetSummary["Measurements"] > 1,
      JSON.stringify(sheetSummary) + (roundTrip.stderr ? " stderr: " + roundTrip.stderr.slice(0, 200) : "")
    );

    // ---- 12. Research report (JSON + PDF) ------------------------------------
    const researchJson = await json("GET", `/api/dashboard/sessions/${sessionId}/research-report/json`, undefined, dashAuth);
    assertTrue("research-report/json: succeeds and reuses the Mallet taskRows", researchJson.status === 200 && researchJson.data.taskRows.length === 1);
    assertTrue("research-report/json: includes the Clinician Assessment Panel section", researchJson.data.clinicianAssessmentPanel?.overallAssessment === "Good functional recovery");
    assertTrue("research-report/json: includes full override history (mallet + parameter, 3 total)", researchJson.data.overrideHistory.length === 3);
    assertTrue("research-report/json: includes audit summary with a non-zero count", researchJson.data.auditSummary.totalEntries > 0);
    assertTrue("research-report/json: includes the pilot study assigned in step 10 above", researchJson.data.researchMetadata.studyMemberships.some((s) => s.name === "Phase 9 API Test Pilot"));

    const researchPdfRes = await fetch(`${BASE}/api/dashboard/sessions/${sessionId}/research-report/pdf`, { headers: dashAuth });
    const pdfBuffer = Buffer.from(await researchPdfRes.arrayBuffer());
    assertTrue("research-report/pdf: content-type is application/pdf", researchPdfRes.headers.get("content-type") === "application/pdf");
    assertTrue("research-report/pdf: non-empty payload with the %PDF magic bytes", pdfBuffer.length > 500 && pdfBuffer.slice(0, 4).toString() === "%PDF");

    // ---- 13. Regression: existing routes untouched --------------------------
    const unlock = await json("POST", `/api/sessions/${sessionId}/unlock`, { accessCode: createSession.data.accessCode });
    assertTrue("regression: the original per-patient unlock flow still works unchanged", unlock.status === 200 && unlock.data.taskResults.global_abduction.parameters.shoulderAbductionDeg.value === 62);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  } finally {
    child.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error in test runner:", err);
  process.exit(1);
});
