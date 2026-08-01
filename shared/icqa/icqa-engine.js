/**
 * icqa-engine.js — ICQA Engine (Capture Quality Index)
 * ----------------------------------------------------------------------------
 * Combines the four raw analyzers (camera-geometry.js, frame-quality.js,
 * visibility-analysis.js, tracking-stability.js) into 8 named 0-100
 * subscores and a single confidence-weighted composite "Capture Quality
 * Index" (CQI). Deliberately mirrors shared/asri/asri-engine.js's shape --
 * `effectiveWeight = configWeight * confidenceMultiplier`, a full
 * contribution trace, missing data EXCLUDED from renormalization rather than
 * scored as zero -- because that pattern already proved itself for ASRI
 * (Phase 2) and DMQE (Phase 3), not because this module imports either of
 * them (it imports neither -- see docs/icqa.md independence guarantee).
 *
 * The 8 subscores (spec-named): Camera Position, Lighting, Body Visibility,
 * Pose Readiness, Background Quality, Tracking Stability, Occlusion Score,
 * Movement Readiness. Each is built from one or more "components" (a raw
 * analyzer output converted to a 0-100 score via a documented threshold
 * function), combined by a confidence-weighted average -- an
 * `estimated_low` component pulls the subscore towards the other
 * components rather than being weighted equally with a `measured_high` one.
 *
 * ALL numeric thresholds live in config/icqa-config.v1.json, never inline
 * here -- this file only contains the shape of the scoring functions
 * (band/floor/ceiling), not their cutoff values.
 * ----------------------------------------------------------------------------
 */

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

/** Score is 100 within [0, idealMax], falls linearly to 0 at hardMax, and is
 *  0 beyond it. Used for "smaller absolute deviation is better, up to a
 *  point" signals (tilt, roll, height-angle deviation). */
function scoreBand(absValue, idealMax, hardMax) {
  if (absValue == null) return null;
  const v = Math.abs(absValue);
  if (v <= idealMax) return 100;
  if (v >= hardMax) return 0;
  return Math.round(100 * (1 - (v - idealMax) / (hardMax - idealMax)));
}

/** Score is 100 at/below idealMax, falls linearly to 0 at hardMax. Used for
 *  "lower is better" signals (jitter, edge density, exposure fractions). */
function scoreCeiling(value, idealMax, hardMax) {
  if (value == null) return null;
  if (value <= idealMax) return 100;
  if (value >= hardMax) return 0;
  return Math.round(100 * (1 - (value - idealMax) / (hardMax - idealMax)));
}

/** Score is 100 at/above idealMin, falls linearly to 0 at hardMin. Used for
 *  "higher is better" signals (sharpness). */
function scoreFloor(value, idealMin, hardMin) {
  if (value == null) return null;
  if (value >= idealMin) return 100;
  if (value <= hardMin) return 0;
  return Math.round(100 * (value - hardMin) / (idealMin - hardMin));
}

/** Score is 100 inside [min, max], falls linearly to 0 at the respective
 *  hard bound outside it. Used for "there's an ideal middle range" signals
 *  (mean luminance -- too dark AND too bright both hurt). */
function scoreRange(value, min, max, hardMin, hardMax) {
  if (value == null) return null;
  if (value >= min && value <= max) return 100;
  if (value < min) return value <= hardMin ? 0 : Math.round(100 * (value - hardMin) / (min - hardMin));
  return value >= hardMax ? 0 : Math.round(100 * (hardMax - value) / (hardMax - max));
}

class IcqaEngine {
  /** @param {object} config - a published, immutable icqa-config.v1 object */
  constructor(config) {
    this.config = config;
  }

  confidenceMultiplierFor(measurementType, confidence) {
    if (measurementType === "unavailable") return this.config.confidenceWeights.unavailable ?? 0;
    const key = `${measurementType}_${confidence}`;
    return this.config.confidenceWeights[key] ?? 0;
  }

  /** Combine a list of {score, measurementType, confidence} components into
   *  one subscore via confidence-weighted average. Components with score
   *  null (their underlying value was unavailable) are excluded, not
   *  scored as zero -- same "missing != failing" principle as ASRI.
   *
   *  `worstCaseBlend` (0-1, default 0) mixes the single lowest-scoring
   *  component into the result alongside the weighted average. A plain
   *  average is the right combination for "quality gradations" that trade
   *  off against each other (tilt vs. roll vs. distance all being slightly
   *  off is a worse camera position than one being noticeably off) -- but
   *  it's the WRONG combination for structural completeness checks, where
   *  one entirely-missing required part (e.g. feet completely out of
   *  frame) should not be diluted into invisibility by five other parts
   *  that happen to be fine. Body Visibility uses a non-zero blend for
   *  exactly this reason (see score() below); everything else defaults to
   *  a plain average. */
  combineComponents(components, { worstCaseBlend = 0 } = {}) {
    let weightedSum = 0;
    let weightSum = 0;
    let confWeightedSum = 0;
    let confWeightSum = 0;
    let worstScore = null;
    const contributions = [];
    for (const c of components) {
      const confidenceMultiplier = this.confidenceMultiplierFor(c.measurementType, c.confidence);
      contributions.push({ label: c.label, rawScore: c.score == null ? null : round1(c.score), measurementType: c.measurementType, confidence: c.confidence, confidenceMultiplier: round1(confidenceMultiplier) });
      if (c.score == null) continue;
      const w = (c.weight ?? 1) * confidenceMultiplier;
      weightedSum += w * c.score;
      weightSum += w;
      confWeightedSum += (c.weight ?? 1) * confidenceMultiplier;
      confWeightSum += c.weight ?? 1;
      if (worstScore == null || c.score < worstScore) worstScore = c.score;
    }
    if (weightSum === 0) return { score: null, confidencePct: 0, contributions, status: "insufficient_data" };
    const average = weightedSum / weightSum;
    const blended = worstCaseBlend > 0 && worstScore != null ? (1 - worstCaseBlend) * average + worstCaseBlend * worstScore : average;
    return { score: round1(blended), confidencePct: Math.round(100 * (confWeightSum > 0 ? confWeightedSum / confWeightSum : 0)), contributions };
  }

  /**
   * @param {object} args
   * @param {object} args.geometry - output of camera-geometry.js's analyzeCameraGeometry()
   * @param {object} args.frameQuality - output of frame-quality.js's analyzeFrameQuality()
   * @param {object} args.visibility - output of visibility-analysis.js's analyzeVisibility()
   * @param {object} args.stability - output of tracking-stability.js's analyzeStability()
   */
  score({ geometry, frameQuality, visibility, stability }) {
    const cg = this.config.cameraGeometry;
    const fq = this.config.frameQuality;
    const st = this.config.stability;

    const subscoreResults = {};

    // --- Camera Position --------------------------------------------------
    subscoreResults.cameraPosition = this.combineComponents([
      { label: "tilt", score: scoreBand(geometry.tilt.value, cg.tiltIdealMaxDeg, cg.tiltHardMaxDeg), measurementType: geometry.tilt.measurementType, confidence: geometry.tilt.confidence },
      { label: "roll", score: scoreBand(geometry.roll.value, cg.rollIdealMaxDeg, cg.rollHardMaxDeg), measurementType: geometry.roll.measurementType, confidence: geometry.roll.confidence },
      { label: "distance", score: geometry.distanceCategory.value == null ? null : geometry.distanceCategory.value === "ideal" ? 100 : 35, measurementType: geometry.distanceCategory.measurementType, confidence: geometry.distanceCategory.confidence },
      { label: "framing", score: this._framingScore(geometry.framing), measurementType: geometry.framing.centeredness.measurementType, confidence: geometry.framing.centeredness.confidence },
      { label: "heightAngle", score: scoreBand(geometry.heightAngleProxy.value, cg.heightAngleIdealMaxDeviation, cg.heightAngleHardMaxDeviation), measurementType: geometry.heightAngleProxy.measurementType, confidence: geometry.heightAngleProxy.confidence },
    ]);

    // --- Lighting ------------------------------------------------------------
    subscoreResults.lighting = this.combineComponents([
      { label: "meanLuminance", score: scoreRange(frameQuality.lighting.meanLuminance.value, fq.lighting.meanMin, fq.lighting.meanMax, fq.lighting.meanHardMin, fq.lighting.meanHardMax), measurementType: frameQuality.lighting.meanLuminance.measurementType, confidence: frameQuality.lighting.meanLuminance.confidence },
      { label: "overExposure", score: scoreCeiling(frameQuality.lighting.overExposedFraction.value, fq.lighting.overExposedMaxFraction, fq.lighting.overExposedHardMaxFraction), measurementType: frameQuality.lighting.overExposedFraction.measurementType, confidence: frameQuality.lighting.overExposedFraction.confidence },
      { label: "underExposure", score: scoreCeiling(frameQuality.lighting.underExposedFraction.value, fq.lighting.underExposedMaxFraction, fq.lighting.underExposedHardMaxFraction), measurementType: frameQuality.lighting.underExposedFraction.measurementType, confidence: frameQuality.lighting.underExposedFraction.confidence },
      { label: "contrast", score: scoreFloor(frameQuality.lighting.contrast.value, fq.lighting.minContrast, fq.lighting.hardMinContrast), measurementType: frameQuality.lighting.contrast.measurementType, confidence: frameQuality.lighting.contrast.confidence },
      { label: "sharpness", score: scoreFloor(frameQuality.sharpness.value, fq.sharpness.minLaplacianVariance, fq.sharpness.hardMinLaplacianVariance), measurementType: frameQuality.sharpness.measurementType, confidence: frameQuality.sharpness.confidence },
    ]);

    // --- Body Visibility (also folds in multi-person detection: a second
    // person in frame is a body-visibility problem for THIS patient's
    // measurement just as much as a missing limb is, and gating on it here
    // keeps recording-gate.js purely subscore-driven rather than needing its
    // own special-cased raw-signal check) ---------------------------------
    subscoreResults.bodyVisibility = this.combineComponents(
      [
        ...Object.entries(visibility.bodyParts).map(([part, p]) => ({ label: part, score: p.value == null ? null : p.value * 100, measurementType: p.measurementType, confidence: p.confidence })),
        { label: "singlePerson", score: visibility.multiPerson.value == null ? null : visibility.multiPerson.value === true ? 0 : 100, measurementType: visibility.multiPerson.measurementType, confidence: visibility.multiPerson.confidence },
      ],
      { worstCaseBlend: 0.6 } // a single entirely-missing required body part (or a second person in frame) must not be averaged away by five fine ones -- see combineComponents() doc.
    );

    // --- Pose Readiness (detection consistency, distinct from per-frame completeness above) ---
    subscoreResults.poseReadiness = this.combineComponents([
      { label: "detectionRate", score: stability.detectionRate.value == null ? null : stability.detectionRate.value * 100, measurementType: stability.detectionRate.measurementType, confidence: stability.detectionRate.confidence },
    ]);

    // --- Background Quality --------------------------------------------------
    subscoreResults.backgroundQuality = this.combineComponents([
      { label: "edgeDensity", score: scoreCeiling(frameQuality.backgroundComplexity.value, fq.background.maxEdgeDensity, fq.background.hardMaxEdgeDensity), measurementType: frameQuality.backgroundComplexity.measurementType, confidence: frameQuality.backgroundComplexity.confidence },
    ]);

    // --- Tracking Stability (full check-window jitter) -----------------------
    subscoreResults.trackingStability = this.combineComponents([
      { label: "jitter", score: scoreCeiling(stability.jitter.value, st.maxJitter, st.hardMaxJitter), measurementType: stability.jitter.measurementType, confidence: stability.jitter.confidence },
    ]);

    // --- Occlusion Score (worst-case body-part visibility, not the average used by Body Visibility) ---
    subscoreResults.occlusionScore = this.combineComponents([
      { label: "occludedPartCount", score: Math.max(0, 100 - visibility.occludedParts.length * 20), measurementType: visibility.occlusion.measurementType, confidence: visibility.occlusion.confidence },
    ]);

    // --- Movement Readiness (recent-window jitter -- "is the subject still right now") ---
    subscoreResults.movementReadiness = this.combineComponents([
      { label: "recentJitter", score: scoreCeiling(stability.recentJitter.value, st.maxJitter, st.hardMaxJitter), measurementType: stability.recentJitter.measurementType, confidence: stability.recentJitter.confidence },
    ]);

    return this._composite(subscoreResults);
  }

  _framingScore(framing) {
    if (framing.centeredness.value == null) return null;
    let score = framing.centeredness.value * 100;
    for (const edge of ["touchesTopEdge", "touchesBottomEdge", "touchesLeftEdge", "touchesRightEdge"]) {
      if (framing[edge]) score -= 15;
    }
    return Math.max(0, Math.min(100, score));
  }

  _composite(subscoreResults) {
    const captured = Object.entries(subscoreResults).filter(([, r]) => r.score != null);
    const totalSubscores = Object.keys(this.config.subscores).length;

    const subscores = {};
    for (const [key, def] of Object.entries(this.config.subscores)) {
      const r = subscoreResults[key];
      subscores[key] = { label: def.label, score: r.score, confidencePct: r.confidencePct, configWeight: def.weight, contributions: r.contributions, status: r.status ?? undefined };
    }

    if (captured.length === 0) {
      return { cqi: null, overallConfidencePct: 0, completeness: 0, icqaVersion: this.config.version, subscores, detail: "no capture-quality signals available" };
    }

    const weightSumPresent = captured.reduce((sum, [key]) => sum + (this.config.subscores[key]?.weight ?? 0), 0);
    let cqi = 0;
    let confWeighted = 0;
    for (const [key, r] of captured) {
      const wRaw = this.config.subscores[key]?.weight ?? 0;
      const wNorm = weightSumPresent > 0 ? wRaw / weightSumPresent : 0;
      cqi += wNorm * r.score;
      confWeighted += wNorm * (r.confidencePct ?? 0);
      subscores[key].effectiveWeight = round1(wNorm);
    }
    for (const key of Object.keys(subscores)) {
      if (subscores[key].effectiveWeight == null) subscores[key].effectiveWeight = 0;
    }

    const completeness = captured.length / totalSubscores;
    const overallConfidencePct = Math.round(confWeighted * completeness);

    return {
      cqi: round1(cqi),
      overallConfidencePct,
      completeness: Math.round(completeness * 100) / 100,
      icqaVersion: this.config.version,
      subscores,
    };
  }
}

export { IcqaEngine, scoreBand, scoreCeiling, scoreFloor, scoreRange };
