/**
 * parameter-schema.js
 * ----------------------------------------------------------------------------
 * Every clinical parameter this system reports is wrapped in this envelope
 * instead of being a bare number. This is the contract downstream modules
 * (ASRI weighting, the future Validation Engine, reporting) consume — they
 * need to know what's measured vs. estimated vs. not measurable at all in
 * order to interpret results honestly. See docs/biomechanics.md for the
 * per-parameter classification and rationale.
 *
 * measurementType:
 *   "measured"    — a direct geometric quantity computed from an anatomical
 *                    coordinate frame, not dependent on an unvalidated
 *                    heuristic constant or narrow operating assumption.
 *   "estimated"    — a proxy for a clinical quantity that cannot be directly
 *                    observed from this landmark set; may carry a systematic
 *                    bias under specific conditions (documented in
 *                    `limitation`), not merely random noise.
 *   "unavailable"  — genuinely not derivable from the current landmark set.
 *                    `value` is null. Present so the schema doesn't silently
 *                    drop the parameter, and so a future estimation module
 *                    (e.g. a scapula-specific CV model) has an obvious slot
 *                    to populate.
 *
 * confidence: "high" | "moderate" | "low" | null (null only when unavailable)
 */

/**
 * @param {object} p
 * @param {number|null} p.value
 * @param {string} p.unit
 * @param {"measured"|"estimated"|"unavailable"} p.measurementType
 * @param {"high"|"moderate"|"low"|null} [p.confidence]
 * @param {string} [p.limitation] - required whenever measurementType !== "measured"
 */
function makeParameter({ value, unit, measurementType, confidence = null, limitation = "" }) {
  if (measurementType !== "measured" && !limitation) {
    throw new Error("estimated/unavailable parameters must document a limitation string");
  }
  return { value, unit, measurementType, confidence, limitation };
}

export { makeParameter };
