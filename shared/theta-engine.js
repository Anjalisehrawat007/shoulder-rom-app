/**
 * theta-engine.js
 * ----------------------------------------------------------------------------
 * Versioned, re-fittable weight architecture ("theta") for composite shoulder
 * recovery scoring.
 *
 * Novel elements implemented here (see /docs/architecture.md for the full
 * write-up intended to support a patent application):
 *
 *  1. Domain weights are stored as an external, versioned configuration object
 *     (ThetaConfig), never hard-coded in the scoring logic. Each config is
 *     immutable once published; re-fitting produces a NEW version rather than
 *     mutating history, so a session scored on 2026-03-01 can always be
 *     re-computed later using the exact weights that were active that day.
 *
 *  2. Each domain's weight is not a single number but a pair of learned
 *     endpoints {early, late}. The weight actually used in a given session is
 *     produced by blending continuously between those endpoints through a
 *     monotonic sigmoid function of the patient's recovery stage, phi(s).
 *     This lets the model's emphasis shift smoothly (e.g. from "protect the
 *     repair" early domains toward "functional independence" domains late)
 *     without discrete "phase buckets" and without discontinuities at
 *     phase boundaries.
 *
 *  3. Domain scores are renormalized at scoring time over whichever
 *     parameters were actually captured in that session. Missing parameters
 *     are excluded from the denominator rather than silently scored as zero,
 *     so a session where (for example) external rotation could not be
 *     measured does not unfairly penalize the composite score.
 *
 *  4. The confidence interval reported alongside the composite score widens
 *     both with (a) how few of the possible domains/parameters were captured,
 *     and (b) intrinsic per-domain measurement variance -- rather than being a
 *     fixed +/- figure. This makes score completeness visible to the
 *     clinician instead of hiding it.
 * ----------------------------------------------------------------------------
 */

class ThetaConfigStore {
  constructor() {
    /** @type {Map<string, object>} version string -> immutable config object */
    this.versions = new Map();
    this.activeVersion = null;
  }

  /** Register a new, immutable config version. Refuses to overwrite an existing version. */
  publish(config) {
    if (!config.version) throw new Error("theta config requires a semantic version string");
    if (this.versions.has(config.version)) {
      throw new Error(
        `theta version ${config.version} already published; re-fit must produce a new version, not mutate history`
      );
    }
    const frozen = Object.freeze(JSON.parse(JSON.stringify(config)));
    this.versions.set(config.version, frozen);
    this.activeVersion = config.version;
    return frozen;
  }

  get(version) {
    if (!this.versions.has(version)) {
      throw new Error(`theta version ${version} not found in store`);
    }
    return this.versions.get(version);
  }

  getActive() {
    if (!this.activeVersion) throw new Error("no theta config has been published yet");
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

class ThetaEngine {
  /**
   * @param {object} config - a published, immutable ThetaConfig object
   */
  constructor(config) {
    this.config = config;
  }

  /** Effective weight per domain at a given recovery stage (0=earliest, 1=fully recovered target). */
  effectiveWeights(stage01) {
    const t = phi(stage01, this.config.sigmoid);
    const out = {};
    for (const [domain, endpoints] of Object.entries(this.config.domains)) {
      out[domain] = lerp(endpoints.early, endpoints.late, t);
    }
    return { weights: out, phi: t };
  }

  /**
   * Compute the composite score for a session.
   * @param {object} domainScores - map of domain -> {value, expectedSd, captured:boolean}
   *   value is expected on a 0-100 normalized domain scale.
   * @param {number} stage01 - recovery stage in [0,1] (e.g. months-post-op / expected timeline)
   */
  score(domainScores, stage01) {
    const { weights, phi: phiVal } = this.effectiveWeights(stage01);
    const totalDomains = Object.keys(this.config.domains).length;

    const captured = Object.entries(domainScores).filter(([, d]) => d && d.captured);
    const capturedDomains = captured.length;

    if (capturedDomains === 0) {
      return {
        composite: null,
        completeness: 0,
        thetaVersion: this.config.version,
        phi: phiVal,
        confidenceInterval: null,
        detail: "no domains captured this session",
      };
    }

    // --- renormalize weights over captured domains only ---
    const weightSumPresent = captured.reduce((sum, [domain]) => sum + (weights[domain] ?? 0), 0);
    let composite = 0;
    const perDomain = {};
    for (const [domain, d] of captured) {
      const wRaw = weights[domain] ?? 0;
      const wNorm = weightSumPresent > 0 ? wRaw / weightSumPresent : 0;
      composite += wNorm * d.value;
      perDomain[domain] = { rawWeight: wRaw, normalizedWeight: wNorm, value: d.value };
    }

    const completeness = capturedDomains / totalDomains;

    // --- confidence interval widens with incompleteness and per-domain variance ---
    const conf = this.config.confidence || { z: 1.96, kVariance: 1, kCompleteness: 12 };
    const pooledVariance =
      captured.reduce((sum, [domain, d]) => {
        const wNorm = perDomain[domain].normalizedWeight;
        const sd = d.expectedSd ?? 10;
        return sum + wNorm * wNorm * sd * sd;
      }, 0) || 0;
    const varianceTerm = conf.kVariance * Math.sqrt(pooledVariance) / Math.sqrt(capturedDomains);
    const completenessPenalty = conf.kCompleteness * (1 - completeness);
    const margin = conf.z * varianceTerm + completenessPenalty;

    return {
      composite: Math.round(composite * 10) / 10,
      completeness: Math.round(completeness * 100) / 100,
      thetaVersion: this.config.version,
      phi: Math.round(phiVal * 1000) / 1000,
      confidenceInterval: {
        low: Math.round((composite - margin) * 10) / 10,
        high: Math.round((composite + margin) * 10) / 10,
        margin: Math.round(margin * 10) / 10,
      },
      perDomain,
    };
  }
}

// Export for both <script> (browser global) and module usage.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ThetaConfigStore, ThetaEngine, phi };
} else {
  window.ThetaConfigStore = ThetaConfigStore;
  window.ThetaEngine = ThetaEngine;
}
