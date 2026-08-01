/**
 * rotation-trajectory.js — temporal (full-sequence) rotation analysis
 * ----------------------------------------------------------------------------
 * Built as a complete, standalone module in Phase 7 (temporal aggregation
 * of rotation-estimation.js's per-frame math across an entire task
 * recording, picking a robust representative value instead of trusting one
 * arbitrary frame) but deliberately left unwired, since its only real call
 * site (shared/assessment/TaskRecorder.js) was off-limits that phase.
 *
 * PHASE 8: now INTEGRATED into TaskRecorder.js (see that file). This phase
 * explicitly asked for a decision on integration, and the technical case
 * was direct: temporal aggregation serves this phase's own "stable
 * outputs across repeated runs" and "no unrealistic spikes" acceptance
 * criteria, the analysis is pure math over already-available frame data
 * (measured latency: see scripts/verify-rotation-stability.mjs and the
 * Phase 8 final report), and the one blocking constraint from Phase 7
 * (stay hands-off on shared/assessment/*) did not carry over to this phase.
 *
 * PHASE 8 CHANGES to this file specifically:
 *  1. `representative` is now a FULL, envelope-shaped result (same
 *     {value, unit, measurementType, confidence, limitation, + enrichment
 *     fields} contract rotation-estimation.js's single-frame estimator
 *     produces) rather than four raw numbers -- required for it to be a
 *     genuine drop-in wherever a rotation envelope is expected (ASRI,
 *     Mallet grading, quality-control.js, the doctor portal all read the
 *     standard envelope shape).
 *  2. Per-frame compensation (via detectCompensation(), unmodified, only
 *     imported/called here) is now computed and passed into each frame's
 *     estimateAxialRotation() call, for full consistency with the
 *     single-frame path rather than being quietly less rigorous than it.
 *
 * WHAT IT DOES: reuses rotation-estimation.js's per-frame geometry (so the
 * math is identical to the live single-frame estimator, not a second
 * competing implementation) across an ENTIRE task recording, then picks a
 * robust REPRESENTATIVE value -- the confidence-weighted median of the
 * signed rotation over frames whose geometry was actually reliable,
 * analogous to how shared/motion/segmentation.js (Phase 3, DMQE) already
 * picks a robust peak-motion frame rather than an arbitrary one, and how
 * real clinical goniometry records a peak/representative angle across a
 * movement, not one instant.
 *
 * VISIBILITY CAVEAT: shared/motion/landmark-filter.js's filtered frames
 * do NOT carry a `.visibility` field. This module matches each filtered
 * frame back to the nearest RAW frame by timestamp to recover visibility
 * for the confidence calculation -- the same "nearest timestamp"
 * principle shared/assessment/TaskRecorder.js already uses elsewhere,
 * reimplemented locally here (not imported) so shared/biomechanics/* has
 * no dependency on shared/assessment/*.
 *
 * OPTIONAL CQI BLENDING: accepts an optional `cqiTimeline` (the same
 * shape shared/icqa/quality-timeline.js already produces) and blends it
 * into the aggregate confidence when a caller supplies one.
 * ----------------------------------------------------------------------------
 */
import { buildTrunkFrame } from "./coordinate-frame.js";
import { estimateAxialRotation, DEFAULT_CONFIG } from "./rotation-estimation.js";
import { detectCompensation } from "./compensation-detection.js";
import { makeParameter } from "./parameter-schema.js";

// Local, minimal landmark-index map (shoulder/elbow/wrist/hip only) --
// deliberately not importing shared/biomechanics/index.js's full LM to
// avoid pulling in computeParameters/computeMotion and their transitive
// deps for what only needs four index constants.
const LM = { L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16, L_HIP: 23, R_HIP: 24 };

const DEFAULT_TRAJECTORY_CONFIG = {
  ...DEFAULT_CONFIG,
  trajectory: { minFrameConfidenceScore: 0.35, minReliableFrameFraction: 0.15, cqiBlendWeight: 0.25 },
};

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}
function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** Nearest raw (pre-filter) frame's landmark array to `targetT`, used only
 *  to recover `.visibility` that filtering dropped. Returns null if no raw
 *  frames are available (visibility then falls back to
 *  config.defaultVisibilityWhenMissing inside estimateAxialRotation, same
 *  documented neutral assumption the single-frame estimator already uses). */
function nearestRawLandmarks(rawFrames, targetT) {
  let best = null;
  let bestDiff = Infinity;
  for (const f of rawFrames || []) {
    if (!f.lm) continue;
    const diff = Math.abs(f.t - targetT);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = f.lm;
    }
  }
  return best;
}

/**
 * @param {object} args
 * @param {Array<{t:number, lm:object[]|null}>} args.filteredFrames - shared/motion/landmark-filter.js's filterLandmarkSequence() output
 * @param {Array<{t:number, lm:object[]|null}>} [args.rawFrames] - the pre-filter sequence, for visibility recovery (optional but recommended)
 * @param {"left"|"right"} args.side
 * @param {{samples: Array<{tSec:number, cqi:number|null}>}|null} [args.cqiTimeline] - optional, same shape shared/icqa/quality-timeline.js produces
 * @param {object} [config] - defaults to DEFAULT_TRAJECTORY_CONFIG
 */
function analyzeRotationTrajectory({ filteredFrames, rawFrames = null, side, cqiTimeline = null, config = DEFAULT_TRAJECTORY_CONFIG }) {
  const isRight = side === "right";
  const samples = [];

  for (const f of filteredFrames || []) {
    if (!f.lm) continue;
    const shoulder = f.lm[isRight ? LM.R_SHOULDER : LM.L_SHOULDER];
    const otherShoulder = f.lm[isRight ? LM.L_SHOULDER : LM.R_SHOULDER];
    const elbow = f.lm[isRight ? LM.R_ELBOW : LM.L_ELBOW];
    const wrist = f.lm[isRight ? LM.R_WRIST : LM.L_WRIST];
    const leftShoulder = f.lm[LM.L_SHOULDER];
    const rightShoulder = f.lm[LM.R_SHOULDER];
    const leftHip = f.lm[LM.L_HIP];
    const rightHip = f.lm[LM.R_HIP];
    if (!shoulder || !elbow || !wrist || !leftShoulder || !rightShoulder || !leftHip || !rightHip) continue;

    const rawLm = nearestRawLandmarks(rawFrames, f.t);
    const withVis = (point, idx) => (rawLm && rawLm[idx] ? { ...point, visibility: rawLm[idx].visibility } : point);
    const shoulderIdx = isRight ? LM.R_SHOULDER : LM.L_SHOULDER;
    const elbowIdx = isRight ? LM.R_ELBOW : LM.L_ELBOW;
    const wristIdx = isRight ? LM.R_WRIST : LM.L_WRIST;

    const frame = buildTrunkFrame({ leftShoulder, rightShoulder, leftHip, rightHip });
    // Per-frame trunk compensation, unmodified detectCompensation() -- see
    // file header Phase 8 note #2. Uses the same (possibly visibility-
    // enriched) shoulder point for consistency with the rotation call below.
    const compensation = detectCompensation({ frame, shoulder: withVis(shoulder, shoulderIdx), otherShoulder });
    const result = estimateAxialRotation(
      { shoulder: withVis(shoulder, shoulderIdx), elbow: withVis(elbow, elbowIdx), wrist: withVis(wrist, wristIdx), frame, side, compensation },
      config
    );

    samples.push({ t: f.t, result });
  }

  if (samples.length === 0) {
    return { status: "no_frames", representative: null, samples: [], reliableFrameCount: 0, totalFrameCount: 0, reliableFrameFraction: 0, cqiContribution: null };
  }

  const compactSamples = samples.map((s) => ({
    t: s.t,
    signedRotationDeg: s.result.externalRotationDeg.signedRotationDeg,
    confidenceScore: s.result.externalRotationDeg.confidenceScore,
    measurementType: s.result.externalRotationDeg.measurementType,
  }));

  const reliable = samples.filter((s) => s.result.externalRotationDeg.measurementType !== "unavailable" && s.result.externalRotationDeg.confidenceScore >= config.trajectory.minFrameConfidenceScore);
  const reliableFrameFraction = reliable.length / samples.length;

  if (reliable.length === 0 || reliableFrameFraction < config.trajectory.minReliableFrameFraction) {
    return {
      status: "insufficient_reliable_frames",
      representative: null,
      samples: compactSamples,
      reliableFrameCount: reliable.length,
      totalFrameCount: samples.length,
      reliableFrameFraction: round2(reliableFrameFraction),
      cqiContribution: null,
    };
  }

  // Confidence-weighted MEDIAN (not mean) of the signed rotation over
  // reliable frames -- robust to a single noisy outlier frame, which a
  // plain mean would let skew the result and "just the single
  // highest-confidence frame" wouldn't protect against at all (a lone
  // spike could itself be the noise). The MEDIAN FRAME ITSELF (not just
  // its scalar value) is kept as the representative's basis, so the
  // final envelope's supportingMeasurements/reasoning reflect a real,
  // actually-computed frame rather than an interpolated one that never
  // existed.
  const sortedByValue = [...reliable].sort((a, b) => a.result.externalRotationDeg.signedRotationDeg - b.result.externalRotationDeg.signedRotationDeg);
  const medianFrame = sortedByValue[Math.floor(sortedByValue.length / 2)];
  const medianSigned = medianFrame.result.externalRotationDeg.signedRotationDeg;
  const meanConfidence = reliable.reduce((sum, r) => sum + r.result.externalRotationDeg.confidenceScore, 0) / reliable.length;

  // Data-completeness-style penalty (same principle DMQE's movementConfidencePct
  // already applies -- see shared/motion/dmqe-engine.js): a result built from
  // only a few reliable frames out of a long recording is less trustworthy
  // than the same mean confidence built from a recording that was reliable
  // throughout.
  let aggregateConfidence = clamp01(meanConfidence * reliableFrameFraction);

  let cqiContribution = null;
  if (cqiTimeline?.samples?.length) {
    const cqiValues = cqiTimeline.samples.map((s) => s.cqi).filter((v) => v != null);
    if (cqiValues.length > 0) {
      const avgCqi = cqiValues.reduce((a, b) => a + b, 0) / cqiValues.length;
      cqiContribution = round1(avgCqi);
      const w = config.trajectory.cqiBlendWeight;
      aggregateConfidence = clamp01((1 - w) * aggregateConfidence + w * (avgCqi / 100));
    }
  }

  const confidenceBucketLabel = aggregateConfidence >= config.confidenceBuckets.high ? "high" : aggregateConfidence >= config.confidenceBuckets.moderate ? "moderate" : "low";
  const externalValue = Math.max(0, medianSigned);
  const internalValue = Math.max(0, -medianSigned);
  const basisEnvelope = medianFrame.result.externalRotationDeg; // reuse its supportingMeasurements/assumptions as the representative's basis

  const limitation =
    `Temporal-aggregate estimate over ${reliable.length} of ${samples.length} recorded frames ` +
    `(${round1(reliableFrameFraction * 100)}% judged reliable) -- see the single-frame limitation for ` +
    `why this proxy is estimated, not measured: ${basisEnvelope.limitation}`;

  function buildRepresentativeEnvelope(value, direction) {
    const cqiNote = cqiContribution != null ? `average CQI ${cqiContribution} across the recording` : "CQI not supplied for this recording";
    const reasoning =
      `Temporal-aggregate estimated ${direction} rotation ${round1(value)}° (confidence-weighted median across the recording). ` +
      `• ${reliable.length}/${samples.length} frames (${round1(reliableFrameFraction * 100)}%) were reliable ` +
      `• Mean per-frame confidence ${Math.round(meanConfidence * 100)}% ` +
      `• ${cqiNote} ` +
      `• Aggregate confidence ${confidenceBucketLabel} (${Math.round(aggregateConfidence * 100)}%)`;
    return {
      ...makeParameter({ value: round1(value), unit: "deg", measurementType: "estimated", confidence: confidenceBucketLabel, limitation }),
      signedRotationDeg: round1(medianSigned),
      confidenceScore: round2(aggregateConfidence),
      trustScore: Math.round(100 * aggregateConfidence),
      landmarkReliability: basisEnvelope.landmarkReliability,
      supportingMeasurements: { ...basisEnvelope.supportingMeasurements, reliableFrameCount: reliable.length, totalFrameCount: samples.length, reliableFrameFraction: round2(reliableFrameFraction) },
      assumptions: [...basisEnvelope.assumptions, "This is a temporal aggregate (confidence-weighted median over reliable frames), not a single-frame reading -- see shared/biomechanics/rotation-trajectory.js."],
      measurementLimitations: [limitation],
      cqiContribution,
      reasoning,
    };
  }

  return {
    status: "ok",
    representative: {
      externalRotationDeg: buildRepresentativeEnvelope(externalValue, "external"),
      internalRotationDeg: buildRepresentativeEnvelope(internalValue, "internal"),
    },
    samples: compactSamples,
    reliableFrameCount: reliable.length,
    totalFrameCount: samples.length,
    reliableFrameFraction: round2(reliableFrameFraction),
    cqiContribution,
  };
}

export { analyzeRotationTrajectory, DEFAULT_TRAJECTORY_CONFIG };
