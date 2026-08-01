/**
 * reference-datasets.js
 * ----------------------------------------------------------------------------
 * Resolves which reference target set applies to a given patient, from a
 * versioned, externally-editable dataset (config/reference-datasets.v1.json
 * locally, or the backend's /api/reference-datasets/:version once deployed)
 * -- never a hard-coded constant in the scoring engine. Supports spec §5:
 * age group, affected side, time since surgery, and (via `hospitalId`)
 * future hospital-specific datasets.
 *
 * Matching rule: a dataset's `criteria` fields are each either a concrete
 * constraint or `null` (wildcard, matches anything). A dataset MATCHES the
 * patient context if every non-null criterion is satisfied. Among all
 * matches, the one with the MOST non-null criteria (most specific) wins;
 * ties broken by listing order in the dataset file (first match wins) --
 * documented here since it's a real, if minor, design choice that affects
 * results when two equally-specific datasets could apply.
 * ----------------------------------------------------------------------------
 */

function inRange(value, range) {
  if (range == null) return true; // wildcard
  if (value == null) return false; // criterion requires a value the patient doesn't have
  const [min, max] = range;
  return value >= min && value <= max;
}

function matches(criteria, patientContext) {
  if (criteria.ageGroupMonths && !inRange(patientContext.ageMonths, criteria.ageGroupMonths)) return false;
  if (criteria.monthsSinceSurgeryRange && !inRange(patientContext.monthsSinceSurgery, criteria.monthsSinceSurgeryRange)) return false;
  if (criteria.side != null && criteria.side !== patientContext.side) return false;
  if (criteria.hospitalId != null && criteria.hospitalId !== patientContext.hospitalId) return false;
  return true;
}

function specificity(criteria) {
  return ["ageGroupMonths", "monthsSinceSurgeryRange", "side", "hospitalId"].filter((k) => criteria[k] != null).length;
}

/**
 * @param {{datasets: Array<{id: string, criteria: object, targets: object}>}} referenceConfig
 * @param {{ageMonths?: number, monthsSinceSurgery?: number, side?: string, hospitalId?: string}} patientContext
 * @returns {{id: string, criteria: object, targets: object}} the most specific matching dataset
 */
function resolveReferenceDataset(referenceConfig, patientContext) {
  const candidates = referenceConfig.datasets.filter((d) => matches(d.criteria, patientContext));
  if (candidates.length === 0) {
    const fallback = referenceConfig.datasets.find((d) => d.id === "default");
    if (!fallback) throw new Error("reference dataset config has no matching entry and no 'default' fallback");
    return fallback;
  }
  return candidates.reduce((best, c) => (specificity(c.criteria) > specificity(best.criteria) ? c : best));
}

export { resolveReferenceDataset };
