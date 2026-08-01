/**
 * csv-builder.js — Phase 9: plain CSV string building, no library needed.
 * ----------------------------------------------------------------------------
 * Dependency-free by design (same independence rule as the rest of
 * shared/reporting/*). Consumes buildResearchExportRows()'s categorized row
 * object and produces one CSV document with a "## <category>" header line
 * before each section's own column header row, so a research export with
 * heterogeneous row shapes (measurements vs. clinician scores vs. override
 * history) stays a single downloadable file without forcing all categories
 * into one column set.
 * ----------------------------------------------------------------------------
 */

function escapeCsvValue(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => escapeCsvValue(row[h])).join(","));
  return lines.join("\n");
}

/** @param {{measurements: object[], clinicianScores: object[], agreement: object[], overrideHistory: object[]}} categorizedRows */
function buildResearchCsv(categorizedRows) {
  const sections = [];
  for (const [name, rows] of Object.entries(categorizedRows)) {
    if (!rows || rows.length === 0) continue;
    sections.push(`## ${name}`);
    sections.push(rowsToCsv(rows));
  }
  return sections.join("\n\n");
}

export { rowsToCsv, buildResearchCsv, escapeCsvValue };
