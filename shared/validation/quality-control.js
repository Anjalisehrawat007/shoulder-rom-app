/**
 * quality-control.js — Part 11: Quality Control
 * ----------------------------------------------------------------------------
 * Detects data-quality issues across stored sessions and clinician
 * assessments. Every issue is a structured {severity, sessionId, field,
 * message} entry -- never a silent drop or a single pass/fail flag.
 * ----------------------------------------------------------------------------
 */

// Physiologically plausible ranges -- generous bounds (not tight clinical
// norms, which belong in reference-datasets.js) meant to catch obvious data
// errors (sensor glitches, unit mistakes, mis-keyed entries), not to
// second-guess genuine clinical extremes.
const ANGLE_RANGES = {
  shoulderAbductionDeg: [0, 180],
  shoulderFlexionDeg: [0, 180],
  externalRotationDeg: [0, 110],
  internalRotationDeg: [0, 110],
};

function checkImpossibleAngles(sessions) {
  const issues = [];
  for (const s of sessions) {
    for (const [taskId, task] of Object.entries(s.taskResults || {})) {
      for (const [key, range] of Object.entries(ANGLE_RANGES)) {
        const v = task.parameters?.[key]?.value;
        if (v != null && (v < range[0] || v > range[1])) {
          issues.push({ severity: "error", sessionId: s.sessionId, field: key, message: `${key}=${v} in task "${taskId}" is outside the physiologically plausible range [${range[0]}, ${range[1]}].` });
        }
      }
    }
  }
  return issues;
}

function checkIncompleteSessions(sessions, expectedTaskCount = 4) {
  return sessions
    .filter((s) => Object.keys(s.taskResults || {}).length < expectedTaskCount)
    .map((s) => ({ severity: "warning", sessionId: s.sessionId, field: "taskResults", message: `Only ${Object.keys(s.taskResults || {}).length}/${expectedTaskCount} tasks captured.` }));
}

function checkInvalidDates(assessments, sessionsById) {
  const issues = [];
  const now = new Date();
  for (const a of assessments) {
    const assessDate = new Date(a.assessmentDate);
    if (assessDate > now) {
      issues.push({ severity: "error", sessionId: a.sessionId, field: "assessmentDate", message: `Assessment date ${a.assessmentDate} is in the future.` });
    }
    const session = sessionsById[a.sessionId];
    if (session && assessDate < new Date(session.createdAt)) {
      issues.push({ severity: "warning", sessionId: a.sessionId, field: "assessmentDate", message: `Assessment date ${a.assessmentDate} predates the capture session (${session.createdAt}) -- verify this is linked to the right session.` });
    }
  }
  return issues;
}

function checkDuplicatePatients(assessments) {
  const byHospitalId = {};
  for (const a of assessments) {
    if (!byHospitalId[a.hospitalId]) byHospitalId[a.hospitalId] = [];
    byHospitalId[a.hospitalId].push(a);
  }
  const issues = [];
  for (const [hospitalId, list] of Object.entries(byHospitalId)) {
    if (list.length < 2) continue;
    const sexes = new Set(list.map((a) => a.sex).filter(Boolean));
    if (sexes.size > 1) {
      issues.push({ severity: "error", sessionId: null, field: "sex", message: `Hospital ID ${hospitalId} has conflicting sex values across assessments (${[...sexes].join(", ")}) -- data entry error or ID collision?` });
    }
    const ages = [...new Set(list.map((a) => a.age).filter((v) => v != null))];
    if (ages.length > 1 && Math.max(...ages) - Math.min(...ages) > 2) {
      issues.push({ severity: "warning", sessionId: null, field: "age", message: `Hospital ID ${hospitalId} has age values spanning >2 years across assessments (${ages.join(", ")}) -- verify these are the same patient.` });
    }
  }
  return issues;
}

function checkVersionMismatches(sessions) {
  const versions = new Set(sessions.map((s) => `asri:${s.asriVersion}|ref:${s.referenceDatasetVersion}`));
  if (versions.size <= 1) return [];
  return [{ severity: "warning", sessionId: null, field: "asriVersion", message: `This set mixes sessions scored under different ASRI/reference-dataset versions (${[...versions].join("; ")}). Comparing them together may not be methodologically valid -- consider filtering to a single version before drawing conclusions.` }];
}

function checkLowConfidenceData(sessions) {
  const issues = [];
  for (const s of sessions) {
    for (const [taskId, task] of Object.entries(s.taskResults || {})) {
      for (const [key, p] of Object.entries(task.parameters || {})) {
        if (p && p.measurementType === "estimated" && p.confidence === "low") {
          issues.push({ severity: "info", sessionId: s.sessionId, field: key, message: `${key} in task "${taskId}" is an estimated/low-confidence value -- included in analysis but should be weighted/interpreted accordingly.` });
        }
      }
    }
  }
  return issues;
}

/**
 * Statistical outlier detection (IQR method, Tukey 1977) -- distinct from
 * checkImpossibleAngles() above, which only catches values outside a fixed
 * physiological range (sensor glitches, unit errors). This catches values
 * that ARE physiologically plausible but statistically unusual relative to
 * THIS dataset (e.g. a real 170deg abduction reading in a cohort where
 * everyone else reads 60-110deg) -- worth a research analyst's attention,
 * not necessarily a data error. Computed per-parameter across all sessions'
 * values for that parameter (pools across tasks that record the same key).
 * Requires n>=4 per parameter (below that, quartiles are not meaningful) --
 * fewer than that, this check is silently skipped for that parameter rather
 * than producing an unreliable flag.
 */
function checkStatisticalOutliers(sessions) {
  const byParam = {};
  for (const s of sessions) {
    for (const [taskId, task] of Object.entries(s.taskResults || {})) {
      for (const [key, p] of Object.entries(task.parameters || {})) {
        if (p?.value == null || typeof p.value !== "number") continue;
        if (!byParam[key]) byParam[key] = [];
        byParam[key].push({ sessionId: s.sessionId, taskId, value: p.value });
      }
    }
  }
  const issues = [];
  for (const [key, entries] of Object.entries(byParam)) {
    if (entries.length < 4) continue;
    const sorted = [...entries].sort((a, b) => a.value - b.value);
    const q1 = sorted[Math.floor(sorted.length * 0.25)].value;
    const q3 = sorted[Math.floor(sorted.length * 0.75)].value;
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    for (const e of entries) {
      if (e.value < lowerFence || e.value > upperFence) {
        issues.push({
          severity: "warning",
          sessionId: e.sessionId,
          field: key,
          message: `${key}=${e.value} in task "${e.taskId}" is a statistical outlier for this dataset (IQR method: outside [${lowerFence.toFixed(1)}, ${upperFence.toFixed(1)}], Q1=${q1.toFixed(1)}, Q3=${q3.toFixed(1)}, n=${entries.length}). Physiologically plausible but unusual relative to this cohort -- worth reviewing before including in pooled statistics.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Capture-quality (ICQA) integration -- reads camera_quality_json's CQI,
 * which this file never touched before (ICQA and quality-control.js were
 * built in different phases and never wired together). Threshold (55) is a
 * local, documented convenience constant matching the value already used
 * as the ICQA gate's warn threshold in shared/reporting/report-generator.js's
 * buildRecommendations() (`t.cameraQuality?.cqi < 55`) -- kept as a literal
 * here rather than importing from shared/icqa/*, preserving this module's
 * existing independence from the measurement-engine layer (checked by the
 * project's own independence-grep convention).
 */
const CAPTURE_QUALITY_WARN_THRESHOLD = 55;

function checkCaptureQuality(sessions) {
  const issues = [];
  for (const s of sessions) {
    for (const [taskId, task] of Object.entries(s.taskResults || {})) {
      const cqi = task.cameraQuality?.cqi;
      if (cqi != null && cqi < CAPTURE_QUALITY_WARN_THRESHOLD) {
        issues.push({
          severity: "warning",
          sessionId: s.sessionId,
          field: "cameraQuality",
          message: `Task "${taskId}" was captured at CQI=${cqi}, below the ${CAPTURE_QUALITY_WARN_THRESHOLD} quality-gate threshold -- this task's measurements should be weighted down or excluded in pooled statistical analyses.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Resolves the flagged issues into an explicit, actionable per-session
 * exclusion verdict -- previously issues were flagged with a severity but
 * never resolved to a yes/no "should this session be in the analysis"
 * call, leaving that judgment entirely to whoever read the issue list.
 * Rule: any "error"-severity issue for a session -> exclude (data
 * integrity problem, not just a quality concern). "warning"/"info" alone
 * -> keep, but surfaced for manual review. This is a RECOMMENDATION, not
 * an automatic filter -- callers decide whether to act on it.
 * @returns {{[sessionId: string]: {excludeFromAnalysis: boolean, reasons: string[], reviewReasons: string[]}}}
 */
function recommendExclusions(issues) {
  const bySession = {};
  for (const issue of issues) {
    if (!issue.sessionId) continue; // dataset-level issues (e.g. version mismatch) aren't a single session's fault
    if (!bySession[issue.sessionId]) bySession[issue.sessionId] = { excludeFromAnalysis: false, reasons: [], reviewReasons: [] };
    const entry = bySession[issue.sessionId];
    if (issue.severity === "error") {
      entry.excludeFromAnalysis = true;
      entry.reasons.push(issue.message);
    } else {
      entry.reviewReasons.push(issue.message);
    }
  }
  return bySession;
}

/**
 * @param {Array<{sessionId,createdAt,asriVersion,referenceDatasetVersion,taskResults}>} sessions
 * @param {Array<{sessionId,hospitalId,assessmentDate,age,sex}>} assessments
 */
function runQualityControl(sessions, assessments) {
  const sessionsById = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
  const issues = [
    ...checkImpossibleAngles(sessions),
    ...checkIncompleteSessions(sessions),
    ...checkInvalidDates(assessments, sessionsById),
    ...checkDuplicatePatients(assessments),
    ...checkVersionMismatches(sessions),
    ...checkLowConfidenceData(sessions),
    ...checkStatisticalOutliers(sessions),
    ...checkCaptureQuality(sessions),
  ];
  const bySeverity = {
    error: issues.filter((i) => i.severity === "error").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
  return { generatedAt: new Date().toISOString(), totalIssues: issues.length, bySeverity, issues, exclusionRecommendations: recommendExclusions(issues) };
}

export {
  runQualityControl,
  checkImpossibleAngles,
  checkIncompleteSessions,
  checkInvalidDates,
  checkDuplicatePatients,
  checkVersionMismatches,
  checkLowConfidenceData,
  checkStatisticalOutliers,
  checkCaptureQuality,
  recommendExclusions,
};
