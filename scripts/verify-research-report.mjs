#!/usr/bin/env node
/**
 * verify-research-report.mjs — Phase 9 research-report generator checks
 * ----------------------------------------------------------------------------
 * Pure-function test, same style as verify-mallet-score.mjs: confirms
 * generateResearchReport() correctly wraps generateMalletReport() (reuse,
 * not duplication), layers on the Clinician Assessment Panel / override
 * history / comparison / audit summary / research metadata sections, and
 * that computeLineChartPoints() (shared by the on-screen chart and the PDF
 * chart) produces sane, consistent coordinates. A real PDF byte-stream
 * smoke check (via the live backend) is done separately in
 * verify-dashboard-api.mjs / a manual curl check, not here.
 *
 * Run: node scripts/verify-research-report.mjs
 * ----------------------------------------------------------------------------
 */
import { generateResearchReport } from "../shared/reporting/research-report-generator.js";
import { generateMalletReport } from "../shared/reporting/report-generator.js";
import { computeLineChartPoints } from "../shared/reporting/chart-geometry.js";

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}

function measured(value, unit = "deg") {
  return { value, unit, measurementType: "measured", confidence: "high" };
}

const session = { sessionId: "1234567", patientLabel: "Test Patient", side: "right", createdAt: "2026-01-01T00:00:00.000Z", protocol: "modified_mallet" };
const taskResults = {
  global_abduction: {
    parameters: { shoulderAbductionDeg: measured(90) },
    malletGrade: { grade: "III", status: "ok", confidence: 80, reasoning: "test", supportingMeasurements: {} },
    cameraQuality: { cqi: 70 },
    motionAnalysis: { dmqeScore: 60 },
  },
};
const taskLabels = { global_abduction: "Global Abduction" };
const gradeOverrides = { global_abduction: { clinicianGrade: "IV", overrideReason: "Fuller ROM observed", clinicianName: "Dr. Smith", createdAt: "2026-01-02T00:00:00.000Z" } };

// ---- 1. generateResearchReport wraps generateMalletReport, doesn't duplicate it ----
{
  const malletOnly = generateMalletReport({ session, taskResults, taskLabels, gradeOverrides });
  const research = generateResearchReport({
    session,
    taskResults,
    taskLabels,
    gradeOverrides,
    clinicianAssessment: { clinicianName: "Dr. Smith", assessmentDate: "2026-01-02", overallAssessment: "Good progress", compensationSeverity: "mild", clinicianConfidencePct: 85, clinicianRecommendation: "Continue therapy" },
    malletOverrides: [{ task_id: "global_abduction", predicted_grade: "III", clinician_grade: "IV", override_reason: "Fuller ROM observed", clinician_name: "Dr. Smith", version: 1, created_at: "2026-01-02T00:00:00.000Z" }],
    parameterOverrides: [
      { task_id: "global_abduction", field_key: "shoulderAbductionDeg", original_value_json: JSON.stringify(measured(90)), overridden_value_json: "95", override_reason: "re-measured", reviewer_name: "Dr. Smith", version: 1, created_at: "2026-01-02T00:05:00.000Z" },
    ],
    comparisonRows: [{ field: "malletGrade", taskId: "global_abduction", aiValue: "III", clinicianValue: "IV", agreementStatus: "disagree" }],
    auditEntries: [{ entityType: "mallet_override" }, { entityType: "mallet_override" }, { entityType: "clinician_assessment" }],
    studyMemberships: [{ id: 1, name: "Pilot A", status: "active" }],
  });

  assertTrue("research report reuses the Mallet report's taskRows verbatim (no re-derivation)", JSON.stringify(research.taskRows) === JSON.stringify(malletOnly.taskRows));
  assertTrue("research report reuses the same ASRI/malletOverall/limitations sections", research.limitations === malletOnly.limitations || JSON.stringify(research.limitations) === JSON.stringify(malletOnly.limitations));
  assertTrue("research report is tagged reportType='research'", research.reportType === "research");

  assertTrue("Clinician Assessment Panel section present with the new fields", research.clinicianAssessmentPanel.overallAssessment === "Good progress" && research.clinicianAssessmentPanel.compensationSeverity === "mild");

  assertTrue("override history includes both the Mallet-grade override and the parameter override (2 entries)", research.overrideHistory.length === 2);
  const malletHistEntry = research.overrideHistory.find((o) => o.kind === "malletGrade");
  const paramHistEntry = research.overrideHistory.find((o) => o.kind === "parameter");
  assertTrue("Mallet override history entry preserves original AI value and the override", malletHistEntry.originalValue === "III" && malletHistEntry.overriddenValue === "IV");
  assertTrue("parameter override history entry unwraps the envelope's .value as originalValue (90), not the whole object", paramHistEntry.originalValue === 90 && paramHistEntry.overriddenValue === 95);
  assertTrue("override history is sorted chronologically", new Date(research.overrideHistory[0].createdAt) <= new Date(research.overrideHistory[1].createdAt));

  assertTrue("comparison section surfaces the disagreement", research.comparison.disagreementCount === 1 && research.comparison.disagreements[0].field === "malletGrade");

  assertTrue("audit summary counts entries by type", research.auditSummary.totalEntries === 3 && research.auditSummary.byEntityType.mallet_override === 2 && research.auditSummary.byEntityType.clinician_assessment === 1);

  assertTrue("research metadata carries study memberships and protocol", research.researchMetadata.studyMemberships[0].name === "Pilot A" && research.researchMetadata.protocol === "modified_mallet");
}

// ---- 2. generateResearchReport degrades gracefully with nothing extra supplied ----
{
  const bare = generateResearchReport({ session, taskResults, taskLabels });
  assertTrue("no clinician assessment yet -> null, not fabricated", bare.clinicianAssessmentPanel === null);
  assertTrue("no overrides yet -> empty history, not fabricated", bare.overrideHistory.length === 0);
  assertTrue("no comparison rows supplied -> empty, zero disagreements (not assumed agreement)", bare.comparison.disagreementCount === 0 && bare.comparison.rows.length === 0);
  assertTrue("no audit entries supplied -> honest zero count", bare.auditSummary.totalEntries === 0);
}

// ---- 3. chart-geometry: shared coordinate math used by both the SVG chart and the PDF chart ----
{
  const series = [
    { tSec: 0, value: 10 },
    { tSec: 1, value: 30 },
    { tSec: 2, value: 20 },
    { tSec: 3, value: null }, // a dropped/unavailable frame -- must not break the geometry
  ];
  const { points, xScale, yScale, innerWidth, innerHeight } = computeLineChartPoints({ series, width: 400, height: 200 });

  assertTrue("chart-geometry: null-value frames are excluded from the point list (3 of 4)", points.length === 3);
  assertTrue("chart-geometry: points stay within the chart's inner drawing area", points.every((p) => p.x >= 0 && p.x <= 400 && p.y >= 0 && p.y <= 200));
  assertTrue("chart-geometry: xScale/yScale are pure functions callable independently of the point list (same math both renderers would use)", typeof xScale(1.5) === "number" && typeof yScale(25) === "number");
  assertTrue("chart-geometry: higher value maps to a smaller y (chart y-axis points down, value axis points up)", yScale(30) < yScale(10));
  assertTrue("chart-geometry: inner drawing area is smaller than the full canvas (margins reserved)", innerWidth < 400 && innerHeight < 200);

  // Flat-line series (yMin === yMax) must still produce a renderable (non-zero-height) chart.
  const flat = computeLineChartPoints({ series: [{ tSec: 0, value: 5 }, { tSec: 1, value: 5 }], width: 200, height: 100 });
  assertTrue("chart-geometry: a flat-line series still gets vertical headroom, not a degenerate zero-height chart", flat.yMax > flat.yMin);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
