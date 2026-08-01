/**
 * research-report-generator.js — Phase 9: the fuller "research report"
 * ----------------------------------------------------------------------------
 * A NEW file, not an extension of report-generator.js's generateMalletReport()
 * -- that function's taskRows shape is already in production use by
 * doctor-portal's live PDF/JSON report links; growing its contract to also
 * carry clinician-panel fields, generalized overrides, and audit summaries
 * would risk regressing a report clinicians already rely on. This module
 * CALLS generateMalletReport() internally to reuse its Mallet/ASRI section
 * rather than re-deriving it, then layers on the additional Phase 9
 * sections. Same "structured object first, renderer(s) second" pattern
 * report-generator.js already established -- backend/pdf-renderer.js's
 * renderResearchReportPdf() is the second renderer for this same object.
 * ----------------------------------------------------------------------------
 */
import { generateMalletReport } from "./report-generator.js";

/**
 * @param {object} args - everything generateMalletReport() needs, PLUS:
 * @param {object|null} [args.clinicianAssessment] - rowToAssessment()-shaped, most recent
 * @param {Array<object>} [args.malletOverrides] - raw mallet_grade_overrides rows (session's full history)
 * @param {Array<object>} [args.parameterOverrides] - raw parameter_overrides rows (session's full history)
 * @param {Array<object>} [args.comparisonRows] - the dashboard comparison endpoint's derived rows
 * @param {Array<object>} [args.auditEntries] - this session's audit_log entries
 * @param {object} [args.studyMemberships] - [{id, name, type, status, assignedReviewer}] datasets this session belongs to
 */
function generateResearchReport({
  session,
  taskResults,
  asriResult = null,
  malletOverallResult = null,
  gradeOverrides = {},
  taskLabels = {},
  validationMetadata = {},
  clinicianAssessment = null,
  malletOverrides = [],
  parameterOverrides = [],
  comparisonRows = [],
  auditEntries = [],
  studyMemberships = [],
}) {
  const malletReport = generateMalletReport({ session, taskResults, asriResult, malletOverallResult, gradeOverrides, taskLabels, validationMetadata });

  const overrideHistory = [
    ...malletOverrides.map((o) => ({
      kind: "malletGrade",
      taskId: o.task_id,
      field: "malletGrade",
      originalValue: o.predicted_grade,
      overriddenValue: o.clinician_grade,
      reason: o.override_reason,
      reviewer: o.clinician_name,
      version: o.version,
      createdAt: o.created_at,
    })),
    ...parameterOverrides.map((o) => {
      const original = o.original_value_json ? JSON.parse(o.original_value_json) : null;
      return {
        kind: "parameter",
        taskId: o.task_id,
        field: o.field_key,
        originalValue: original && typeof original === "object" && "value" in original ? original.value : original,
        overriddenValue: o.overridden_value_json ? JSON.parse(o.overridden_value_json) : null,
        reason: o.override_reason,
        reviewer: o.reviewer_name,
        version: o.version,
        createdAt: o.created_at,
      };
    }),
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const disagreements = comparisonRows.filter((r) => r.agreementStatus === "disagree");

  return {
    ...malletReport,
    reportType: "research",
    clinicianAssessmentPanel: clinicianAssessment,
    overrideHistory,
    comparison: {
      rows: comparisonRows,
      disagreementCount: disagreements.length,
      disagreements,
    },
    auditSummary: {
      totalEntries: auditEntries.length,
      byEntityType: auditEntries.reduce((acc, e) => {
        acc[e.entityType] = (acc[e.entityType] || 0) + 1;
        return acc;
      }, {}),
      entries: auditEntries,
    },
    researchMetadata: {
      studyMemberships,
      protocol: session.protocol ?? null,
      exportedAt: new Date().toISOString(),
    },
  };
}

export { generateResearchReport };
