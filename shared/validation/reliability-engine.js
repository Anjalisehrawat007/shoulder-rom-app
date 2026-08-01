/**
 * reliability-engine.js — Part 6: Reliability Analysis
 * ----------------------------------------------------------------------------
 * Automatically organizes repeated assessments into test-retest, inter-
 * rater, and intra-rater groups and computes the appropriate ICC form for
 * each (see statistics.js header / docs/validation.md for why each form is
 * used where). A dataset with no repeats yet reports "0 groups found"
 * honestly rather than fabricating a number.
 * ----------------------------------------------------------------------------
 */
import { computeICC, iccInterpretation } from "./statistics.js";

const CLINICIAN_FIELDS = ["shoulderAbduction", "shoulderFlexion", "externalRotation", "internalRotation"];
const APP_PARAMETER_KEYS = ["shoulderAbductionDeg", "shoulderFlexionDeg", "externalRotationDeg", "internalRotationDeg"];

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const k = keyFn(item);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

/**
 * Test-retest: same patient (hospitalId), multiple APP sessions within
 * `windowDays`, compared via ICC(1,1) per parameter -- one-way random
 * because there's no fixed second "rater" here, it's the same method
 * (this app) at two time points.
 * @param {Array<{sessionId,hospitalId,createdAt,parameters}>} sessions
 */
function testRetestReliability(sessions, { windowDays = 30 } = {}) {
  const groups = groupBy(sessions, (s) => s.hospitalId);
  const pairsPerParam = Object.fromEntries(APP_PARAMETER_KEYS.map((k) => [k, []]));
  const pairsFound = [];

  for (const [hospitalId, group] of Object.entries(groups)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (let i = 1; i < sorted.length; i++) {
      const daysBetween = (new Date(sorted[i].createdAt) - new Date(sorted[i - 1].createdAt)) / 86400000;
      if (daysBetween > windowDays) continue;
      pairsFound.push({ hospitalId, sessionA: sorted[i - 1].sessionId, sessionB: sorted[i].sessionId, daysBetween: Math.round(daysBetween * 10) / 10 });
      for (const key of APP_PARAMETER_KEYS) {
        const a = sorted[i - 1].parameters?.[key]?.value;
        const b = sorted[i].parameters?.[key]?.value;
        if (a != null && b != null) pairsPerParam[key].push([a, b]);
      }
    }
  }

  const perParameter = {};
  for (const key of APP_PARAMETER_KEYS) {
    const matrix = pairsPerParam[key];
    const icc = matrix.length >= 2 ? computeICC(matrix, "1,1") : null;
    perParameter[key] = { n: matrix.length, icc1_1: icc ? { ...icc, interpretation: iccInterpretation(icc.value) } : null };
  }

  return { type: "test-retest", windowDays, groupsFound: pairsFound.length, pairsFound, perParameter };
}

/**
 * Inter-rater: sessions with clinician assessments from 2+ distinct
 * clinicians, compared via ICC(2,1) per parameter -- two-way random,
 * absolute agreement, since different human raters are assessing the same
 * child and a systematic offset between them matters. SIMPLIFICATION: only
 * the first assessment from each of the first two distinct clinicians per
 * session is used, so the comparison matrix stays a clean 2-rater matrix;
 * documented here rather than silently dropping extra raters.
 * @param {object} assessmentsBySession - {sessionId: [{clinicianName, shoulderAbduction, ...}, ...]}
 */
function interRaterReliability(assessmentsBySession) {
  const perParameter = Object.fromEntries(CLINICIAN_FIELDS.map((f) => [f, []]));
  let sessionsUsed = 0;

  for (const list of Object.values(assessmentsBySession)) {
    const byClinicianName = groupBy(list, (a) => a.clinicianName);
    const distinctClinicians = Object.keys(byClinicianName);
    if (distinctClinicians.length < 2) continue;
    sessionsUsed++;
    const [nameA, nameB] = distinctClinicians;
    const assessmentA = byClinicianName[nameA][0];
    const assessmentB = byClinicianName[nameB][0];
    for (const field of CLINICIAN_FIELDS) {
      const a = assessmentA[field];
      const b = assessmentB[field];
      if (a != null && b != null) perParameter[field].push([a, b]);
    }
  }

  const results = {};
  for (const field of CLINICIAN_FIELDS) {
    const matrix = perParameter[field];
    const icc = matrix.length >= 2 ? computeICC(matrix, "2,1") : null;
    results[field] = { n: matrix.length, icc2_1: icc ? { ...icc, interpretation: iccInterpretation(icc.value) } : null };
  }

  return { type: "inter-rater", sessionsWithMultipleRaters: sessionsUsed, perParameter: results };
}

/**
 * Intra-rater: same clinician, same patient, multiple assessment dates,
 * ICC(1,1) per parameter -- same reasoning as test-retest (one rater,
 * repeated over time, no second rater to model).
 * @param {Array<{clinicianName,hospitalId,assessmentDate,...}>} assessments
 */
function intraRaterReliability(assessments, { windowDays = 90 } = {}) {
  const groups = groupBy(assessments, (a) => `${a.clinicianName}::${a.hospitalId}`);
  const perParameter = Object.fromEntries(CLINICIAN_FIELDS.map((f) => [f, []]));
  const pairsFound = [];

  for (const [key, group] of Object.entries(groups)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => new Date(a.assessmentDate) - new Date(b.assessmentDate));
    for (let i = 1; i < sorted.length; i++) {
      const daysBetween = (new Date(sorted[i].assessmentDate) - new Date(sorted[i - 1].assessmentDate)) / 86400000;
      if (daysBetween > windowDays) continue;
      pairsFound.push({ key, daysBetween: Math.round(daysBetween * 10) / 10 });
      for (const field of CLINICIAN_FIELDS) {
        const a = sorted[i - 1][field];
        const b = sorted[i][field];
        if (a != null && b != null) perParameter[field].push([a, b]);
      }
    }
  }

  const results = {};
  for (const field of CLINICIAN_FIELDS) {
    const matrix = perParameter[field];
    const icc = matrix.length >= 2 ? computeICC(matrix, "1,1") : null;
    results[field] = { n: matrix.length, icc1_1: icc ? { ...icc, interpretation: iccInterpretation(icc.value) } : null };
  }

  return { type: "intra-rater", windowDays, groupsFound: pairsFound.length, pairsFound, perParameter: results };
}

export { testRetestReliability, interRaterReliability, intraRaterReliability, CLINICIAN_FIELDS, APP_PARAMETER_KEYS };
