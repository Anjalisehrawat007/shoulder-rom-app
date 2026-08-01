#!/usr/bin/env node
/**
 * verify-icqa.mjs — Phase 5 (ICQA) synthetic ground-truth checks
 * ----------------------------------------------------------------------------
 * Same pattern as verify-biomechanics.mjs / verify-asri.mjs / verify-motion.mjs
 * / verify-validation.mjs: pure math against hand-constructed synthetic
 * landmark/pixel data, no browser needed. Confirms: a well-framed, well-lit,
 * still, single-person scene scores high and passes the gate; a dark frame
 * tanks the lighting subscore; cropped feet tank body visibility, block the
 * gate, AND produce guidance text that specifically names the missing body
 * part (not a generic "quality low" message); a jittery landmark sequence
 * tanks tracking stability; a second detected person tanks body visibility
 * via the folded-in multi-person check; missing device-orientation input
 * falls back to a pose-based tilt/roll proxy correctly labeled "estimated"
 * (not "measured"); swapping in an alternate config with different subscore
 * weights changes the CQI for the identical input, proving the weights are
 * genuinely externalized and not hard-coded; the quality timeline detects a
 * sustained quality drop and triggers auto-pause.
 *
 * Run: node scripts/verify-icqa.mjs
 * ----------------------------------------------------------------------------
 */
import { analyzeCameraGeometry } from "../shared/icqa/camera-geometry.js";
import { analyzeFrameQuality } from "../shared/icqa/frame-quality.js";
import { analyzeVisibility } from "../shared/icqa/visibility-analysis.js";
import { analyzeStability } from "../shared/icqa/tracking-stability.js";
import { IcqaEngine } from "../shared/icqa/icqa-engine.js";
import { buildGuidance } from "../shared/icqa/guidance-engine.js";
import { evaluateGate } from "../shared/icqa/recording-gate.js";
import { startTimeline, sample as sampleTimeline, finalize as finalizeTimeline } from "../shared/icqa/quality-timeline.js";
import { LM_FULL } from "../shared/icqa/landmark-groups.js";
import baseConfig from "../config/icqa-config.v1.json" with { type: "json" };

let failures = 0;
function assertTrue(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? " (" + detail + ")" : ""}`);
  if (!condition) failures++;
}

// ---- synthetic landmark builder --------------------------------------------
// An "ideal" standing frontal pose: full body head-to-feet in frame, level
// shoulders, centered, trunk/leg span ratio matching the reference used by
// camera-geometry.js (see that file's EXPECTED_TRUNK_TO_LEG_RATIO), so the
// baseline scenario is expected to score near-perfectly across every
// subscore -- a useful sanity check independent of any single criterion.
function idealLandmarks() {
  const lm = new Array(33).fill(null);
  const set = (idx, x, y, visibility = 0.95) => { lm[idx] = { x, y, z: 0, visibility }; };
  set(LM_FULL.NOSE, 0.5, 0.06);
  set(LM_FULL.L_EYE, 0.48, 0.055); set(LM_FULL.R_EYE, 0.52, 0.055);
  set(LM_FULL.L_EAR, 0.46, 0.06); set(LM_FULL.R_EAR, 0.54, 0.06);
  set(LM_FULL.MOUTH_L, 0.49, 0.08); set(LM_FULL.MOUTH_R, 0.51, 0.08);
  set(LM_FULL.L_SHOULDER, 0.42, 0.25); set(LM_FULL.R_SHOULDER, 0.58, 0.25);
  set(LM_FULL.L_ELBOW, 0.38, 0.38); set(LM_FULL.R_ELBOW, 0.62, 0.38);
  set(LM_FULL.L_WRIST, 0.36, 0.5); set(LM_FULL.R_WRIST, 0.64, 0.5);
  set(LM_FULL.L_PINKY, 0.35, 0.52); set(LM_FULL.R_PINKY, 0.65, 0.52);
  set(LM_FULL.L_INDEX, 0.35, 0.51); set(LM_FULL.R_INDEX, 0.65, 0.51);
  set(LM_FULL.L_THUMB, 0.36, 0.49); set(LM_FULL.R_THUMB, 0.64, 0.49);
  set(LM_FULL.L_HIP, 0.45, 0.5); set(LM_FULL.R_HIP, 0.55, 0.5);
  set(LM_FULL.L_KNEE, 0.44, 0.7); set(LM_FULL.R_KNEE, 0.56, 0.7);
  set(LM_FULL.L_ANKLE, 0.44, 0.9); set(LM_FULL.R_ANKLE, 0.56, 0.9);
  set(LM_FULL.L_HEEL, 0.43, 0.91); set(LM_FULL.R_HEEL, 0.57, 0.91);
  set(LM_FULL.L_FOOT_INDEX, 0.44, 0.93); set(LM_FULL.R_FOOT_INDEX, 0.56, 0.93);
  return lm;
}

function withLowVisibility(lm, indices, visibility = 0.05) {
  const copy = lm.map((p) => (p ? { ...p } : p));
  for (const idx of indices) if (copy[idx]) copy[idx].visibility = visibility;
  return copy;
}

// ---- synthetic pixel buffer builder ----------------------------------------
function makeImageData(width, height, rgbFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbFn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const uniformGray = (level) => makeImageData(64, 48, () => [level, level, level]);
const checkerboard = (a, b, cell = 4) => makeImageData(64, 48, (x, y) => {
  const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? a : b;
  return [v, v, v];
});

function stillHistory(lm, n = 6) {
  return Array.from({ length: n }, (_, i) => ({ t: i * 33, lm }));
}

function jitteryHistory(lm, n = 6) {
  return Array.from({ length: n }, (_, i) => {
    const noisy = lm.map((p) => (p ? { ...p, x: p.x + (i % 2 === 0 ? 0.05 : -0.05), y: p.y + (i % 2 === 0 ? -0.04 : 0.04) } : p));
    return { t: i * 33, lm: noisy };
  });
}

const engine = new IcqaEngine(baseConfig);

// ---- 1. Ideal scenario: everything should score high, gate should pass ----
{
  const lm = idealLandmarks();
  const geometry = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: { alpha: 0, beta: 1, gamma: 0.5 }, config: baseConfig });
  const frameQuality = analyzeFrameQuality({ imageData: checkerboard(90, 160, 6), bboxNormalized: { minX: 0.35, maxX: 0.65, minY: 0.05, maxY: 0.93 } });
  const visibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 1, config: baseConfig });
  const stability = analyzeStability(stillHistory(lm));
  const result = engine.score({ geometry, frameQuality, visibility, stability });
  const gate = evaluateGate(result, baseConfig);

  assertTrue("ideal scenario: CQI is high", result.cqi != null && result.cqi > 75, `cqi=${result.cqi}`);
  assertTrue("ideal scenario: cameraPosition subscore is high", result.subscores.cameraPosition.score > 80, `score=${result.subscores.cameraPosition.score}`);
  assertTrue("ideal scenario: bodyVisibility subscore is high", result.subscores.bodyVisibility.score > 85, `score=${result.subscores.bodyVisibility.score}`);
  assertTrue("ideal scenario: gate passes (no blocking criteria)", gate.canRecord === true, JSON.stringify(gate.blockingCriteria));
}

// ---- 2. Dark frame: lighting subscore should be low ------------------------
{
  const lm = idealLandmarks();
  const geometry = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: null, config: baseConfig });
  const darkFrameQuality = analyzeFrameQuality({ imageData: uniformGray(8), bboxNormalized: null });
  const brightFrameQuality = analyzeFrameQuality({ imageData: checkerboard(90, 160, 6), bboxNormalized: null });
  const visibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 1, config: baseConfig });
  const stability = analyzeStability(stillHistory(lm));
  const darkResult = engine.score({ geometry, frameQuality: darkFrameQuality, visibility, stability });
  const brightResult = engine.score({ geometry, frameQuality: brightFrameQuality, visibility, stability });

  assertTrue("dark frame: mean luminance is very low", darkFrameQuality.lighting.meanLuminance.value < 15, `mean=${darkFrameQuality.lighting.meanLuminance.value}`);
  assertTrue("dark frame: lighting subscore is much lower than a well-lit frame", darkResult.subscores.lighting.score < brightResult.subscores.lighting.score - 30, `dark=${darkResult.subscores.lighting.score} bright=${brightResult.subscores.lighting.score}`);
}

// ---- 3. Cropped feet: body visibility low, gate blocked, guidance mentions feet ----
{
  const lm = withLowVisibility(idealLandmarks(), [LM_FULL.L_KNEE, LM_FULL.R_KNEE, LM_FULL.L_ANKLE, LM_FULL.R_ANKLE, LM_FULL.L_HEEL, LM_FULL.R_HEEL, LM_FULL.L_FOOT_INDEX, LM_FULL.R_FOOT_INDEX]);
  const geometry = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: { alpha: 0, beta: 0, gamma: 0 }, config: baseConfig });
  const frameQuality = analyzeFrameQuality({ imageData: checkerboard(90, 160, 6), bboxNormalized: null });
  const visibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 1, config: baseConfig });
  const stability = analyzeStability(stillHistory(lm));
  const result = engine.score({ geometry, frameQuality, visibility, stability });
  const gate = evaluateGate(result, baseConfig);
  const guidance = buildGuidance({ icqaResult: result, geometry, frameQuality, visibility, config: baseConfig });

  assertTrue("cropped feet: 'feet' is in the occluded parts list", visibility.occludedParts.includes("feet"), JSON.stringify(visibility.occludedParts));
  assertTrue("cropped feet: bodyVisibility subscore drops", result.subscores.bodyVisibility.score < 80, `score=${result.subscores.bodyVisibility.score}`);
  assertTrue("cropped feet: gate is blocked", gate.canRecord === false);
  assertTrue("cropped feet: blocking criteria include bodyVisibility", gate.blockingCriteria.some((c) => c.key === "bodyVisibility"), JSON.stringify(gate.blockingCriteria));
  assertTrue("cropped feet: guidance text specifically mentions feet", guidance.primary.toLowerCase().includes("feet"), guidance.primary);
}

// ---- 4. Jittery landmark sequence: tracking stability low -------------------
{
  const lm = idealLandmarks();
  const stableStability = analyzeStability(stillHistory(lm));
  const jitteryStability = analyzeStability(jitteryHistory(lm));
  const geometry = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: { alpha: 0, beta: 0, gamma: 0 }, config: baseConfig });
  const frameQuality = analyzeFrameQuality({ imageData: checkerboard(90, 160, 6), bboxNormalized: null });
  const visibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 1, config: baseConfig });

  const stableResult = engine.score({ geometry, frameQuality, visibility, stability: stableStability });
  const jitteryResult = engine.score({ geometry, frameQuality, visibility, stability: jitteryStability });

  assertTrue("jittery sequence: jitter value is much larger than the still sequence", jitteryStability.jitter.value > stableStability.jitter.value * 10, `still=${stableStability.jitter.value} jittery=${jitteryStability.jitter.value}`);
  assertTrue("jittery sequence: trackingStability subscore is much lower", jitteryResult.subscores.trackingStability.score < stableResult.subscores.trackingStability.score - 30, `still=${stableResult.subscores.trackingStability.score} jittery=${jitteryResult.subscores.trackingStability.score}`);
}

// ---- 5. Second person detected: body visibility folds in the multi-person flag ----
{
  const lm = idealLandmarks();
  const geometry = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: { alpha: 0, beta: 0, gamma: 0 }, config: baseConfig });
  const frameQuality = analyzeFrameQuality({ imageData: checkerboard(90, 160, 6), bboxNormalized: null });
  const stability = analyzeStability(stillHistory(lm));
  const singlePersonVisibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 1, config: baseConfig });
  const twoPersonVisibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 2, config: baseConfig });

  const singleResult = engine.score({ geometry, frameQuality, visibility: singlePersonVisibility, stability });
  const twoResult = engine.score({ geometry, frameQuality, visibility: twoPersonVisibility, stability });
  const gate = evaluateGate(twoResult, baseConfig);

  assertTrue("multi-person flag is set when secondaryPersonCount=2", twoPersonVisibility.multiPerson.value === true);
  assertTrue("second person in frame lowers the bodyVisibility subscore", twoResult.subscores.bodyVisibility.score < singleResult.subscores.bodyVisibility.score, `single=${singleResult.subscores.bodyVisibility.score} two=${twoResult.subscores.bodyVisibility.score}`);
  assertTrue("second person in frame blocks the gate", gate.canRecord === false);
}

// ---- 6. Missing device-orientation input: tilt/roll fall back to the pose proxy, labeled "estimated" ----
{
  const lm = idealLandmarks();
  const withSensor = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: { alpha: 10, beta: 2, gamma: -1 }, config: baseConfig });
  const withoutSensor = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: null, config: baseConfig });

  assertTrue("with device-orientation sensor: tilt is measured", withSensor.tilt.measurementType === "measured", withSensor.tilt.measurementType);
  assertTrue("without device-orientation sensor: tilt falls back to estimated (pose proxy)", withoutSensor.tilt.measurementType === "estimated", withoutSensor.tilt.measurementType);
  assertTrue("without device-orientation sensor: roll falls back to estimated (pose proxy)", withoutSensor.roll.measurementType === "estimated", withoutSensor.roll.measurementType);
  assertTrue("pose-proxy tilt/roll still produce a numeric value for an upright, level pose", withoutSensor.tilt.value != null && withoutSensor.roll.value != null);
}

// ---- 7. Alternate config weights change the CQI for identical input --------
{
  const lm = idealLandmarks();
  const geometry = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: { alpha: 0, beta: 0, gamma: 0 }, config: baseConfig });
  const darkFrameQuality = analyzeFrameQuality({ imageData: uniformGray(20), bboxNormalized: null });
  const visibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 1, config: baseConfig });
  const stability = analyzeStability(stillHistory(lm));

  const baseResult = engine.score({ geometry, frameQuality: darkFrameQuality, visibility, stability });

  const altConfig = JSON.parse(JSON.stringify(baseConfig));
  altConfig.version = "1.0.0-test-alt-weights";
  // Push nearly all weight onto lighting -- since this scenario is dark, the
  // composite CQI should drop noticeably relative to the default weighting.
  for (const key of Object.keys(altConfig.subscores)) altConfig.subscores[key].weight = key === "lighting" ? 0.9 : 0.1 / 7;
  const altEngine = new IcqaEngine(altConfig);
  const altResult = altEngine.score({ geometry, frameQuality: darkFrameQuality, visibility, stability });

  assertTrue("re-weighting subscores changes the CQI for identical raw input (weights are genuinely externalized)", Math.abs(altResult.cqi - baseResult.cqi) > 3, `base=${baseResult.cqi} alt=${altResult.cqi}`);
}

// ---- 8. Guidance text differs across distinct failure categories -----------
{
  const lm = idealLandmarks();
  const stability = analyzeStability(stillHistory(lm));

  const darkGeometry = analyzeCameraGeometry({ landmarks: lm, deviceOrientation: { alpha: 0, beta: 0, gamma: 0 }, config: baseConfig });
  const darkFrameQuality = analyzeFrameQuality({ imageData: uniformGray(10), bboxNormalized: null });
  const visibility = analyzeVisibility({ landmarks: lm, secondaryPersonCount: 1, config: baseConfig });
  const darkResult = engine.score({ geometry: darkGeometry, frameQuality: darkFrameQuality, visibility, stability });
  const darkGuidance = buildGuidance({ icqaResult: darkResult, geometry: darkGeometry, frameQuality: darkFrameQuality, visibility, config: baseConfig });

  const croppedLm = withLowVisibility(idealLandmarks(), [LM_FULL.L_ANKLE, LM_FULL.R_ANKLE, LM_FULL.L_KNEE, LM_FULL.R_KNEE, LM_FULL.L_HEEL, LM_FULL.R_HEEL, LM_FULL.L_FOOT_INDEX, LM_FULL.R_FOOT_INDEX]);
  const croppedGeometry = analyzeCameraGeometry({ landmarks: croppedLm, deviceOrientation: { alpha: 0, beta: 0, gamma: 0 }, config: baseConfig });
  const brightFrameQuality = analyzeFrameQuality({ imageData: checkerboard(90, 160, 6), bboxNormalized: null });
  const croppedVisibility = analyzeVisibility({ landmarks: croppedLm, secondaryPersonCount: 1, config: baseConfig });
  const croppedResult = engine.score({ geometry: croppedGeometry, frameQuality: brightFrameQuality, visibility: croppedVisibility, stability });
  const croppedGuidance = buildGuidance({ icqaResult: croppedResult, geometry: croppedGeometry, frameQuality: brightFrameQuality, visibility: croppedVisibility, config: baseConfig });

  assertTrue("dark-frame guidance and cropped-feet guidance produce distinct primary messages", darkGuidance.primary !== croppedGuidance.primary, `dark="${darkGuidance.primary}" cropped="${croppedGuidance.primary}"`);
}

// ---- 9. Quality timeline: sustained drop triggers auto-pause ---------------
{
  const cfg = baseConfig;
  const timeline = startTimeline();
  const goodResult = { cqi: 85, subscores: {} };
  const badResult = { cqi: 10, subscores: {} };
  let lastTrigger = null;
  sampleTimeline(timeline, goodResult, 0.0, cfg);
  sampleTimeline(timeline, goodResult, 0.5, cfg);
  lastTrigger = sampleTimeline(timeline, badResult, 1.0, cfg).autoPauseTriggered;
  assertTrue("a single bad sample does not trigger auto-pause", lastTrigger === false);
  lastTrigger = sampleTimeline(timeline, badResult, 1.5, cfg).autoPauseTriggered;
  lastTrigger = sampleTimeline(timeline, badResult, 2.0, cfg).autoPauseTriggered;
  assertTrue(`${cfg.timeline.autoPauseConsecutiveSamples} consecutive bad samples trigger auto-pause`, lastTrigger === true);
  sampleTimeline(timeline, goodResult, 2.5, cfg);
  const summary = finalizeTimeline(timeline, cfg);
  assertTrue("finalized timeline records at least one auto-pause event", summary.autoPaused === true && summary.autoPauseEvents.length >= 1, JSON.stringify(summary.autoPauseEvents));
  assertTrue("finalized timeline resumes the open auto-pause event once quality recovers", summary.autoPauseEvents[0].resumedAtSec != null, JSON.stringify(summary.autoPauseEvents));
  assertTrue("finalized timeline reports a low minCqi", summary.minCqi === 10, `minCqi=${summary.minCqi}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
