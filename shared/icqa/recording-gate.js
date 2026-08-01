/**
 * recording-gate.js — ICQA recording gate
 * ----------------------------------------------------------------------------
 * Pure decision function: given an IcqaEngine score() result and the active
 * config's `gating` section, decide whether recording may start. A subscore
 * is only gate-BLOCKING if `config.gating[key].required` is true AND its
 * score is below `minScore` -- everything else becomes an advisory warning
 * that's shown but doesn't stop the clinician/caregiver. Which subscores are
 * required vs. advisory is entirely config-driven (see
 * config/icqa-config.v1.json), not hard-coded here, so a future version can
 * relax/tighten gating without a code change -- same "never hard-code
 * thresholds" rule the rest of this phase follows.
 *
 * `capture/app.js` may still let a user proceed past a blocked gate via an
 * explicit "Continue anyway" action -- that override is recorded by the
 * CALLER (never silently invented here), see docs/icqa.md.
 * ----------------------------------------------------------------------------
 */

function evaluateGate(icqaResult, config) {
  const gating = config.gating;
  const blockingCriteria = [];
  const warnings = [];

  for (const [key, sub] of Object.entries(icqaResult.subscores || {})) {
    const gate = gating[key];
    if (!gate) continue;
    if (sub.score == null) {
      // Unavailable data on a REQUIRED criterion blocks recording too --
      // "we don't know if this is good enough" is not the same as "it's
      // fine," and silently proceeding would contradict the rest of this
      // project's never-fabricate policy.
      if (gate.required) blockingCriteria.push({ key, label: sub.label, score: null, minScore: gate.minScore, reason: "no data available for this check yet" });
      continue;
    }
    if (sub.score < gate.minScore) {
      const entry = { key, label: sub.label, score: sub.score, minScore: gate.minScore };
      if (gate.required) blockingCriteria.push(entry);
      else warnings.push(entry);
    }
  }

  return {
    canRecord: blockingCriteria.length === 0,
    blockingCriteria,
    warnings,
    cqi: icqaResult.cqi,
    icqaVersion: icqaResult.icqaVersion,
  };
}

export { evaluateGate };
