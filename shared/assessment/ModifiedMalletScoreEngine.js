/**
 * ModifiedMalletScoreEngine.js — AI-Assisted Modified Mallet Score Engine
 * ----------------------------------------------------------------------------
 * Fully independent module: does not import from shared/asri/*,
 * shared/motion/*, shared/validation/*, or shared/icqa/* (verified by grep,
 * same discipline as every prior phase's independence guarantee). It
 * CONSUMES their output (raw measurements, a DMQE result, an ICQA/CQI
 * result) as plain arguments -- it never reaches into those modules itself.
 *
 * Mirrors the architectural shape shared/asri/asri-engine.js and
 * shared/icqa/icqa-engine.js already established for this project: a
 * versioned, externally-editable config (nothing hard-coded here), a
 * confidence-weighted blend with missing components EXCLUDED from
 * renormalization rather than scored as zero, and a full contribution/
 * reasoning trace for explainability -- reused BY PRINCIPLE, not by
 * import, exactly like ICQA's engine was built independently of ASRI's in
 * Phase 5.
 *
 * GRADING ALGORITHM: each Mallet category (config/mallet-score-config.v1.json
 * `tasks.<category>`) defines an ORDERED list of `gradingRules`, evaluated
 * from grade V down to II -- the first rule whose ALL conditions are met
 * wins; if none match, `fallbackGrade` (always "I") applies. This is a
 * general condition-list evaluator, not a single-value threshold lookup,
 * because the published Mallet criteria for Hand to Neck/Spine/Mouth are
 * multi-factor (reach + how much compensation it took), not a single
 * angle band -- see the config file's per-task `citation` fields for how
 * each was operationalized from Bae et al. 2003's qualitative descriptions.
 *
 * NEVER FABRICATES A GRADE: if a task's configured `primaryMeasurementKey`
 * is `unavailable`, this returns `grade: null, status: "insufficient_data"`
 * with a stated reason -- the same principle ASRI's `insufficient_data`
 * categories and DMQE's `no_movement_detected` status already established.
 * ----------------------------------------------------------------------------
 */

const GRADE_ORDER = ["I", "II", "III", "IV", "V"];
const GRADE_NUMERIC = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

/** Normalizes either a full {value, measurementType, confidence, limitation}
 *  envelope (from makeParameter) or a bare value (e.g. compensation-
 *  detection.js's trunkCompensationFlag, which is a plain boolean, not
 *  enveloped) into one shape this engine can reason about uniformly. A bare
 *  value is treated as measured/high -- it came from a deterministic
 *  computation on already-measured inputs, not an independent proxy. */
function resolveValue(measurements, key) {
  const raw = measurements ? measurements[key] : undefined;
  if (raw == null) return { value: null, measurementType: "unavailable", confidence: null, limitation: "" };
  if (typeof raw === "object" && "value" in raw && "measurementType" in raw) {
    return { value: raw.value, measurementType: raw.measurementType, confidence: raw.confidence, limitation: raw.limitation || "" };
  }
  return { value: raw, measurementType: "measured", confidence: "high", limitation: "" };
}

function evalCondition(cond, measurements) {
  const { value } = resolveValue(measurements, cond.key);
  if (value == null) return false; // missing data never satisfies a condition -- falls through toward the fallback grade
  switch (cond.op) {
    case ">=": return value >= cond.value;
    case ">": return value > cond.value;
    case "<=": return value <= cond.value;
    case "<": return value < cond.value;
    case "==": return value === cond.value;
    default: throw new Error(`ModifiedMalletScoreEngine: unknown condition operator "${cond.op}"`);
  }
}

function determineGrade(taskConfig, measurements) {
  for (const rule of taskConfig.gradingRules) {
    if (rule.conditions.every((c) => evalCondition(c, measurements))) {
      return { grade: rule.grade, matchedRule: rule };
    }
  }
  return { grade: taskConfig.fallbackGrade, matchedRule: null };
}

function applyCompensationDemotion(grade, taskConfig, measurements) {
  const demotion = taskConfig.compensationDemotion;
  if (!demotion) return { grade, demoted: false };
  const { value: flagged } = resolveValue(measurements, demotion.flagKey);
  if (!flagged) return { grade, demoted: false };
  const gradeIdx = GRADE_ORDER.indexOf(grade);
  const minIdx = GRADE_ORDER.indexOf(demotion.onlyIfGradeAtLeast);
  if (gradeIdx < minIdx) return { grade, demoted: false };
  const newIdx = Math.max(0, gradeIdx - demotion.demoteBy);
  return { grade: GRADE_ORDER[newIdx], demoted: newIdx !== gradeIdx };
}

/** How far the primary measurement sits from the nearest grade-boundary
 *  threshold used in ITS OWN conditions (secondary condition keys in
 *  multi-factor rules, e.g. Hand to Neck's shoulderElevationDeg, are not
 *  included -- boundary-distance confidence is only well-defined for a
 *  single driving numeric value). Returns 0-1; 1 = far from any boundary
 *  (confident), 0 = sitting right on one (a borderline call). Boolean/
 *  bucket primary measurements (reachSuccess, vertebralLevelProxy) have no
 *  partial-credit concept, so this returns 1 (full confidence on this
 *  factor) for them -- the grade is exactly what the discrete value says. */
function computeBoundaryDistanceConfidence(taskConfig, measurements, config) {
  const { value } = resolveValue(measurements, taskConfig.primaryMeasurementKey);
  if (typeof value !== "number") return 1;
  const thresholds = [];
  for (const rule of taskConfig.gradingRules) {
    for (const c of rule.conditions) {
      if (c.key === taskConfig.primaryMeasurementKey && typeof c.value === "number") thresholds.push(c.value);
    }
  }
  if (thresholds.length === 0) return 1;
  const minDist = Math.min(...thresholds.map((t) => Math.abs(value - t)));
  const norm = config.boundaryDistanceNormalizationDeg || 15;
  return Math.min(1, minDist / norm);
}

function confidenceMultiplierFor(measurementType, confidence, weights) {
  if (measurementType === "unavailable") return weights.unavailable ?? 0;
  return weights[`${measurementType}_${confidence}`] ?? 0;
}

/** Confidence-weighted blend of: the primary measurement's own
 *  measurementType/confidence, DMQE's movementConfidencePct for this task,
 *  the task's CQI overallConfidencePct, and boundary-distance confidence.
 *  Missing components (no DMQE/CQI result passed in) are EXCLUDED from
 *  renormalization, not scored as zero -- same principle ASRI's category
 *  scoring and ICQA's subscore combination already established. */
function computeConfidence({ taskConfig, measurements, dmqeResult, cqiResult, config }) {
  const primary = resolveValue(measurements, taskConfig.primaryMeasurementKey);
  const measurementConf = confidenceMultiplierFor(primary.measurementType, primary.confidence, config.confidenceWeights) * 100;
  const boundaryConf = computeBoundaryDistanceConfidence(taskConfig, measurements, config) * 100;

  const components = [
    { weight: config.confidenceBlend.measurementConfidence, value: measurementConf },
    { weight: config.confidenceBlend.boundaryDistance, value: boundaryConf },
  ];
  if (dmqeResult && dmqeResult.movementConfidencePct != null) {
    components.push({ weight: config.confidenceBlend.dmqeConfidence, value: dmqeResult.movementConfidencePct });
  }
  if (cqiResult && cqiResult.overallConfidencePct != null) {
    components.push({ weight: config.confidenceBlend.cqiConfidence, value: cqiResult.overallConfidencePct });
  }
  const weightSum = components.reduce((s, c) => s + c.weight, 0);
  if (weightSum === 0) return 0;
  const weighted = components.reduce((s, c) => s + c.weight * c.value, 0);
  return Math.round(weighted / weightSum);
}

function humanizeKey(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}

function formatValue(value, unit) {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return unit === "deg" ? `${value}°` : `${value}${unit ? " " + unit : ""}`;
  return String(value);
}

function buildReasoning({ taskConfig, grade, demoted, measurements, dmqeResult, cqiResult, confidence }) {
  const parts = [];
  const primary = resolveValue(measurements, taskConfig.primaryMeasurementKey);
  if (primary.value != null) {
    const rawEnvelope = measurements[taskConfig.primaryMeasurementKey];
    const unit = rawEnvelope && typeof rawEnvelope === "object" ? rawEnvelope.unit : undefined;
    parts.push(`${humanizeKey(taskConfig.primaryMeasurementKey)} = ${formatValue(primary.value, unit)}`);
  }
  const comp = resolveValue(measurements, "trunkCompensationFlag");
  if (comp.value != null) parts.push(`Compensation = ${comp.value ? "Present" : "Minimal"}`);
  const smoothness = dmqeResult?.domains?.smoothness?.value;
  if (smoothness != null) parts.push(`Movement Smoothness = ${smoothness}`);
  if (cqiResult?.cqi != null) parts.push(`CQI = ${cqiResult.cqi}`);
  parts.push(`Confidence = ${confidence}%`);
  if (demoted) parts.push("grade demoted one level due to flagged compensation");
  return `Predicted Grade: ${grade}. ${parts.join(", ")}.`;
}

/** Collects every non-empty `.limitation` string from this task's
 *  measurement envelopes, de-duplicated. This is how e.g. the existing
 *  internalRotationDeg proxy's own documented ~90deg-elbow-flexion
 *  operating-window caveat (written in shared/biomechanics/angle-
 *  computation.js, unmodified) surfaces automatically on Task 6's grade --
 *  no separate hard-coded note needed here. */
function collectLimitations(measurements) {
  const seen = new Set();
  const out = [];
  for (const v of Object.values(measurements || {})) {
    if (v && typeof v === "object" && v.limitation) {
      if (!seen.has(v.limitation)) {
        seen.add(v.limitation);
        out.push(v.limitation);
      }
    }
  }
  return out;
}

class ModifiedMalletScoreEngine {
  /** @param {object} config - a published, immutable mallet-score-config.v1 object */
  constructor(config) {
    this.config = config;
  }

  /**
   * @param {object} args
   * @param {string} args.taskId - e.g. "global_abduction" (TaskDefinitions.js id)
   * @param {string} args.malletCategory - e.g. "globalAbduction" (config/mallet-score-config.v1.json key)
   * @param {object} args.measurements - {key: envelope|rawValue} for this task
   * @param {object|null} [args.dmqeResult] - shared/motion/dmqe-engine.js's runDmqe() result for this task
   * @param {object|null} [args.cqiResult] - shared/icqa/icqa-engine.js's IcqaEngine.score() result for this task
   */
  score({ taskId, malletCategory, measurements, dmqeResult = null, cqiResult = null }) {
    const taskConfig = this.config.tasks[malletCategory];
    if (!taskConfig) throw new Error(`ModifiedMalletScoreEngine: no grading config for mallet category "${malletCategory}"`);

    const primary = resolveValue(measurements, taskConfig.primaryMeasurementKey);
    const measurementLimitations = collectLimitations(measurements);

    if (primary.value == null) {
      return {
        taskId, malletCategory, grade: null, status: "insufficient_data",
        confidence: 0,
        reasoning: `No grade could be predicted: the primary measurement (${humanizeKey(taskConfig.primaryMeasurementKey)}) was unavailable for this task.`,
        supportingMeasurements: measurements,
        dmqeContribution: null,
        cqiContribution: null,
        measurementLimitations,
        gradeConfigVersion: this.config.version,
      };
    }

    const { grade: rawGrade } = determineGrade(taskConfig, measurements);
    const { grade, demoted } = applyCompensationDemotion(rawGrade, taskConfig, measurements);
    const confidence = computeConfidence({ taskConfig, measurements, dmqeResult, cqiResult, config: this.config });
    const reasoning = buildReasoning({ taskConfig, grade, demoted, measurements, dmqeResult, cqiResult, confidence });

    return {
      taskId, malletCategory, grade, status: "ok",
      confidence,
      reasoning,
      supportingMeasurements: measurements,
      dmqeContribution: dmqeResult
        ? { status: dmqeResult.status, movementConfidencePct: dmqeResult.movementConfidencePct ?? null, smoothness: dmqeResult.domains?.smoothness?.value ?? null }
        : null,
      cqiContribution: cqiResult ? { cqi: cqiResult.cqi, overallConfidencePct: cqiResult.overallConfidencePct } : null,
      measurementLimitations,
      gradeConfigVersion: this.config.version,
    };
  }

  /** Total Modified Mallet Score, Average Grade, Assessment Confidence
   *  across all graded tasks. Ungraded tasks (status !== "ok") are
   *  EXCLUDED, not scored as grade I -- a missing measurement is not
   *  clinical evidence of "no function." */
  scoreOverall(perTaskResults) {
    const graded = perTaskResults.filter((r) => r.status === "ok" && r.grade != null);
    if (graded.length === 0) {
      return { totalScore: null, averageGrade: null, averageGradeRoman: null, assessmentConfidencePct: 0, tasksGraded: 0, tasksTotal: perTaskResults.length, status: "insufficient_data" };
    }
    const totalScore = graded.reduce((s, r) => s + GRADE_NUMERIC[r.grade], 0);
    const averageGrade = Math.round((totalScore / graded.length) * 100) / 100;
    const assessmentConfidencePct = Math.round(graded.reduce((s, r) => s + r.confidence, 0) / graded.length);
    return {
      totalScore,
      averageGrade,
      averageGradeRoman: GRADE_ORDER[Math.min(4, Math.max(0, Math.round(averageGrade) - 1))],
      assessmentConfidencePct,
      tasksGraded: graded.length,
      tasksTotal: perTaskResults.length,
      status: "ok",
    };
  }
}

export { ModifiedMalletScoreEngine, GRADE_ORDER, GRADE_NUMERIC, resolveValue };
