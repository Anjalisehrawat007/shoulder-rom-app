/**
 * xlsx-renderer.js — Phase 9: real .xlsx generation via exceljs.
 * ----------------------------------------------------------------------------
 * Lives in backend/, NOT shared/reporting/, for the same reason
 * pdf-renderer.js does (see that file's header): exceljs is a Node-only
 * dependency installed in backend/node_modules, which is outside the module
 * resolution path for a file under shared/reporting/. shared/reporting/
 * research-export-rows.js stays dependency-free and produces the same plain
 * row objects this file, csv-builder.js, and res.json() all consume --
 * this is the only one of the three that needs a real library, because only
 * a genuine binary .xlsx workbook (not a renamed CSV) needs one.
 * ----------------------------------------------------------------------------
 */
const ExcelJS = require("exceljs");

const SHEET_TITLES = {
  measurements: "Measurements",
  clinicianScores: "Clinician Scores",
  agreement: "Agreement",
  overrideHistory: "Overrides",
};

/**
 * @param {{measurements: object[], clinicianScores: object[], agreement: object[], overrideHistory: object[]}} categorizedRows
 * @param {import("express").Response} res
 */
async function renderResearchXlsx(categorizedRows, res) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Shoulder ROM Research Platform";
  workbook.created = new Date();

  for (const [name, rows] of Object.entries(categorizedRows)) {
    const sheet = workbook.addWorksheet(SHEET_TITLES[name] || name);
    if (!rows || rows.length === 0) continue;
    const headers = Object.keys(rows[0]);
    sheet.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));
    for (const row of rows) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true };
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { renderResearchXlsx };
