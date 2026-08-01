/**
 * mallet-agreement.js — Phase 10: categorical agreement for Modified Mallet
 * grades (ordinal I-V), reading `mallet_grade_overrides` rows (predicted
 * AI grade vs clinician-corrected grade) that already exist but were never
 * aggregated across sessions for statistical analysis anywhere in this
 * codebase before this phase.
 * ----------------------------------------------------------------------------
 * A local, ordinal I-V <-> 1-5 mapping is defined here rather than
 * importing GRADE_NUMERIC from shared/assessment/ModifiedMalletScoreEngine.js
 * -- shared/validation/* is a read-only downstream analysis layer and does
 * not import from the measurement-engine layer (same independence rule
 * already checked by this project's own grep convention; see
 * quality-control.js's CAPTURE_QUALITY_WARN_THRESHOLD for the identical
 * "local constant, not a cross-layer import" precedent).
 *
 * WEIGHTED KAPPA, NOT JUST RAW ACCURACY: a confusion matrix and percentage
 * agreement alone treat "predicted I, actual V" (maximally wrong) the same
 * as "predicted III, actual IV" (off by one) -- inappropriate for an
 * ORDINAL scale like Modified Mallet grades. Cohen's weighted kappa (Cohen
 * 1968) is the standard correction: near-miss disagreements count less
 * against the statistic than far misses. Implemented here with linear
 * weights by default (quadratic also supported) -- this is an addition
 * beyond the literal spec ("Confusion Matrix" + "Percentage Agreement"
 * were both explicitly requested; kappa wasn't), added because a
 * publication-quality ordinal-agreement analysis is genuinely incomplete
 * without it, not because it wasn't asked for.
 * ----------------------------------------------------------------------------
 */
const GRADES = ["I", "II", "III", "IV", "V"];
const GRADE_INDEX = Object.fromEntries(GRADES.map((g, i) => [g, i])); // 0-indexed for matrix math

/**
 * @param {Array<{predictedGrade: string, clinicianGrade: string}>} pairs
 * @returns {{grades: string[], matrix: number[][], rowTotals: number[], colTotals: number[], n: number}|null}
 */
function buildConfusionMatrix(pairs) {
  const valid = pairs.filter((p) => GRADE_INDEX[p.predictedGrade] != null && GRADE_INDEX[p.clinicianGrade] != null);
  if (valid.length === 0) return null;
  const matrix = GRADES.map(() => GRADES.map(() => 0));
  for (const p of valid) matrix[GRADE_INDEX[p.predictedGrade]][GRADE_INDEX[p.clinicianGrade]]++;
  const rowTotals = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = GRADES.map((_, j) => matrix.reduce((sum, row) => sum + row[j], 0));
  return { grades: GRADES, matrix, rowTotals, colTotals, n: valid.length };
}

/**
 * @param {Array<{predictedGrade: string, clinicianGrade: string}>} pairs
 * @returns {{n: number, exactMatchPct: number, within1GradePct: number}|{n: 0, note: string}}
 */
function percentAgreement(pairs) {
  const valid = pairs.filter((p) => GRADE_INDEX[p.predictedGrade] != null && GRADE_INDEX[p.clinicianGrade] != null);
  if (valid.length === 0) return { n: 0, note: "No paired predicted/clinician grades to compare." };
  let exact = 0;
  let within1 = 0;
  for (const p of valid) {
    const diff = Math.abs(GRADE_INDEX[p.predictedGrade] - GRADE_INDEX[p.clinicianGrade]);
    if (diff === 0) exact++;
    if (diff <= 1) within1++;
  }
  return {
    n: valid.length,
    exactMatchPct: Math.round((exact / valid.length) * 1000) / 10,
    within1GradePct: Math.round((within1 / valid.length) * 1000) / 10,
  };
}

/**
 * Cohen's weighted kappa (Cohen 1968) for ordinal I-V grades.
 * kappa = (Po - Pe) / (1 - Pe), where Po/Pe are WEIGHTED observed/expected
 * agreement (weights w_ij derived from category distance, not just 0/1
 * exact-match indicators the way unweighted kappa would use).
 * @param {Array<{predictedGrade: string, clinicianGrade: string}>} pairs
 * @param {"linear"|"quadratic"} [weighting="linear"]
 * @returns {{value: number, n: number, weighting: string, interpretation: string}|{n: 0, note: string}|{n: number, note: string}}
 */
function weightedKappa(pairs, weighting = "linear") {
  const confusion = buildConfusionMatrix(pairs);
  if (!confusion) return { n: 0, note: "No paired predicted/clinician grades to compare." };
  const { matrix, rowTotals, colTotals, n } = confusion;
  if (n < 5) return { n, note: `n=${n} is too small for a stable kappa estimate; report the raw confusion matrix and percentage agreement only.` };

  const k = GRADES.length;
  const weight = (i, j) => (weighting === "quadratic" ? 1 - ((i - j) / (k - 1)) ** 2 : 1 - Math.abs(i - j) / (k - 1));

  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = weight(i, j);
      po += w * (matrix[i][j] / n);
      pe += w * (rowTotals[i] / n) * (colTotals[j] / n);
    }
  }
  const value = pe === 1 ? null : (po - pe) / (1 - pe);
  return { value: value == null ? null : Math.max(-1, Math.min(1, value)), n, weighting, interpretation: kappaInterpretation(value) };
}

/** Landis & Koch (1977) interpretation bands -- the standard reference for kappa, cited not silently applied. */
function kappaInterpretation(value) {
  if (value == null) return "not computable";
  if (value < 0) return "poor (worse than chance)";
  if (value < 0.2) return "slight";
  if (value < 0.4) return "fair";
  if (value < 0.6) return "moderate";
  if (value < 0.8) return "substantial";
  return "almost perfect";
}

export { buildConfusionMatrix, percentAgreement, weightedKappa, kappaInterpretation, GRADES };
