#!/usr/bin/env node
/**
 * verify-validation.mjs — Part 10 (testing) for the Clinical Validation Engine
 * ----------------------------------------------------------------------------
 * Synthetic ground-truth checks against shared/validation/*, same pattern as
 * verify-biomechanics.mjs / verify-asri.mjs / verify-motion.mjs: pure math,
 * no browser/backend needed.
 *
 * Confirms: known-correlation data produces the expected Pearson r; a
 * two-rater scenario with only random noise gives high ICC(2,1) AND
 * ICC(3,1); the same scenario with a constant rater offset added drops
 * ICC(2,1) while ICC(3,1) stays high (the documented absolute-vs-
 * consistency distinction actually behaves as claimed, not just asserted
 * in a comment); hand-computable MAE/RMSE/Bland-Altman; QC catching
 * injected bad data; the report generator producing an honest
 * "preliminary" result for tiny n rather than a fabricated verdict.
 *
 * NOT clinical validation -- this validates the STATISTICS ENGINE's own
 * correctness against synthetic ground truth, not any claim about real
 * app-vs-clinician agreement (there is no real data yet -- see
 * docs/validation.md §8).
 * Run: node scripts/verify-validation.mjs
 * ----------------------------------------------------------------------------
 */
import { pearsonR, spearmanRho, computeICC, mae, rmse, bias, sd, fisherZCI, bootstrapICC, sampleSizeAdequacy } from "../shared/validation/statistics.js";
import { blandAltmanAnalysis } from "../shared/validation/bland-altman.js";
import { runQualityControl, checkStatisticalOutliers, checkCaptureQuality, recommendExclusions } from "../shared/validation/quality-control.js";
import { generateValidationReport } from "../shared/validation/report-generator.js";
import { runComparison } from "../shared/validation/comparison-engine.js";
import { generateCalibrationReport } from "../shared/validation/calibration-advisor.js";
import { buildConfusionMatrix, percentAgreement, weightedKappa } from "../shared/validation/mallet-agreement.js";
import { betweenSessionRepeatability, withinSessionRepeatability } from "../shared/validation/repeatability-engine.js";
import { testRetestReliability, interRaterReliability, intraRaterReliability } from "../shared/validation/reliability-engine.js";
import { runValidation } from "../shared/validation/validation-engine.js";
import { computeLineChartPoints, computeScatterPoints, computeHistogramBins } from "../shared/reporting/chart-geometry.js";

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}
function assertClose(label, actual, expected, tolerance) {
  const ok = actual != null && Math.abs(actual - expected) <= tolerance;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
  if (!ok) failures++;
}

// Deterministic pseudo-random noise generator (no external dependency, and
// reproducible across runs -- a real Math.random() would make this script
// flaky).
function seededNoise(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return (s / 233280 - 0.5) * 2; // roughly [-1, 1]
  };
}

console.log("--- Pearson r on known-correlation data (y = 2x + small noise) ---");
{
  const noise = seededNoise(42);
  const x = Array.from({ length: 30 }, (_, i) => i + 1);
  const y = x.map((v) => 2 * v + noise() * 1.5);
  const r = pearsonR(x, y);
  assertTrue("Pearson r is very high for near-linear data", r > 0.97, `r=${r?.toFixed(3)}`);
}

console.log("\n--- Spearman rho on monotonic-but-nonlinear data ---");
{
  const x = Array.from({ length: 20 }, (_, i) => i + 1);
  const y = x.map((v) => v ** 3); // strictly monotonic, nonlinear
  const rho = spearmanRho(x, y);
  assertClose("Spearman rho is ~1.0 for a strictly monotonic relationship", rho, 1.0, 0.01);
}

console.log("\n--- ICC: two raters, random noise only (no systematic offset) ---");
{
  const noise = seededNoise(7);
  const n = 20;
  const subjects = Array.from({ length: n }, (_, i) => 50 + i * 3);
  const matrix = subjects.map((s) => [s + noise() * 2, s + noise() * 2]); // both raters see the same subject +/- small noise
  const icc2 = computeICC(matrix, "2,1");
  const icc3 = computeICC(matrix, "3,1");
  assertTrue("ICC(2,1) is high with no systematic rater offset", icc2.value > 0.9, `icc2=${icc2.value?.toFixed(3)}`);
  assertTrue("ICC(3,1) is high with no systematic rater offset", icc3.value > 0.9, `icc3=${icc3.value?.toFixed(3)}`);
  assertTrue("ICC(2,1) and ICC(3,1) are close together when there's no bias", Math.abs(icc2.value - icc3.value) < 0.1, `diff=${Math.abs(icc2.value - icc3.value).toFixed(3)}`);
}

console.log("\n--- ICC: same scenario + constant rater offset (systematic bias) ---");
{
  const noise = seededNoise(7); // same seed -> same underlying subject noise pattern
  const n = 20;
  const subjects = Array.from({ length: n }, (_, i) => 50 + i * 3);
  const RATER_OFFSET = 15; // rater B systematically reads 15 higher
  const matrix = subjects.map((s) => [s + noise() * 2, s + RATER_OFFSET + noise() * 2]);
  const icc2 = computeICC(matrix, "2,1");
  const icc3 = computeICC(matrix, "3,1");
  assertTrue("ICC(2,1) drops substantially with a systematic rater offset (absolute agreement penalized)", icc2.value < 0.85, `icc2=${icc2.value?.toFixed(3)}`);
  assertTrue("ICC(3,1) stays high despite the offset (consistency unaffected by a constant shift)", icc3.value > 0.85, `icc3=${icc3.value?.toFixed(3)}`);
  assertTrue("ICC(3,1) - ICC(2,1) gap is now large -- the documented diagnostic actually fires", icc3.value - icc2.value > 0.2, `gap=${(icc3.value - icc2.value).toFixed(3)}`);
}

console.log("\n--- MAE / RMSE / bias / SD on hand-computable data ---");
{
  const diffs = [1, -2, 3, -4];
  assertClose("MAE", mae(diffs), 2.5, 0.001);
  assertClose("RMSE", rmse(diffs), Math.sqrt(7.5), 0.001);
  assertClose("bias (mean)", bias(diffs), -0.5, 0.001);
  assertTrue("SD is computable and positive", sd(diffs) > 0);
}

console.log("\n--- Bland-Altman on hand-computable data ---");
{
  const app = [10, 12, 14, 16, 18];
  const clinician = [11, 12, 15, 15, 20];
  const ba = blandAltmanAnalysis(app, clinician);
  const expectedDiffs = [-1, 0, -1, 1, -2];
  const expectedBias = expectedDiffs.reduce((a, b) => a + b, 0) / 5;
  assertClose("Bland-Altman bias matches hand calculation", ba.bias, expectedBias, 0.001);
  assertTrue("upperLoA > bias > lowerLoA", ba.upperLoA > ba.bias && ba.bias > ba.lowerLoA);
  assertTrue("5 points returned", ba.points.length === 5);
}

console.log("\n--- Quality control catches injected bad data ---");
{
  const sessions = [
    { sessionId: "S1", createdAt: "2026-01-01T00:00:00Z", asriVersion: "2.0.0", referenceDatasetVersion: "1.0.0", taskResults: { t1: { parameters: { shoulderAbductionDeg: { value: 999, measurementType: "measured", confidence: "high" } } } } }, // impossible angle
  ];
  const assessments = [
    { sessionId: "S1", hospitalId: "P1", assessmentDate: "2099-01-01", age: 20, sex: "F" }, // future date
    { sessionId: "S1", hospitalId: "P1", assessmentDate: "2026-01-02", age: 20, sex: "M" }, // conflicting sex, same hospitalId
  ];
  const qc = runQualityControl(sessions, assessments);
  assertTrue("impossible angle detected", qc.issues.some((i) => i.message.includes("physiologically plausible")));
  assertTrue("future date detected", qc.issues.some((i) => i.message.includes("in the future")));
  assertTrue("conflicting sex (duplicate patient) detected", qc.issues.some((i) => i.message.includes("conflicting sex")));
  assertTrue("at least one error-severity issue", qc.bySeverity.error >= 1);
}

console.log("\n--- Report generator: honest 'preliminary' output for tiny n ---");
{
  const sessions = [{ sessionId: "S1", hospitalId: "P1", side: "right", createdAt: "2026-01-01T00:00:00Z", asriVersion: "2.0.0", referenceDatasetVersion: "1.0.0", taskResults: {} }];
  const assessments = [{ sessionId: "S1", hospitalId: "P1", assessmentDate: "2026-01-02", age: 20, sex: "F", clinicianName: "Dr. Test", shoulderAbduction: 140 }];
  const comparisonResults = runComparison([], {});
  const calibrationReport = generateCalibrationReport(comparisonResults, {});
  const qcResults = runQualityControl(sessions, assessments);
  const reliabilityResults = { testRetest: testRetestReliability(sessions), interRater: interRaterReliability({}), intraRater: intraRaterReliability(assessments) };
  const report = generateValidationReport({ sessions, assessments, comparisonResults, reliabilityResults, calibrationReport, qcResults, datasetName: "synthetic n=1 test" });
  assertTrue("report is marked preliminary for n well below the recommended minimum", report.isPreliminary === true);
  assertTrue("limitations explicitly mention the sample size", report.limitations.some((l) => l.includes("PRELIMINARY")));
}

console.log("\n--- Phase 10: statistics.js additions (Fisher z CI, bootstrap ICC, sample-size adequacy) ---");
{
  // Fisher z CI: known r, hand-computable bounds
  const ci = fisherZCI(0.5, 30);
  assertTrue("fisherZCI: bounds bracket the point estimate", ci.low < 0.5 && ci.high > 0.5);
  assertTrue("fisherZCI: null for n<=3", fisherZCI(0.5, 3) === null);
  assertTrue("fisherZCI: null at |r|=1 (atanh undefined)", fisherZCI(1, 30) === null);

  // Bootstrap ICC: a matrix with obviously high agreement should bootstrap to a high-ICC CI
  const highAgreementMatrix = Array.from({ length: 20 }, (_, i) => [50 + i, 50 + i + (Math.random() - 0.5)]);
  const bootCi = bootstrapICC(highAgreementMatrix, "2,1", 300);
  assertTrue("bootstrapICC: returns a CI for a well-formed matrix", bootCi != null && bootCi.low <= bootCi.high);
  assertTrue("bootstrapICC: high-agreement data bootstraps to a high-ICC CI (low bound > 0.8)", bootCi.low > 0.8, JSON.stringify(bootCi));
  assertTrue("bootstrapICC: null for n<3 subjects", bootstrapICC([[1, 2]], "2,1") === null);

  // Sample-size adequacy: never a fabricated power number, just an honest classification
  const inadequate = sampleSizeAdequacy(5);
  const adequate = sampleSizeAdequacy(35);
  assertTrue("sampleSizeAdequacy: n=5 flagged inadequate against default min 30", inadequate.adequate === false);
  assertTrue("sampleSizeAdequacy: n=35 flagged adequate", adequate.adequate === true);
  assertTrue("sampleSizeAdequacy: inadequate statement explicitly disclaims computing post-hoc power", inadequate.statement.toLowerCase().includes("power"));
}

console.log("\n--- Phase 10: quality-control.js additions (statistical outliers, capture quality, exclusions) ---");
{
  // 10 sessions clustered around abduction=80-90, one clear outlier at 170 (physiologically plausible, statistically unusual)
  const sessions = Array.from({ length: 9 }, (_, i) => ({
    sessionId: `S${i}`,
    taskResults: { t1: { parameters: { shoulderAbductionDeg: { value: 80 + i, measurementType: "measured", confidence: "high" } } } },
  }));
  sessions.push({ sessionId: "S_outlier", taskResults: { t1: { parameters: { shoulderAbductionDeg: { value: 170, measurementType: "measured", confidence: "high" } } } } } );
  const outlierIssues = checkStatisticalOutliers(sessions);
  assertTrue("checkStatisticalOutliers: flags the injected statistical outlier", outlierIssues.some((i) => i.sessionId === "S_outlier"));
  assertTrue("checkStatisticalOutliers: does NOT flag the normal cluster", !outlierIssues.some((i) => i.sessionId === "S0"));

  const cqSessions = [
    { sessionId: "S_lowcqi", taskResults: { t1: { parameters: {}, cameraQuality: { cqi: 30 } } } },
    { sessionId: "S_highcqi", taskResults: { t1: { parameters: {}, cameraQuality: { cqi: 85 } } } },
  ];
  const cqIssues = checkCaptureQuality(cqSessions);
  assertTrue("checkCaptureQuality: flags the low-CQI task", cqIssues.some((i) => i.sessionId === "S_lowcqi"));
  assertTrue("checkCaptureQuality: does not flag the high-CQI task", !cqIssues.some((i) => i.sessionId === "S_highcqi"));

  const issues = [
    { severity: "error", sessionId: "S_bad", field: "x", message: "impossible value" },
    { severity: "warning", sessionId: "S_review", field: "y", message: "borderline" },
    { severity: "warning", sessionId: null, field: "z", message: "dataset-level, no single session" },
  ];
  const exclusions = recommendExclusions(issues);
  assertTrue("recommendExclusions: error-severity session -> excludeFromAnalysis true", exclusions.S_bad.excludeFromAnalysis === true);
  assertTrue("recommendExclusions: warning-only session -> excludeFromAnalysis false, but surfaced for review", exclusions.S_review.excludeFromAnalysis === false && exclusions.S_review.reviewReasons.length === 1);
  assertTrue("recommendExclusions: dataset-level (sessionId=null) issue doesn't create a phantom session entry", exclusions.null === undefined);

  const fullQc = runQualityControl(sessions, []);
  assertTrue("runQualityControl: now includes exclusionRecommendations", "exclusionRecommendations" in fullQc);
}

console.log("\n--- Phase 10: mallet-agreement.js (confusion matrix, percentage agreement, weighted kappa) ---");
{
  // Ground truth built by hand, independently verified against a manual calculation before writing this assertion:
  // 5 exact matches (I/I, II/II, III/III, IV/IV, V/V) + 2 off-by-one (III/IV, IV/III) => 7 pairs.
  const pairs = [
    { predictedGrade: "I", clinicianGrade: "I" }, { predictedGrade: "II", clinicianGrade: "II" },
    { predictedGrade: "III", clinicianGrade: "III" }, { predictedGrade: "III", clinicianGrade: "IV" },
    { predictedGrade: "IV", clinicianGrade: "IV" }, { predictedGrade: "IV", clinicianGrade: "III" },
    { predictedGrade: "V", clinicianGrade: "V" },
  ];
  const matrix = buildConfusionMatrix(pairs);
  assertTrue("buildConfusionMatrix: n matches input pair count", matrix.n === 7);
  assertTrue("buildConfusionMatrix: diagonal (exact matches) sums to 5", matrix.grades.reduce((sum, _, i) => sum + matrix.matrix[i][i], 0) === 5);

  const agreement = percentAgreement(pairs);
  assertTrue("percentAgreement: exact match = 5/7 = 71.4%", agreement.exactMatchPct === 71.4);
  assertTrue("percentAgreement: within-1-grade = 7/7 = 100% (both misses are off-by-one)", agreement.within1GradePct === 100);

  const kappaLinear = weightedKappa(pairs, "linear");
  const kappaQuadratic = weightedKappa(pairs, "quadratic");
  assertTrue("weightedKappa: hand-verified linear value (~0.794)", Math.abs(kappaLinear.value - 0.7941176470588229) < 1e-9);
  assertTrue("weightedKappa: quadratic weighting scores near-misses less harshly than linear (kappa_quad > kappa_linear)", kappaQuadratic.value > kappaLinear.value);
  assertTrue("weightedKappa: interpretation band matches the numeric value (substantial)", kappaLinear.interpretation === "substantial");

  const perfectSingleCategory = Array(10).fill(0).map(() => ({ predictedGrade: "III", clinicianGrade: "III" }));
  const degenerateKappa = weightedKappa(perfectSingleCategory);
  assertTrue("weightedKappa: perfect agreement concentrated on ONE category is mathematically undefined (pe=1, 0/0), correctly returns null rather than fabricating 1.0", degenerateKappa.value === null);

  const tooFew = weightedKappa(pairs.slice(0, 3));
  assertTrue("weightedKappa: n<5 refuses to compute rather than reporting an unstable estimate", "note" in tooFew && tooFew.value === undefined);
}

console.log("\n--- Phase 10: repeatability-engine.js (SD, CoV, repeatability coefficient) ---");
{
  // Hand-computable: diffs = [-4, 2, -1, -3] across 4 patients' repeat sessions 9 days apart.
  const sessions = [
    { sessionId: "s1a", hospitalId: "H1", createdAt: "2026-01-01", parameters: { shoulderAbductionDeg: { value: 100 } } },
    { sessionId: "s1b", hospitalId: "H1", createdAt: "2026-01-10", parameters: { shoulderAbductionDeg: { value: 104 } } },
    { sessionId: "s2a", hospitalId: "H2", createdAt: "2026-01-01", parameters: { shoulderAbductionDeg: { value: 90 } } },
    { sessionId: "s2b", hospitalId: "H2", createdAt: "2026-01-10", parameters: { shoulderAbductionDeg: { value: 88 } } },
    { sessionId: "s3a", hospitalId: "H3", createdAt: "2026-01-01", parameters: { shoulderAbductionDeg: { value: 110 } } },
    { sessionId: "s3b", hospitalId: "H3", createdAt: "2026-01-10", parameters: { shoulderAbductionDeg: { value: 111 } } },
    { sessionId: "s4a", hospitalId: "H4", createdAt: "2026-01-01", parameters: { shoulderAbductionDeg: { value: 95 } } },
    { sessionId: "s4b", hospitalId: "H4", createdAt: "2026-01-10", parameters: { shoulderAbductionDeg: { value: 98 } } },
  ];
  const result = betweenSessionRepeatability(sessions, { windowDays: 30 });
  const p = result.perParameter.shoulderAbductionDeg;
  assertTrue("betweenSessionRepeatability: n=4 pairs found", p.n === 4);
  assertTrue("betweenSessionRepeatability: mean difference matches hand calculation (-1.5)", Math.abs(p.meanDifference - -1.5) < 1e-9);
  assertTrue("betweenSessionRepeatability: diffSd matches hand calculation (~2.6458)", Math.abs(p.diffSd - 2.6457513110645907) < 1e-9);
  assertTrue("betweenSessionRepeatability: RC = 1.96 * diffSd exactly (not 1.96*sqrt(2)*diffSd, a common formula error)", Math.abs(p.repeatabilityCoefficient - 1.96 * p.diffSd) < 1e-9);
  assertTrue("betweenSessionRepeatability: withinSubjectSd = diffSd/sqrt(2)", Math.abs(p.withinSubjectSd - p.diffSd / Math.sqrt(2)) < 1e-9);

  const withinSession = withinSessionRepeatability();
  assertTrue("withinSessionRepeatability: honestly reports not_computable rather than fabricating a number", withinSession.status === "not_computable" && withinSession.reason.length > 0);
}

console.log("\n--- Phase 10: runValidation() end-to-end wiring (new sections present, old sections unchanged) ---");
{
  const sessions = [
    { sessionId: "S1", hospitalId: "P1", side: "right", createdAt: "2026-01-01T00:00:00Z", asriVersion: "2.0.0", referenceDatasetVersion: "1.0.0", taskResults: { t1: { parameters: { shoulderAbductionDeg: { value: 90, measurementType: "measured", confidence: "high" } }, cameraQuality: { cqi: 70 } } } },
    { sessionId: "S2", hospitalId: "P2", side: "left", createdAt: "2026-01-02T00:00:00Z", asriVersion: "2.0.0", referenceDatasetVersion: "1.0.0", taskResults: { t1: { parameters: { shoulderAbductionDeg: { value: 100, measurementType: "measured", confidence: "high" } }, cameraQuality: { cqi: 40 } } } },
  ];
  const assessments = [
    { sessionId: "S1", hospitalId: "P1", assessmentDate: "2026-01-01", age: 24, sex: "F", clinicianName: "Dr. A", shoulderAbduction: 92 },
    { sessionId: "S2", hospitalId: "P2", assessmentDate: "2026-01-02", age: 30, sex: "M", clinicianName: "Dr. A", shoulderAbduction: 98 },
  ];
  const malletGradePairs = [
    { taskId: "t1", predictedGrade: "III", clinicianGrade: "III", difference: 0 },
    { taskId: "t2", predictedGrade: "IV", clinicianGrade: "III", difference: -1 },
  ];
  const result = runValidation({ sessions, assessments, datasetName: "Phase 10 wiring test", malletGradePairs });

  assertTrue("runValidation: pre-existing sections still present and unchanged in shape", "comparisonResults" in result && "reliabilityResults" in result && "calibrationReport" in result && "qcResults" in result && "report" in result && "reportMarkdown" in result);
  assertTrue("runValidation: new malletAgreement section present with real computed values", result.malletAgreement.percentAgreement.n === 2 && result.malletAgreement.percentAgreement.exactMatchPct === 50);
  assertTrue("runValidation: new repeatabilityResults section present (betweenSession + honestly-not_computable withinSession)", result.repeatabilityResults.withinSession.status === "not_computable" && "betweenSession" in result.repeatabilityResults);
  assertTrue("runValidation: publicationTables has all 7 discrete tables", ["demographics", "assessmentSummary", "agreementStatistics", "errorStatistics", "reliabilityStatistics", "modelPerformance", "captureQualitySummary"].every((k) => k in result.publicationTables));
  assertTrue("runValidation: captureQualitySummary table reflects the injected CQI values (mean of 70 and 40 = 55)", result.publicationTables.captureQualitySummary.rows.find((r) => r.metric === "Mean CQI").value === 55);
  assertTrue("runValidation: pilotStudySummary present with a structured readiness classification", result.pilotStudySummary.readiness.engineeringVerification.status === "complete" && result.pilotStudySummary.readiness.clinicalDeployment.status === "not_ready");
  assertTrue("runValidation: pilotStudySummary correctly classifies this tiny sample as preliminary, not adequate", result.pilotStudySummary.readiness.clinicalValidation.status === "preliminary");
  assertTrue("runValidation: comparisonResults now carries a Pearson CI (Phase 10 addition), not just a bare pearsonR number", "pearsonR95CI" in result.comparisonResults.shoulderAbductionDeg);
}

console.log("\n--- Phase 10: chart-geometry.js additions (scatter, histogram) + Phase 9 regression ---");
{
  // Phase 9 regression: computeLineChartPoints must be byte-for-byte unchanged.
  const series = [{ tSec: 0, value: 10 }, { tSec: 1, value: 20 }, { tSec: 2, value: 15 }];
  const lineResult = computeLineChartPoints({ series, width: 400, height: 200 });
  assertTrue("computeLineChartPoints (Phase 9): still produces one point per valid series entry", lineResult.points.length === 3);
  assertTrue("computeLineChartPoints (Phase 9): still exposes xScale/yScale functions", typeof lineResult.xScale === "function" && typeof lineResult.yScale === "function");

  // Scatter: independent (x,y) pairs, unlike line's {tSec,value}.
  const scatterPoints = [{ x: 10, y: 12 }, { x: 20, y: 18 }, { x: 30, y: null }, { x: null, y: 40 }];
  const scatterResult = computeScatterPoints({ points: scatterPoints, width: 300, height: 200 });
  assertTrue("computeScatterPoints: drops points with a null x OR null y (2 of 4 valid)", scatterResult.points.length === 2);
  assertTrue("computeScatterPoints: scaled points stay within the inner drawing area", scatterResult.points.every((p) => p.x >= 0 && p.x <= 300 && p.y >= 0 && p.y <= 200));
  assertTrue("computeScatterPoints: preserves the original data values alongside scaled pixel coords", scatterResult.points[0].dataX === 10 && scatterResult.points[0].dataY === 12);

  // Histogram: known distribution, hand-verifiable bin counts.
  const values = [1, 1, 2, 2, 2, 3, 9]; // range 1-9, 10 bins of width 0.8 -- bin 0 (1.0-1.8) gets the two 1s
  const histResult = computeHistogramBins({ values, binCount: 10, width: 300, height: 200 });
  assertTrue("computeHistogramBins: total count across all bins equals input length", histResult.bins.reduce((sum, b) => sum + b.count, 0) === values.length);
  assertTrue("computeHistogramBins: bin heights stay within the inner drawing area", histResult.bins.every((b) => b.height >= 0 && b.height <= histResult.innerHeight + 0.01));
  assertTrue("computeHistogramBins: null for fewer than 2 values", computeHistogramBins({ values: [5], binCount: 10, width: 300, height: 200 }) === null);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
