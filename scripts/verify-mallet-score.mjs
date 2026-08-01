#!/usr/bin/env node
/**
 * verify-mallet-score.mjs — Phase 6 (Modified Mallet Assessment) synthetic
 * ground-truth checks
 * ----------------------------------------------------------------------------
 * Same pattern as every prior phase's verify-*.mjs: pure math/logic against
 * hand-constructed synthetic data, no browser needed. Confirms: known angle
 * inputs produce the expected grade band for all 6 tasks; compensation
 * demotion actually demotes a borderline grade; confidence degrades near a
 * grade-band boundary and drops to 0 for a fully unavailable primary
 * measurement (never a fabricated grade); re-weighting the confidence blend
 * changes the result (externalization proof, same style as Phase 5's #7);
 * the overall-score rollup excludes ungraded tasks rather than scoring them
 * as grade I; AssessmentController's ordering/resume logic; and the report
 * generator producing a complete structured object.
 *
 * Run: node scripts/verify-mallet-score.mjs
 * ----------------------------------------------------------------------------
 */
import { ModifiedMalletScoreEngine, GRADE_NUMERIC } from "../shared/assessment/ModifiedMalletScoreEngine.js";
import { AssessmentController } from "../shared/assessment/AssessmentController.js";
import { TASKS } from "../shared/assessment/TaskDefinitions.js";
import { generateMalletReport } from "../shared/reporting/report-generator.js";
import baseConfig from "../config/mallet-score-config.v1.json" with { type: "json" };

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}

const engine = new ModifiedMalletScoreEngine(baseConfig);

function measured(value, unit = "deg") {
  return { value, unit, measurementType: "measured", confidence: "high" };
}

// ---- 1. Known angle -> expected grade band, all 6 tasks --------------------
{
  const cases = [
    { taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(160), trunkCompensationFlag: false }, expectGrade: "V" },
    { taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(10), trunkCompensationFlag: false }, expectGrade: "II" },
    { taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(0), trunkCompensationFlag: false }, expectGrade: "I" },
    { taskId: "global_external_rotation", malletCategory: "globalExternalRotation", measurements: { externalRotationDeg: measured(45), trunkCompensationFlag: false }, expectGrade: "V" },
    { taskId: "global_external_rotation", malletCategory: "globalExternalRotation", measurements: { externalRotationDeg: measured(-10), trunkCompensationFlag: false }, expectGrade: "II" },
    { taskId: "hand_to_neck", malletCategory: "handToNeck", measurements: { reachSuccess: { value: true, unit: "boolean", measurementType: "estimated", confidence: "low" }, shoulderElevationDeg: measured(70), trunkCompensationFlag: false }, expectGrade: "V" },
    { taskId: "hand_to_neck", malletCategory: "handToNeck", measurements: { reachSuccess: { value: false, unit: "boolean", measurementType: "estimated", confidence: "low" }, shoulderElevationDeg: measured(20) }, expectGrade: "I" },
    { taskId: "hand_to_spine", malletCategory: "handToSpine", measurements: { vertebralLevelProxy: { value: "T7_or_higher", unit: "vertebral_level_bucket", measurementType: "estimated", confidence: "low" } }, expectGrade: "V" },
    { taskId: "hand_to_spine", malletCategory: "handToSpine", measurements: { vertebralLevelProxy: { value: "cannot_reach_back", unit: "vertebral_level_bucket", measurementType: "estimated", confidence: "low" } }, expectGrade: "I" },
    { taskId: "hand_to_mouth", malletCategory: "handToMouth", measurements: { elbowFlexionDeg: measured(50), shoulderFlexionDeg: measured(20), trunkCompensationFlag: false }, expectGrade: "V" },
    { taskId: "hand_to_mouth", malletCategory: "handToMouth", measurements: { shoulderFlexionDeg: measured(110), trunkCompensationFlag: true }, expectGrade: "II" },
    { taskId: "internal_rotation", malletCategory: "internalRotation", measurements: { internalRotationDeg: measured(70), trunkCompensationFlag: false }, expectGrade: "V" },
    { taskId: "internal_rotation", malletCategory: "internalRotation", measurements: { internalRotationDeg: measured(0), trunkCompensationFlag: false }, expectGrade: "I" },
  ];
  for (const c of cases) {
    const r = engine.score(c);
    assertTrue(`${c.taskId}: expected grade ${c.expectGrade}`, r.grade === c.expectGrade, `got ${r.grade}`);
  }
}

// ---- 2. Compensation demotion actually demotes a borderline grade ----------
{
  const withoutComp = engine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(100), trunkCompensationFlag: false } });
  const withComp = engine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(100), trunkCompensationFlag: true } });
  assertTrue("without compensation: grade IV (100deg is in the 90-150 band)", withoutComp.grade === "IV", withoutComp.grade);
  assertTrue("with compensation: demoted to III", withComp.grade === "III", withComp.grade);
  assertTrue("demotion is mentioned in the reasoning text", withComp.reasoning.toLowerCase().includes("demoted"));
}

// ---- 3. Never fabricates: unavailable primary -> insufficient_data --------
{
  const r = engine.score({
    taskId: "hand_to_spine", malletCategory: "handToSpine",
    measurements: { vertebralLevelProxy: { value: null, unit: "vertebral_level_bucket", measurementType: "unavailable", limitation: "test" } },
  });
  assertTrue("unavailable primary measurement -> insufficient_data status", r.status === "insufficient_data");
  assertTrue("unavailable primary measurement -> grade is null, not fabricated", r.grade === null);
  assertTrue("confidence is 0 for insufficient_data", r.confidence === 0);
}

// ---- 4. Confidence degrades near a grade-band boundary ---------------------
{
  const nearBoundary = engine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(91), trunkCompensationFlag: false } });
  const midBand = engine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(120), trunkCompensationFlag: false } });
  assertTrue("value near a grade boundary has lower confidence than mid-band", nearBoundary.confidence < midBand.confidence, `near=${nearBoundary.confidence} mid=${midBand.confidence}`);
}

// ---- 5. Re-weighting the confidence blend changes the result (externalization proof) ----
{
  const measurements = { shoulderAbductionDeg: measured(91), trunkCompensationFlag: false };
  const dmqeResult = { status: "ok", movementConfidencePct: 20, domains: {} };
  const cqiResult = { cqi: 95, overallConfidencePct: 95 };
  const baseResult = engine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements, dmqeResult, cqiResult });

  const altConfig = JSON.parse(JSON.stringify(baseConfig));
  altConfig.version = "1.0.0-test-alt-weights";
  altConfig.confidenceBlend = { measurementConfidence: 0.05, dmqeConfidence: 0.85, cqiConfidence: 0.05, boundaryDistance: 0.05 };
  const altEngine = new ModifiedMalletScoreEngine(altConfig);
  const altResult = altEngine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements, dmqeResult, cqiResult });

  assertTrue("re-weighting the confidence blend changes confidence for identical input (weights are genuinely externalized)", Math.abs(altResult.confidence - baseResult.confidence) > 10, `base=${baseResult.confidence} alt=${altResult.confidence}`);
}

// ---- 6. Overall rollup excludes ungraded tasks, not scored as grade I ------
{
  const graded = engine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(160), trunkCompensationFlag: false } });
  const ungraded = engine.score({ taskId: "hand_to_spine", malletCategory: "handToSpine", measurements: { vertebralLevelProxy: { value: null, unit: "vertebral_level_bucket", measurementType: "unavailable" } } });
  const overall = engine.scoreOverall([graded, ungraded]);
  assertTrue("overall rollup only counts the graded task", overall.tasksGraded === 1 && overall.tasksTotal === 2, JSON.stringify(overall));
  assertTrue("overall average grade equals the single graded task's grade (V=5), not diluted by the ungraded one", overall.averageGrade === 5, overall.averageGrade);
}

// ---- 7. AssessmentController: ordering, completion, resume -----------------
{
  const testTasks = TASKS.slice(0, 3);
  const controller = new AssessmentController(testTasks);
  assertTrue("starts at the first task", controller.currentTask.id === testTasks[0].id);
  controller.markTaskComplete(testTasks[0].id, { summary: "ok" });
  assertTrue("advances to the second task after completing the first", controller.currentTask.id === testTasks[1].id);
  assertTrue("not complete after 1/3 tasks", controller.isComplete === false);
  controller.markTaskComplete(testTasks[1].id, { summary: "ok" });
  controller.markTaskComplete(testTasks[2].id, { summary: "ok" });
  assertTrue("complete after all 3 tasks", controller.isComplete === true);

  // Resume: reconstruct from only the first task being done.
  const resumed = AssessmentController.resumeFrom(testTasks, { [testTasks[0].id]: { summary: "ok" } });
  assertTrue("resume lands on the correct next task", resumed.currentTask.id === testTasks[1].id, resumed.currentTask.id);
  assertTrue("resume correctly tracks progress", resumed.progress.completed === 1 && resumed.progress.total === 3);
}

// ---- 8. Report generator produces a complete structured object ------------
{
  const taskResults = {
    global_abduction: {
      parameters: { shoulderAbductionDeg: measured(140) },
      motionAnalysis: { dmqeScore: 88 },
      cameraQuality: { cqi: 90 },
      malletGrade: engine.score({ taskId: "global_abduction", malletCategory: "globalAbduction", measurements: { shoulderAbductionDeg: measured(140), trunkCompensationFlag: false } }),
    },
  };
  const asriResult = { composite: 82, confidenceInterval: { low: 70, high: 94 }, overallConfidencePct: 88, asriVersion: "2.0.0" };
  const malletOverallResult = engine.scoreOverall(Object.values(taskResults).map((t) => t.malletGrade));
  const taskLabels = { global_abduction: "Global Abduction" };

  const report = generateMalletReport({
    session: { sessionId: "9999999", patientLabel: "Test", side: "right", createdAt: new Date().toISOString() },
    taskResults, asriResult, malletOverallResult, taskLabels,
    validationMetadata: { malletScoreConfigVersion: "1.0.0" },
  });

  assertTrue("report has all required top-level sections", ["generatedAt", "session", "taskRows", "malletOverall", "overallAgreement", "asri", "validationMetadata", "recommendations", "limitations"].every((k) => k in report));
  assertTrue("report includes the task row with its predicted grade", report.taskRows[0].predictedGrade === "IV", report.taskRows[0].predictedGrade);
  assertTrue("report includes ASRI composite", report.asri.composite === 82);
  assertTrue("report limitations list is non-empty (boilerplate + measurement limitations)", report.limitations.length > 0);
  assertTrue("no clinician overrides yet -> overallAgreement reports that honestly, not a fabricated agreement figure", report.overallAgreement.status === "no_overrides_yet");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
