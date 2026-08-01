/**
 * research-export-rows.js — Phase 9: shared row-shaping for bulk research
 * export (CSV/JSON/XLSX).
 * ----------------------------------------------------------------------------
 * Pure, dependency-free (no import from shared/biomechanics|asri|... -- the
 * same independence rule report-generator.js already holds). ONE function
 * decides what "a row" is; backend/server.js's three export endpoints
 * (json/csv/xlsx) all call this and then just format the same rows
 * differently, so the three formats can never disagree about content.
 *
 * Input is an array of "session bundles" -- plain objects the caller
 * assembles from already-computed data (buildMalletReport()'s output plus
 * the override/clinician-assessment rows), not raw DB rows. This file has
 * zero database or HTTP awareness.
 * ----------------------------------------------------------------------------
 */

function safeParse(json) {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {Array<object>} args.sessionBundles - [{
 *   session: {sessionId, patientLabel, side, createdAt},
 *   taskRows: [...] (report.taskRows shape from generateMalletReport),
 *   malletOverall, asri,
 *   clinicianAssessment: object|null,
 *   malletOverrides: [raw mallet_grade_overrides rows],
 *   parameterOverrides: [raw parameter_overrides rows],
 * }]
 * @returns {{measurements: object[], clinicianScores: object[], agreement: object[], overrideHistory: object[]}}
 */
function buildResearchExportRows({ sessionBundles = [] }) {
  const measurements = [];
  const clinicianScores = [];
  const agreement = [];
  const overrideHistory = [];

  for (const bundle of sessionBundles) {
    const { session, taskRows = [], malletOverall, asri, clinicianAssessment, malletOverrides = [], parameterOverrides = [] } = bundle;
    const base = { sessionId: session.sessionId, patientLabel: session.patientLabel, side: session.side, createdAt: session.createdAt };

    for (const t of taskRows) {
      const allMeasurements = { ...(t.measurements || {}), ...(t.malletMeasurements || {}) };
      for (const [fieldKey, envelope] of Object.entries(allMeasurements)) {
        if (!envelope || typeof envelope !== "object" || !("value" in envelope)) continue;
        measurements.push({
          ...base,
          taskId: t.taskId,
          taskLabel: t.label,
          field: fieldKey,
          value: envelope.value,
          unit: envelope.unit ?? null,
          measurementType: envelope.measurementType ?? null,
          confidence: envelope.confidence ?? null,
        });
      }

      agreement.push({
        ...base,
        taskId: t.taskId,
        taskLabel: t.label,
        field: "malletGrade",
        aiValue: t.predictedGrade ?? null,
        aiConfidencePct: t.predictedConfidence ?? null,
        clinicianValue: t.clinicianGrade ?? null,
        agree: t.agreement?.agree ?? null,
        differenceGrades: t.agreement?.differenceGrades ?? null,
      });
    }

    clinicianScores.push({
      ...base,
      malletAverageGrade: malletOverall?.averageGradeRoman ?? null,
      malletTotalScore: malletOverall?.totalScore ?? null,
      malletAssessmentConfidencePct: malletOverall?.assessmentConfidencePct ?? null,
      asriComposite: asri?.composite ?? null,
      asriConfidencePct: asri?.overallConfidencePct ?? null,
      clinicianOverallAssessment: clinicianAssessment?.overallAssessment ?? null,
      clinicianConfidencePct: clinicianAssessment?.clinicianConfidencePct ?? null,
      clinicianRecommendation: clinicianAssessment?.clinicianRecommendation ?? null,
      compensationSeverity: clinicianAssessment?.compensationSeverity ?? null,
      clinicianRom: clinicianAssessment?.rom ?? null,
      clinicianExternalRotation: clinicianAssessment?.externalRotation ?? null,
      clinicianInternalRotation: clinicianAssessment?.internalRotation ?? null,
      notes: clinicianAssessment?.notes ?? null,
    });

    for (const o of malletOverrides) {
      overrideHistory.push({
        ...base,
        taskId: o.task_id,
        field: "malletGrade",
        originalValue: o.predicted_grade,
        overriddenValue: o.clinician_grade,
        reason: o.override_reason,
        reviewer: o.clinician_name,
        version: o.version,
        overriddenAt: o.created_at,
      });
    }
    for (const o of parameterOverrides) {
      const original = safeParse(o.original_value_json);
      overrideHistory.push({
        ...base,
        taskId: o.task_id,
        field: o.field_key,
        originalValue: original && typeof original === "object" && "value" in original ? original.value : original,
        overriddenValue: safeParse(o.overridden_value_json),
        reason: o.override_reason,
        reviewer: o.reviewer_name,
        version: o.version,
        overriddenAt: o.created_at,
      });
    }
  }

  return { measurements, clinicianScores, agreement, overrideHistory };
}

export { buildResearchExportRows };
