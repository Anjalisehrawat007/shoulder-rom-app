/**
 * dmqe-engine.js — Part 4: Dynamic Movement Quality Engine (DMQE)
 * ----------------------------------------------------------------------------
 * The second major research contribution alongside ASRI (shared/asri/), built
 * to the same architectural rigor: every output is a parameter-schema
 * envelope (value, measurementType, confidence, limitation), domain scores
 * are confidence-weighted, and the full contribution trace is returned for
 * reproducibility -- not just a final number.
 *
 * SCOPE DECISION, DOCUMENTED HONESTLY: unlike ASRI (Phase 2), DMQE's domain
 * weights are inline documented constants, not an externalized JSON config.
 * Phase 2's config-externalization was an explicit requirement for ASRI;
 * Phase 3's brief for DMQE emphasizes measurement rigor and confidence
 * rather than repeating that architecture. Externalizing DMQE's weights into
 * a versioned config (mirroring shared/asri/asri-engine.js's
 * VersionedConfigStore) is a natural, low-risk future enhancement, not done
 * here to keep this already-large phase bounded.
 *
 * PLACEHOLDER 0-100 SCALINGS: several domains below (smoothness from LDLJ,
 * stability, movement control) convert a raw, unbounded scientific quantity
 * into a bounded 0-100 sub-score using a documented linear mapping with
 * provisional constants -- there is no real-cohort data yet to calibrate
 * "what LDLJ value is a 50 vs a 90". The RAW value is always preserved in
 * the contribution trace as the scientifically primary output; the 0-100
 * score is a labeled convenience for the composite DMQE Score. Same honest
 * "placeholder pending pilot cohort" stance already used for ASRI's weights
 * and reference targets (Phase 2) and segmentation's thresholds (Part 3).
 *
 * FATIGUE INDICATORS -- deliberately NOT implemented. A single ~7s task
 * repetition provides no baseline/rest comparison and no physiological
 * signal to assess fatigue against; comparing trends across the 4 *different*
 * tasks would confound fatigue with each task's distinct inherent
 * difficulty (order effects and task-difficulty effects are not
 * separable with this protocol). This directly answers the brief's "only
 * if scientifically justified" condition: it is not justified here. See
 * FATIGUE_LIMITATION below, surfaced as its own contribution entry rather
 * than silently omitted, so the decision is discoverable/documented.
 * ----------------------------------------------------------------------------
 */
import { makeParameter } from "../biomechanics/parameter-schema.js";
import { vec3 } from "../biomechanics/coordinate-frame.js";
import { LM } from "../biomechanics/index.js";
import { segmentMovement, resolveSegmentationProfile, SEGMENTATION_PROFILE_VERSION } from "./segmentation.js";
import { analyzeTrajectory } from "./trajectory-analysis.js";

// Phase 4 addition (Part 8, dataset metadata): a simple version string, not a
// full versioned-config-store like ASRI's -- DMQE's weights are still inline
// constants (see header). This exists purely so a session's stored metadata
// can record which DMQE logic revision produced it; bump manually when the
// scoring logic in this file changes materially. No behavior depends on it.
const DMQE_ENGINE_VERSION = "3.0.0";

const CONFIDENCE_WEIGHTS = { measured_high: 1.0, measured_moderate: 0.8, estimated_moderate: 0.6, estimated_low: 0.35, unavailable: 0 };

const FATIGUE_LIMITATION =
  "Not scientifically justified from a single ~7s task repetition: no baseline/rest comparison, no physiological " +
  "signal, and the 4 tasks in this protocol differ in inherent difficulty, so any cross-task trend would confound " +
  "fatigue with task identity rather than isolate it. Deliberately omitted rather than fabricated.";

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function confidenceWeight(measurementType, confidence) {
  if (measurementType === "unavailable") return CONFIDENCE_WEIGHTS.unavailable;
  return CONFIDENCE_WEIGHTS[`${measurementType}_${confidence}`] ?? 0;
}

/** Log Dimensionless Jerk (adapted to the angular elevation signal rather
 *  than classical Cartesian hand position, so it reuses the single already-
 *  computed elevation/velocity/jerk curves -- see header for rationale).
 *  LDLJ = -ln( (T^3 / peakSpeed^2) * integral(jerk^2 dt) ). Higher (less
 *  negative) = smoother. Formula: Hogan & Sternad 2009 / Balasubramanian et
 *  al.'s dimensionless-jerk smoothness family. */
function computeLDLJ(jerkValues, velocityValues, timesSec) {
  let integral = 0;
  let any = false;
  for (let i = 1; i < jerkValues.length; i++) {
    const j0 = jerkValues[i - 1];
    const j1 = jerkValues[i];
    if (j0 == null || j1 == null) continue;
    const dt = timesSec[i] - timesSec[i - 1];
    if (dt <= 0) continue;
    integral += 0.5 * (j0 * j0 + j1 * j1) * dt;
    any = true;
  }
  if (!any) return null;
  const duration = timesSec[timesSec.length - 1] - timesSec[0];
  const peakSpeed = Math.max(0, ...velocityValues.filter((v) => v != null).map(Math.abs));
  if (duration <= 0 || peakSpeed <= 0) return null;
  const dlj = (duration ** 3 / (peakSpeed * peakSpeed)) * integral;
  return dlj > 0 ? -Math.log(dlj) : null;
}

/** Trajectory straightness: std-dev of lateral deviation from the straight
 *  start->peak line, normalized by path length. Lower = straighter/more
 *  stable. */
function computeStability(reachFrames, wristIdx) {
  const { v3, magnitude, normalize, dot } = vec3;
  const pts = reachFrames.map((f) => f.lm?.[wristIdx]).filter(Boolean);
  if (pts.length < 3) return null;
  const start = pts[0];
  const end = pts[pts.length - 1];
  const lineVec = v3(start, end);
  const lineLen = magnitude(lineVec);
  if (lineLen < 1e-6) return null;
  const lineDir = normalize(lineVec);
  const deviations = pts.map((p) => {
    const toPoint = v3(start, p);
    const along = dot(toPoint, lineDir);
    const proj = { x: start.x + lineDir.x * along, y: start.y + lineDir.y * along, z: start.z + lineDir.z * along };
    return magnitude(v3(proj, p));
  });
  const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const variance = deviations.reduce((a, b) => a + (b - mean) ** 2, 0) / deviations.length;
  return Math.sqrt(variance) / lineLen;
}

/** Corrective-submovement proxy: acceleration sign changes within the final
 *  20% of the reach-to-peak window (established motor-control idea: extra
 *  decel/reaccel events near the target indicate correction, not one clean
 *  approach). */
function countCorrectiveEvents(accelerationValues) {
  const n = accelerationValues.length;
  const tailStart = Math.floor(n * 0.8);
  let count = 0;
  let prevSign = null;
  for (let i = tailStart; i < n; i++) {
    const a = accelerationValues[i];
    if (a == null || Math.abs(a) < 1e-6) continue;
    const sign = Math.sign(a);
    if (prevSign != null && sign !== prevSign) count++;
    prevSign = sign;
  }
  return count;
}

/** Additional low-speed intervals beyond the expected hold phase --
 *  hesitation/pause proxy. */
function detectPauses(speeds, phases, noiseFloor, minRunFrames) {
  const pauses = [];
  let run = 0;
  let runStart = null;
  for (let i = phases.movementStart; i <= phases.movementEnd; i++) {
    const insideHold = phases.holdStart != null && i >= phases.holdStart && i <= phases.holdEnd;
    const low = speeds[i] != null && speeds[i] <= noiseFloor && !insideHold;
    if (low) {
      if (run === 0) runStart = i;
      run++;
    } else {
      if (run >= minRunFrames) pauses.push({ startIndex: runStart, endIndex: i - 1, frames: run });
      run = 0;
      runStart = null;
    }
  }
  if (run >= minRunFrames) pauses.push({ startIndex: runStart, endIndex: phases.movementEnd, frames: run });
  return pauses;
}

/**
 * Run the full DMQE analysis for one task.
 * @param {Array<{t:number, lm:object[]|null}>} filteredFrames - post-filtering
 *   (landmark-filter.js output); may contain reconstructed values for frames
 *   that were originally missing.
 * @param {string} side - "left" | "right"
 * @param {Array<{t:number, lm:object[]|null}>} [rawFrames] - pre-filtering
 *   frames, used only to measure what fraction of the movement window had
 *   an actual detection vs. a filter-reconstructed value, folded into
 *   movementConfidencePct below. Optional: if omitted, data completeness is
 *   assumed 100% (e.g. when a caller only has the filtered sequence).
 * @param {object} [options]
 * @param {string} [options.segmentationProfile] - name of a
 *   shared/motion/segmentation.js profile ("standard" |
 *   "lowAmplitudeRotational"). Selects the movement-detection thresholds only;
 *   no DMQE scoring mathematics depends on it. Omitted / unknown => "standard",
 *   which is the historical behaviour, so every existing call site is
 *   unaffected.
 */
function runDmqe(filteredFrames, side, rawFrames = null, { segmentationProfile } = {}) {
  const wristIndex = side === "right" ? LM.R_WRIST : LM.L_WRIST;
  const segmentation = segmentMovement(filteredFrames, {
    wristIndex,
    opts: resolveSegmentationProfile(segmentationProfile),
  });
  if (segmentation.status !== "ok") {
    return {
      dmqeScore: null,
      movementConfidencePct: 0,
      status: segmentation.status,
      domains: {},
      contributions: [],
      // Carried on the failure path too: a `no_movement_detected` result is
      // only interpretable if you know which thresholds rejected it.
      segmentationProfile: segmentationProfile || "standard",
      segmentationProfileVersion: SEGMENTATION_PROFILE_VERSION,
    };
  }

  // Data completeness: fraction of frames in the movement window that had an
  // actual detection before filtering reconstructed any gaps. A sequence
  // that's mostly interpolated through missing landmarks should report lower
  // confidence than one that was cleanly tracked throughout, even if the
  // filter successfully patched the gaps well enough to avoid a crash.
  let dataCompleteness = 1;
  if (rawFrames) {
    const windowRaw = rawFrames.slice(segmentation.phases.movementStart, segmentation.phases.movementEnd + 1);
    const detected = windowRaw.filter((f) => f.lm != null).length;
    dataCompleteness = windowRaw.length > 0 ? detected / windowRaw.length : 1;
  }

  const trajectory = analyzeTrajectory(filteredFrames, segmentation.phases, side);
  const timesSec = filteredFrames.map((f) => f.t / 1000).slice(segmentation.phases.movementStart, segmentation.phases.movementEnd + 1);
  const jerkValues = trajectory.jerkCurve.value.map((p) => p.value);
  const velocityValues = trajectory.velocityCurve.value.map((p) => p.value);
  const accelerationValues = trajectory.accelerationCurve.value.map((p) => p.value);
  const reachFrames = filteredFrames.slice(segmentation.phases.movementStart, segmentation.phases.peakMotion + 1);

  const domains = {};
  const contributions = [];

  // --- Smoothness (LDLJ) ---
  const ldlj = computeLDLJ(jerkValues, velocityValues, timesSec);
  const smoothnessScore = ldlj != null ? round1(clamp(50 + ldlj * 5, 0, 100)) : null; // placeholder scaling, see header
  domains.smoothness = makeParameter({
    value: smoothnessScore,
    unit: "score(0-100)",
    measurementType: ldlj != null ? "estimated" : "unavailable",
    confidence: ldlj != null ? "low" : null,
    limitation: `Log Dimensionless Jerk = ${ldlj != null ? round1(ldlj) : "n/a"} (raw value; higher/less-negative = smoother). 0-100 conversion uses a placeholder linear scaling pending real-cohort LDLJ distribution -- see dmqe-engine.js header.`,
  });

  // --- Stability ---
  const stabilityRaw = computeStability(reachFrames, wristIndex);
  const stabilityScore = stabilityRaw != null ? round1(clamp(100 - stabilityRaw * 300, 0, 100)) : null;
  domains.stability = makeParameter({
    value: stabilityScore,
    unit: "score(0-100)",
    measurementType: stabilityRaw != null ? "estimated" : "unavailable",
    confidence: stabilityRaw != null ? "low" : null,
    limitation: `Trajectory straightness: std-dev of lateral deviation from the straight start->peak line, normalized by path length (raw ratio = ${stabilityRaw != null ? round1(stabilityRaw * 100) / 100 : "n/a"}). Placeholder 0-100 scaling, see header.`,
  });

  // --- Efficiency (reused directly from trajectory-analysis, already 0-100) ---
  domains.efficiency = trajectory.pathEfficiency;

  // --- Angular kinematics summary (peak values from the curves) ---
  const peakVelocity = Math.max(0, ...velocityValues.filter((v) => v != null).map(Math.abs));
  const peakAcceleration = Math.max(0, ...accelerationValues.filter((v) => v != null).map(Math.abs));
  domains.peakAngularVelocity = makeParameter({ value: round1(peakVelocity), unit: "deg/s", measurementType: "estimated", confidence: "moderate", limitation: "Peak of the velocity curve (see trajectory-analysis.js)." });
  domains.peakAngularAcceleration = makeParameter({ value: round1(peakAcceleration), unit: "deg/s^2", measurementType: "estimated", confidence: "low", limitation: "Peak of the acceleration curve; second-derivative noise amplification applies." });

  // Peak wrist speed in landmark-units/s (not deg/s) -- kept in this unit
  // specifically so it can replace shared/biomechanics/motion-quality.js's
  // live estimate as the source of ASRI's `movementSpeed` parameter (Phase 2,
  // reference-datasets.v1.json) without needing a unit conversion or any
  // change to ASRI's config.
  const movementWindowSpeeds = segmentation.speeds.slice(segmentation.phases.movementStart, segmentation.phases.movementEnd + 1).filter((s) => s != null);
  const peakWristSpeed = movementWindowSpeeds.length > 0 ? Math.max(...movementWindowSpeeds) : null;
  domains.peakWristSpeed = makeParameter({
    value: peakWristSpeed != null ? round1(peakWristSpeed) : null,
    unit: "landmark-units/s",
    measurementType: peakWristSpeed != null ? "estimated" : "unavailable",
    confidence: peakWristSpeed != null ? "moderate" : null,
    limitation: "Peak filtered wrist speed within the movement window, in normalized landmark-space units (not calibrated real-world velocity) -- same unit as Phase 1/2's movementSpeed parameter.",
  });

  // --- Pause detection ---
  const pauses = detectPauses(segmentation.speeds, segmentation.phases, 0.15, 3);
  domains.pauseCount = makeParameter({ value: pauses.length, unit: "count", measurementType: "estimated", confidence: "moderate", limitation: "Low-velocity intervals beyond the expected hold phase; threshold-based, same placeholder noise floor as segmentation.js." });

  // --- Compensation onset / duration / severity ---
  const timeline = trajectory.compensationTimeline.value;
  const flaggedIdx = timeline.findIndex((f) => f.flag);
  const onsetSec = flaggedIdx >= 0 ? (timeline[flaggedIdx].t - timeline[0].t) / 1000 : null;
  const flaggedCount = timeline.filter((f) => f.flag).length;
  const durationSec = flaggedCount > 0 ? (flaggedCount * (timeline.length > 1 ? (timeline[timeline.length - 1].t - timeline[0].t) / 1000 / timeline.length : 0)) : 0;
  domains.compensationOnsetSec = makeParameter({ value: onsetSec != null ? round1(onsetSec) : null, unit: "s", measurementType: flaggedIdx >= 0 ? "estimated" : "unavailable", confidence: flaggedIdx >= 0 ? "low" : null, limitation: "Elapsed time from movement start to the first frame where Phase 1's compensation flag activates; inherits that flag's estimated/low rating." });
  domains.compensationDurationSec = makeParameter({ value: round1(durationSec), unit: "s", measurementType: "estimated", confidence: "low", limitation: "Approximate total time the compensation flag was active during the movement window." });

  // --- Movement control (corrective submovements near peak approach) ---
  const correctiveEvents = countCorrectiveEvents(accelerationValues);
  const controlScore = round1(clamp(100 - correctiveEvents * 15, 0, 100));
  domains.movementControl = makeParameter({ value: controlScore, unit: "score(0-100)", measurementType: "estimated", confidence: "low", limitation: `${correctiveEvents} corrective (decel/reaccel) events detected in the final approach to peak. Placeholder 0-100 scaling, see header.` });

  // --- Trajectory Consistency / Motion Repeatability: unavailable (single-rep protocol) ---
  const REPEAT_LIMITATION = "Requires multiple repetitions of the same task within a session to compare against each other; the current capture protocol captures each task once. Architected to compute automatically once repeated-trial capture exists.";
  domains.trajectoryConsistency = makeParameter({ value: null, unit: "score(0-100)", measurementType: "unavailable", limitation: REPEAT_LIMITATION });
  domains.motionRepeatability = makeParameter({ value: null, unit: "score(0-100)", measurementType: "unavailable", limitation: REPEAT_LIMITATION });

  // --- Fatigue: deliberately not implemented, documented ---
  domains.fatigueIndicators = makeParameter({ value: null, unit: "n/a", measurementType: "unavailable", limitation: FATIGUE_LIMITATION });

  // --- Composite DMQE score: confidence-weighted average of the bounded 0-100 domains ---
  const scoredDomains = ["smoothness", "stability", "efficiency", "pauseCount", "movementControl"];
  let weightedSum = 0;
  let weightSum = 0;
  for (const key of scoredDomains) {
    const d = domains[key];
    if (d.value == null || d.measurementType === "unavailable") continue;
    const w = confidenceWeight(d.measurementType, d.confidence);
    const normalizedValue = key === "pauseCount" ? clamp(100 - d.value * 15, 0, 100) : d.value; // pauseCount isn't itself 0-100
    weightedSum += w * normalizedValue;
    weightSum += w;
    contributions.push({ domain: key, value: d.value, measurementType: d.measurementType, confidence: d.confidence, weight: round1(w) });
  }

  const dmqeScore = weightSum > 0 ? round1(weightedSum / weightSum) : null;
  const confidencePct = weightSum > 0 ? round1((weightSum / scoredDomains.length) * 100 * dataCompleteness) : 0;

  return {
    dmqeScore,
    movementConfidencePct: confidencePct,
    dataCompletenessPct: round1(dataCompleteness * 100),
    status: "ok",
    segmentation: segmentation.phases,
    speeds: segmentation.speeds,
    trajectory,
    domains,
    contributions,
    segmentationProfile: segmentationProfile || "standard",
    segmentationProfileVersion: SEGMENTATION_PROFILE_VERSION,
  };
}

export { runDmqe, computeLDLJ, computeStability, countCorrectiveEvents, detectPauses, DMQE_ENGINE_VERSION };
