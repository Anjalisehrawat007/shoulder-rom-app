#!/usr/bin/env node
/**
 * verify-validation-api.mjs — Phase 10 backend integration test suite
 * ----------------------------------------------------------------------------
 * Same pattern as scripts/verify-dashboard-api.mjs (Phase 9): spawns
 * backend/server.js as a real child process against a throwaway DATA_DIR
 * and exercises the new/changed /api/validation/* routes with real HTTP
 * requests -- this is the layer scripts/verify-validation.mjs's pure-
 * function tests don't cover (loadValidationExtras()'s mallet-grade-pair
 * aggregation, the new PDF/CSV/XLSX export routes, and runValidation()
 * wired through real stored data end to end).
 *
 * Run: node scripts/verify-validation-api.mjs
 * ----------------------------------------------------------------------------
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PORT = 4573;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = path.join("/tmp", `rom-validation-api-test-${Date.now()}`);

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn("node", ["backend/server.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATA_DIR, PORT: String(PORT) },
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
    // ---- Seed 3 patients: sessions + task results + clinician assessments + mallet overrides ----
    const patients = [
      { id: "2220001", abd: 90, mallet: "III", clinicianGrade: "III" },
      { id: "2220002", abd: 100, mallet: "IV", clinicianGrade: "III" }, // off-by-one disagreement
      { id: "2220003", abd: 70, mallet: "II", clinicianGrade: "II" },
    ];
    for (const p of patients) {
      const created = await json("POST", "/api/sessions", { sessionId: p.id, patientLabel: `Patient ${p.id}`, side: "right", asriVersion: "2.0.0" });
      assertTrue(`seed: session ${p.id} created`, created.status === 200, JSON.stringify(created.data));
      const captureAuth = { authorization: `Bearer ${created.data.captureToken}` };
      await json(
        "POST",
        `/api/sessions/${p.id}/tasks/global_abduction`,
        { parameters: { shoulderAbductionDeg: { value: p.abd, unit: "deg", measurementType: "measured", confidence: "high" } }, domainScores: {}, malletGrade: { grade: p.mallet, gradeConfigVersion: "1.0.0" }, cameraQuality: { status: "ok", cqi: 65 } },
        captureAuth
      );
      await json("POST", "/api/clinician-assessments", { sessionId: p.id, hospitalId: p.id, assessmentDate: "2026-07-01", clinicianName: "Dr. API Test", shoulderAbduction: p.abd + 2, age: 30, sex: "F" });
      await json("POST", `/api/sessions/${p.id}/tasks/global_abduction/mallet-override`, { clinicianGrade: p.clinicianGrade, clinicianName: "Dr. API Test", overrideReason: "api test" });
    }

    // ---- Run validation, confirm the new Phase 10 sections are wired through the real backend ----
    const runResult = await json("POST", "/api/validation/run", { datasetName: "Phase 10 API test" });
    assertTrue("validation/run: succeeds", runResult.status === 200);
    assertTrue("validation/run: malletAgreement reflects the real seeded overrides (3 pairs, 2 exact)", runResult.data.malletAgreement.percentAgreement.n === 3 && runResult.data.malletAgreement.percentAgreement.exactMatchPct > 60);
    assertTrue("validation/run: repeatabilityResults present (betweenSession + honest not_computable withinSession)", runResult.data.repeatabilityResults.withinSession.status === "not_computable");
    assertTrue("validation/run: publicationTables has all 7 tables", Object.keys(runResult.data.publicationTables).length === 7);
    assertTrue("validation/run: pilotStudySummary readiness classification present", runResult.data.pilotStudySummary.readiness.engineeringVerification.status === "complete");
    assertTrue("validation/run: comparisonResults carry the new pearsonR95CI field", "pearsonR95CI" in runResult.data.comparisonResults.shoulderAbductionDeg);

    // ---- Fetch the persisted report and confirm the id is retrievable ----
    const reportsList = await json("GET", "/api/validation/reports");
    const reportId = reportsList.data.reports[0].id;
    assertTrue("validation/reports: newly run report is listed", reportsList.data.reports.some((r) => r.id === reportId));

    const reportJson = await json("GET", `/api/validation/reports/${reportId}`);
    assertTrue("validation/reports/:id: returns the full stored result, publicationTables included", "publicationTables" in reportJson.data);

    // ---- Export routes: PDF, CSV, XLSX ----
    const pdfRes = await fetch(`${BASE}/api/validation/reports/${reportId}/pdf`);
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    assertTrue("reports/:id/pdf: content-type is application/pdf", pdfRes.headers.get("content-type") === "application/pdf");
    assertTrue("reports/:id/pdf: real PDF magic bytes, non-trivial size", pdfBuffer.slice(0, 4).toString() === "%PDF" && pdfBuffer.length > 2000);

    const csvRes = await fetch(`${BASE}/api/validation/reports/${reportId}/csv`);
    const csvText = await csvRes.text();
    assertTrue("reports/:id/csv: content-type is text/csv", csvRes.headers.get("content-type")?.includes("text/csv"));
    assertTrue("reports/:id/csv: contains all 7 publication-table section headers", ["## demographics", "## assessmentSummary", "## agreementStatistics", "## errorStatistics", "## reliabilityStatistics", "## modelPerformance", "## captureQualitySummary"].every((h) => csvText.includes(h)));

    const xlsxRes = await fetch(`${BASE}/api/validation/reports/${reportId}/xlsx`);
    const xlsxBuffer = Buffer.from(await xlsxRes.arrayBuffer());
    assertTrue("reports/:id/xlsx: real spreadsheet MIME type", xlsxRes.headers.get("content-type")?.includes("spreadsheetml"));
    assertTrue("reports/:id/xlsx: non-empty binary payload with the .xlsx (ZIP) magic bytes 'PK'", xlsxBuffer.length > 1000 && xlsxBuffer[0] === 0x50 && xlsxBuffer[1] === 0x4b);

    // Round-trip check via exceljs (installed under backend/node_modules), same pattern verify-dashboard-api.mjs already established.
    const xlsxTmpPath = path.join(DATA_DIR, "validation-export-roundtrip.xlsx");
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
      "reports/:id/xlsx: exceljs genuinely re-reads all 7 sheets with real row counts",
      Object.keys(sheetSummary).length === 7 && Object.values(sheetSummary).every((n) => n > 1),
      JSON.stringify(sheetSummary) + (roundTrip.stderr ? " stderr: " + roundTrip.stderr.slice(0, 200) : "")
    );

    // ---- 404 handling for a nonexistent report id, all 3 formats ----
    const missingPdf = await fetch(`${BASE}/api/validation/reports/999999/pdf`);
    const missingCsv = await fetch(`${BASE}/api/validation/reports/999999/csv`);
    const missingXlsx = await fetch(`${BASE}/api/validation/reports/999999/xlsx`);
    assertTrue("reports/:id/pdf: 404 for a nonexistent report", missingPdf.status === 404);
    assertTrue("reports/:id/csv: 404 for a nonexistent report", missingCsv.status === 404);
    assertTrue("reports/:id/xlsx: 404 for a nonexistent report", missingXlsx.status === 404);

    // ---- Regression: existing quality-control and dataset endpoints still work unchanged ----
    const qc = await json("GET", "/api/validation/quality-control");
    assertTrue("regression: quality-control endpoint still works and now includes exclusionRecommendations", qc.status === 200 && "exclusionRecommendations" in qc.data);

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
