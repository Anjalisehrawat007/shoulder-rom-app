/**
 * TaskRecorder.js — pure per-task capture pipeline
 * ----------------------------------------------------------------------------
 * Extracted from capture/app.js's runCurrentTask() body (the part AFTER the
 * recording window closes) -- same logic, zero DOM access, so it's testable
 * in Node with synthetic frames (see scripts/verify-mallet-score.mjs) and
 * reusable independent of the browser UI layer.
 *
 * This file DOES import shared/motion/* (DMQE, the landmark filter) -- that
 * is orchestration/integration, not a redesign of DMQE, exactly the same
 * relationship capture/app.js's existing runCurrentTask() already has with
 * shared/motion/*. The constraint this phase actually holds to (see
 * docs/mallet-score.md) is: shared/motion/* is never MODIFIED, and nothing
 * in shared/motion/*, shared/asri/*, shared/validation/*, shared/icqa/*, or
 * shared/biomechanics/* ever imports FROM shared/assessment/* (checked by
 * grep, the same independence-verification style Phase 5 used for ICQA).
 * shared/assessment/ModifiedMalletScoreEngine.js specifically has zero
 * imports from any of those five -- THAT module is the "completely
 * independent" grading engine the spec asked for; this orchestration file
 * is not required to be, any more than capture/app.js itself is.
 * ----------------------------------------------------------------------------
 */
import { filterLandmarkSequence, FILTER_VERSION } from "../motion/landmark-filter.js";
import { runDmqe, DMQE_ENGINE_VERSION } from "../motion/dmqe-engine.js";
import { LM } from "../biomechanics/index.js";
import { analyzeRotationTrajectory } from "../biomechanics/rotation-trajectory.js";
import { computeElbowFlexionDeg, computeReachSuccess, computeVertebralLevelProxy, computeCompletionTimeSec } from "./mallet-measurements.js";

// MediaPipe BlazePose ear indices -- not present in shared/biomechanics/index.js's
// LM (which only names the ~10 landmarks the Biomechanical Engine itself
// needs). Defined locally rather than importing shared/icqa/landmark-groups.js's
// LM_FULL, so shared/assessment/* has zero import surface touching shared/icqa/*
// at all, even for pure data.
const EAR = { L: 7, R: 8 };

function pickPeakFrame(collected, filtered, dmqe) {
  if (dmqe.status === "ok") {
    const peakT = filtered[dmqe.segmentation.peakMotion].t;
    return collected.reduce((best, c) => (Math.abs(c.t - peakT) < Math.abs(best.t - peakT) ? c : best));
  }
  return collected.reduce((best, c) =>
    c.params.shoulderElevationDeg.value > best.params.shoulderElevationDeg.value ? c : best
  );
}

/** Nearest filtered-sequence landmark set to a given timestamp -- the
 *  filtered sequence may be reconstructed/smoothed at points collectFrame()
 *  never directly saw, so this is a best-match lookup, same "nearest
 *  timestamp" principle capture/app.js's own peak-frame matching already uses. */
function landmarksNear(filtered, targetT) {
  let best = null;
  let bestDiff = Infinity;
  for (const f of filtered) {
    const diff = Math.abs(f.t - targetT);
    if (diff < bestDiff && f.lm) {
      bestDiff = diff;
      best = f.lm;
    }
  }
  return best;
}

/**
 * @param {object} args
 * @param {object} args.task - a TaskDefinitions.js entry
 * @param {"left"|"right"} args.side
 * @param {Array<{t:number, lm:object[]|null}>} args.rawFrames - poseEngine.getTaskHistory()
 * @param {Array<{t:number, params:object}>} args.collected - state.taskCollected (live biomechanics per frame)
 * @param {object|null} args.icqaResult - the pre-task gate's IcqaEngine.score() result (already computed by
 *   capture/app.js's existing, unchanged ICQA flow -- this file doesn't recompute it)
 * @param {import("./ModifiedMalletScoreEngine.js").ModifiedMalletScoreEngine} args.malletScoreEngine
 * @param {object} args.malletProxyConfig - config.measurementProxies from mallet-score-config.v1.json
 * @param {object|null} [args.cqiTimeline] - Phase 8: the finalized ICQA Quality Timeline for this task
 *   (cameraQuality.timeline, same shape shared/icqa/quality-timeline.js produces), optional. When
 *   supplied, feeds the temporal rotation analysis's CQI confidence factor -- see
 *   shared/biomechanics/rotation-trajectory.js. Omitting it degrades gracefully (that factor is
 *   simply excluded from confidence, not treated as zero).
 */
function recordTask({ task, side, rawFrames, collected, icqaResult, malletScoreEngine, malletProxyConfig, cqiTimeline = null }) {
  if (!collected || collected.length === 0) {
    return { status: "no_pose_detected" };
  }

  const isRight = side === "right";
  const filtered = filterLandmarkSequence(rawFrames);
  // Segmentation thresholds are selected per task class, not per call site:
  // the rotation/spine tasks move the wrist on a ~2x smaller radius than the
  // shoulder-sweep tasks, so a single linear-speed floor cannot serve both.
  // Tasks without the field fall through to the "standard" profile, i.e. the
  // historical thresholds. Only movement DETECTION is affected; no DMQE
  // scoring mathematics reads this.
  const dmqe = runDmqe(filtered, side, rawFrames, { segmentationProfile: task.segmentationProfile });

  // Phase 8: full-sequence rotation analysis, integrated after being built
  // as a standalone module in Phase 7 -- see rotation-trajectory.js's file
  // header for the integration decision and rationale. Falls back cleanly
  // to the existing single-frame peak-frame value (below, via `peak.params`)
  // whenever the trajectory doesn't have enough reliable frames -- this
  // NEVER makes a task result worse than it would have been without this
  // integration, only better when there's enough data to be better.
  const rotationTrajectory = analyzeRotationTrajectory({ filteredFrames: filtered, rawFrames, side, cqiTimeline });

  const peak = pickPeakFrame(collected, filtered, dmqe);
  const mid = collected[Math.floor(collected.length / 2)];
  const peakLm = landmarksNear(filtered, peak.t);

  const shoulder = peakLm?.[isRight ? LM.R_SHOULDER : LM.L_SHOULDER] ?? null;
  const elbow = peakLm?.[isRight ? LM.R_ELBOW : LM.L_ELBOW] ?? null;
  const wrist = peakLm?.[isRight ? LM.R_WRIST : LM.L_WRIST] ?? null;
  const hip = peakLm?.[isRight ? LM.R_HIP : LM.L_HIP] ?? null;
  const ear = peakLm?.[isRight ? EAR.R : EAR.L] ?? null;

  const motion =
    dmqe.status === "ok"
      ? { movementSmoothness: dmqe.domains.smoothness, movementSpeed: dmqe.domains.peakWristSpeed }
      : {};

  const malletMeasurements = {
    elbowFlexionDeg: computeElbowFlexionDeg({ shoulder, elbow, wrist }),
    reachSuccess: computeReachSuccess({ wrist, shoulder, ear }, malletProxyConfig),
    vertebralLevelProxy: computeVertebralLevelProxy({ wrist, shoulder, hip }, malletProxyConfig),
    completionTimeSec: computeCompletionTimeSec(filtered, dmqe.status === "ok" ? dmqe.segmentation : null),
  };

  // shoulderExtensionDeg (Hand to Spine's supporting measurement): the existing
  // engine has no distinct "extension" output -- flexionDeg's sign convention
  // doesn't separate flexion from extension (see biomechanics.md). Rather than
  // inventing a new biomechanics computation (forbidden this phase), this is
  // explicitly left unavailable with a stated reason -- honest, not silently
  // substituted with the wrong-signed value.
  malletMeasurements.shoulderExtensionDeg = {
    value: null, unit: "deg", measurementType: "unavailable", confidence: null,
    limitation: "The existing biomechanical engine's flexionDeg is an unsigned angle from the rest position and does not distinguish flexion from extension (see docs/biomechanics.md) -- computing a true signed extension angle would require a biomechanics change, out of scope for this integration phase.",
  };

  const parameters = { ...peak.params, ...motion };

  // Phase 8: prefer the temporally-aggregated rotation estimate (more
  // stable across the whole recording, per this phase's own acceptance
  // criteria) over the single peak-frame value, whenever the trajectory
  // analysis found enough reliable frames to trust. Same envelope shape
  // either way (see rotation-trajectory.js) -- ASRI/Mallet grading/QC/the
  // doctor portal don't need to know or care which source produced it.
  const rotationSource = rotationTrajectory.status === "ok" ? "trajectory" : "single_frame";
  if (rotationTrajectory.status === "ok") {
    parameters.externalRotationDeg = rotationTrajectory.representative.externalRotationDeg;
    parameters.internalRotationDeg = rotationTrajectory.representative.internalRotationDeg;
  }

  const measurementsForGrading = { ...parameters, ...malletMeasurements };

  const malletGrade = malletScoreEngine.score({
    taskId: task.id,
    malletCategory: task.malletCategory,
    measurements: measurementsForGrading,
    dmqeResult: dmqe.status === "ok" ? dmqe : null,
    cqiResult: icqaResult || null,
  });

  const motionAnalysis =
    dmqe.status === "ok"
      ? { status: dmqe.status, dmqeScore: dmqe.dmqeScore, movementConfidencePct: dmqe.movementConfidencePct, segmentation: dmqe.segmentation, domains: dmqe.domains, contributions: dmqe.contributions, dmqeVersion: DMQE_ENGINE_VERSION, filterVersion: FILTER_VERSION, segmentationProfile: dmqe.segmentationProfile, segmentationProfileVersion: dmqe.segmentationProfileVersion }
      : { status: dmqe.status, dmqeVersion: DMQE_ENGINE_VERSION, filterVersion: FILTER_VERSION, segmentationProfile: dmqe.segmentationProfile, segmentationProfileVersion: dmqe.segmentationProfileVersion };

  return {
    status: "ok",
    parameters,
    malletMeasurements,
    motionAnalysis,
    malletGrade,
    peakFrameT: peak.t,
    midFrameT: mid.t,
    peakParameters: peak.params,
    midParameters: mid.params,
    rawFrames,
    filteredFrames: filtered,
    // Phase 8: transparency marker, not consumed by any grading/scoring
    // logic -- lets a future doctor-portal/report surface which source
    // produced this task's rotation values, without requiring one.
    rotationEstimation: { source: rotationSource, reliableFrameFraction: rotationTrajectory.reliableFrameFraction ?? null, totalFrameCount: rotationTrajectory.totalFrameCount ?? null },
  };
}

export { recordTask };
