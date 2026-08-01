/**
 * asri-engine.js — ASRI Engine (Adaptive Shoulder Recovery Index) v2
 * ----------------------------------------------------------------------------
 * Full rewrite (Phase 2). Phase 1 only relocated this file (theta-engine.js
 * -> asri-engine.js) without changing its logic. This version:
 *
 *  1. Takes RAW per-task parameters as input (not pre-aggregated domain
 *     scores) -- necessary because the 5 categories below need different
 *     cross-task aggregation strategies (see aggregation-strategies.js),
 *     which a flat "one domain score per task" model couldn't express.
 *  2. Normalizes every raw value using a resolved reference dataset
 *     (reference-datasets.js), never a hard-coded target.
 *  3. Is confidence-aware: each raw parameter's (measurementType,
 *     confidence) maps to a 0-1 multiplier (config.confidenceWeights) that
 *     both down-weights its contribution to the numeric score AND factors
 *     into a separate 0-100% "Overall Confidence" figure.
 *  4. Returns a full contribution trace per category (which parameters
 *     contributed, their raw value, reference target, normalized score,
 *     weight, confidence) for explainability and reproducibility -- not
 *     just final numbers.
 *
 * Preserved from v1: the versioned/immutable config store (generalized here
 * to VersionedConfigStore, reused for both ASRI weights and reference
 * datasets), the sigmoid-blended early/late weight endpoints (phi/lerp), and
 * the principle that missing data is EXCLUDED from renormalization rather
 * than scored as zero.
 * ----------------------------------------------------------------------------
 */
import { normalizeParameter } from "./normalize-parameter.js";
import { STRATEGIES, averageAcrossTasks, bilateralComparison } from "./aggregation-strategies.js";

class VersionedConfigStore {
  constructor() {
    /** @type {Map<string, object>} version string -> immutable config object */
    this.versions = new Map();
    this.activeVersion = null;
  }

  /** Register a new, immutable config version. Refuses to overwrite an existing version. */
  publish(config) {
    if (!config.version) throw new Error("config requires a semantic version string");
    if (this.versions.has(config.version)) {
      throw new Error(`version ${config.version} already published; re-fit must produce a new version, not mutate history`);
    }
    const frozen = Object.freeze(JSON.parse(JSON.stringify(config)));
    this.versions.set(config.version, frozen);
    this.activeVersion = config.version;
    return frozen;
  }

  get(version) {
    if (!this.versions.has(version)) throw new Error(`version ${version} not found in store`);
    return this.versions.get(version);
  }

  getActive() {
    if (!this.activeVersion) throw new Error("no config has been published yet");
    return this.get(this.activeVersion);
  }

  listVersions() {
    return Array.from(this.versions.keys());
  }
}

/** Monotonic blend function phi(s): 0 at early recovery, 1 at late recovery. */
function phi(stage01, sigmoid) {
  const s = Math.min(1, Math.max(0, stage01));
  const { midpoint = 0.5, steepness = 8 } = sigmoid || {};
  return 1 / (1 + Math.exp(-steepness * (s - midpoint)));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

class AsriEngine {
  /** @param {object} config - a published, immutable asri-config.v2 object */
  constructor(config) {
    this.config = config;
  }

  effectiveCategoryWeights(stage01) {
    const t = phi(stage01, this.config.sigmoid);
    const out = {};
    for (const [cat, def] of Object.entries(this.config.categories)) {
      out[cat] = lerp(def.weight.early, def.weight.late, t);
    }
    return { weights: out, phi: t };
  }

  confidenceMultiplierFor(measurementType, confidence) {
    if (measurementType === "unavailable") return this.config.confidenceWeights.unavailable ?? 0;
    const key = `${measurementType}_${confidence}`;
    return this.config.confidenceWeights[key] ?? 0;
  }

  /** Normalize one raw parameter (from one task) into a scoring entry. */
  normalizeTaskParameter(paramDef, rawParamObject, referenceTargets) {
    if (!rawParamObject) {
      return { normalizedScore: null, confidenceMultiplier: 0, rawValue: null, measurementType: "unavailable", confidence: null, referenceTarget: null, expectedSd: null };
    }
    const targetEntry = paramDef.referenceKey ? referenceTargets[paramDef.referenceKey] : null;
    const normalizedScore = normalizeParameter({
      rawValue: rawParamObject.value,
      direction: paramDef.direction,
      target: targetEntry?.target,
      trueScore: paramDef.trueScore,
      falseScore: paramDef.falseScore,
    });
    return {
      normalizedScore,
      confidenceMultiplier: this.confidenceMultiplierFor(rawParamObject.measurementType, rawParamObject.confidence),
      rawValue: rawParamObject.value,
      measurementType: rawParamObject.measurementType,
      confidence: rawParamObject.confidence,
      referenceTarget: targetEntry?.target ?? null,
      expectedSd: targetEntry?.expectedSd ?? null,
    };
  }

  /** Within-task category score: weighted average of this category's
   *  parameters for a SINGLE task (ignores cross-task aggregation --
   *  used both for display and as a building block for Functional
   *  Performance's per-task composite). */
  perTaskCategoryScore(categoryDef, taskParams, referenceTargets) {
    let weightedSum = 0;
    let weightSum = 0;
    for (const [paramKey, paramDef] of Object.entries(categoryDef.parameters)) {
      const entry = this.normalizeTaskParameter(paramDef, taskParams[paramKey], referenceTargets);
      if (entry.normalizedScore == null) continue;
      const w = paramDef.weight * entry.confidenceMultiplier;
      weightedSum += w * entry.normalizedScore;
      weightSum += w;
    }
    return weightSum > 0 ? weightedSum / weightSum : null;
  }

  /** ROM / Movement Quality / Compensation: aggregate each parameter across
   *  tasks via the category's configured strategy, then combine parameters
   *  within the category by confidence-weighted average. */
  scoreStandardCategory(categoryDef, perTaskParameters, referenceTargets) {
    const strategy = STRATEGIES[categoryDef.aggregation];
    const contributions = [];
    let weightedSum = 0;
    let weightSum = 0;
    let confWeightedSum = 0;
    let confWeightSum = 0;

    for (const [paramKey, paramDef] of Object.entries(categoryDef.parameters)) {
      const perTaskEntries = Object.entries(perTaskParameters).map(([taskId, taskParams]) => ({
        taskId,
        ...this.normalizeTaskParameter(paramDef, taskParams[paramKey], referenceTargets),
      }));
      const agg = strategy(perTaskEntries);
      if (agg.score == null) continue; // not captured in any task -- excluded, not zeroed

      const effectiveWeight = paramDef.weight * agg.confidenceMultiplier;
      weightedSum += effectiveWeight * agg.score;
      weightSum += effectiveWeight;
      confWeightedSum += paramDef.weight * agg.confidenceMultiplier;
      confWeightSum += paramDef.weight;

      const source = perTaskEntries.find((e) => e.taskId === agg.sourceTaskId) || perTaskEntries[0];
      contributions.push({
        parameter: paramKey,
        rawValue: source.rawValue,
        referenceTarget: source.referenceTarget,
        normalizedScore: round1(agg.score),
        configWeight: paramDef.weight,
        confidenceMultiplier: round2(agg.confidenceMultiplier),
        effectiveWeight: round2(effectiveWeight),
        measurementType: source.measurementType,
        confidence: source.confidence,
        sourceTaskId: agg.sourceTaskId,
        expectedSd: source.expectedSd,
      });
    }

    if (weightSum === 0) {
      return { score: null, confidencePct: null, expectedSd: null, status: "insufficient_data", contributions };
    }
    const expectedSdAvg =
      contributions.reduce((sum, c) => sum + (c.expectedSd ?? 15) * c.configWeight, 0) /
      (contributions.reduce((sum, c) => sum + c.configWeight, 0) || 1);
    return {
      score: round1(weightedSum / weightSum),
      confidencePct: Math.round(100 * (confWeightSum > 0 ? confWeightedSum / confWeightSum : 0)),
      expectedSd: expectedSdAvg,
      contributions,
    };
  }

  /** Functional Tasks: per-task composite of (ROM + Movement Quality +
   *  Compensation) for THAT task, averaged across the 4 tasks -- reflects
   *  whether the child can actually perform the daily-living movement, not
   *  just isolated peak joint ROM. */
  scoreFunctionalPerformance(categoryDef, categoriesConfig, perTaskParameters, referenceTargets) {
    const { rom: romW, movementQuality: mqW, compensation: compW } = categoryDef.compositeWeights;
    const perTaskEntries = [];
    const contributions = [];

    for (const [taskId, taskParams] of Object.entries(perTaskParameters)) {
      const romScore = this.perTaskCategoryScore(categoriesConfig.rom, taskParams, referenceTargets);
      const mqScore = this.perTaskCategoryScore(categoriesConfig.movementQuality, taskParams, referenceTargets);
      const compScore = this.perTaskCategoryScore(categoriesConfig.compensation, taskParams, referenceTargets);
      const parts = [
        romScore != null ? { score: romScore, weight: romW } : null,
        mqScore != null ? { score: mqScore, weight: mqW } : null,
        compScore != null ? { score: compScore, weight: compW } : null,
      ].filter(Boolean);
      if (parts.length === 0) continue;

      const wSum = parts.reduce((s, p) => s + p.weight, 0);
      const composite = parts.reduce((s, p) => s + p.weight * p.score, 0) / wSum;
      perTaskEntries.push({ normalizedScore: composite, confidenceMultiplier: 1, taskId });
      contributions.push({ taskId, compositeScore: round1(composite), romScore: romScore != null ? round1(romScore) : null, movementQualityScore: mqScore != null ? round1(mqScore) : null, compensationScore: compScore != null ? round1(compScore) : null });
    }

    const agg = averageAcrossTasks(perTaskEntries);
    if (agg.score == null) return { score: null, confidencePct: null, expectedSd: 15, status: "insufficient_data", contributions };
    return { score: round1(agg.score), confidencePct: Math.round(100 * agg.confidenceMultiplier), expectedSd: 15, contributions };
  }

  scoreSymmetry(bilateralEntries) {
    const result = bilateralComparison(bilateralEntries);
    if (result.status === "insufficient_data") {
      return { score: null, confidencePct: null, expectedSd: 15, status: "insufficient_data", note: result.note, contributions: [] };
    }
    return { score: round1(result.score), confidencePct: Math.round(100 * (result.confidenceMultiplier ?? 1)), expectedSd: 15, contributions: [] };
  }

  /**
   * Compute the full ASRI result for a session.
   * @param {object} args
   * @param {object} args.perTaskParameters - {taskId: {paramKey: {value, measurementType, confidence, ...}}}
   * @param {object} args.referenceTargets - resolved via reference-datasets.js: {paramKey: {target, expectedSd}}
   * @param {number} args.stage01 - recovery stage in [0,1]
   * @param {object} [args.bilateralEntries] - {tested, untested} raw ROM values, once bilateral capture exists
   */
  score({ perTaskParameters, referenceTargets, stage01, bilateralEntries = null }) {
    const { weights, phi: phiVal } = this.effectiveCategoryWeights(stage01);
    const categoriesConfig = this.config.categories;

    const results = {
      rom: this.scoreStandardCategory(categoriesConfig.rom, perTaskParameters, referenceTargets),
      movementQuality: this.scoreStandardCategory(categoriesConfig.movementQuality, perTaskParameters, referenceTargets),
      compensation: this.scoreStandardCategory(categoriesConfig.compensation, perTaskParameters, referenceTargets),
      symmetry: this.scoreSymmetry(bilateralEntries),
      functionalPerformance: this.scoreFunctionalPerformance(categoriesConfig.functionalPerformance, categoriesConfig, perTaskParameters, referenceTargets),
    };
    for (const [cat, def] of Object.entries(categoriesConfig)) {
      results[cat].label = def.label;
    }

    const captured = Object.entries(results).filter(([, r]) => r.score != null);
    const totalCategories = Object.keys(categoriesConfig).length;

    if (captured.length === 0) {
      return { composite: null, overallConfidencePct: 0, completeness: 0, asriVersion: this.config.version, phi: phiVal, confidenceInterval: null, categories: results, detail: "no categories captured this session" };
    }

    const weightSumPresent = captured.reduce((sum, [cat]) => sum + (weights[cat] ?? 0), 0);
    let composite = 0;
    let confWeighted = 0;
    for (const [cat, r] of captured) {
      const wRaw = weights[cat] ?? 0;
      const wNorm = weightSumPresent > 0 ? wRaw / weightSumPresent : 0;
      composite += wNorm * r.score;
      confWeighted += wNorm * (r.confidencePct ?? 0);
      results[cat].weight = round2(wNorm);
    }
    for (const [cat] of Object.entries(results)) {
      if (!captured.find(([c]) => c === cat)) results[cat].weight = 0;
    }

    const completeness = captured.length / totalCategories;
    const overallConfidencePct = Math.round(confWeighted * completeness);

    // Statistical CI, same mechanism as v1 but pooled over categories instead of the old flat 9 domains.
    const conf = this.config.confidence || { z: 1.96, kVariance: 1, kCompleteness: 12 };
    const pooledVariance = captured.reduce((sum, [cat, r]) => {
      const wNorm = results[cat].weight;
      const sd = r.expectedSd ?? 15;
      return sum + wNorm * wNorm * sd * sd;
    }, 0);
    const varianceTerm = (conf.kVariance * Math.sqrt(pooledVariance)) / Math.sqrt(captured.length);
    const completenessPenalty = conf.kCompleteness * (1 - completeness);
    const margin = conf.z * varianceTerm + completenessPenalty;

    return {
      composite: round1(composite),
      overallConfidencePct,
      completeness: round2(completeness),
      asriVersion: this.config.version,
      phi: round2(phiVal),
      confidenceInterval: {
        low: round1(composite - margin),
        high: round1(composite + margin),
        margin: round1(margin),
      },
      categories: results,
    };
  }
}

export { VersionedConfigStore, AsriEngine, phi };
