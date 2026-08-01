/**
 * mallet-score-config-store.js — Modified Mallet Score versioned config store
 * ----------------------------------------------------------------------------
 * A small, independent duplicate of shared/asri/asri-engine.js's (and
 * shared/icqa/config-store.js's) VersionedConfigStore. Not imported from
 * either on purpose: shared/assessment/* must have zero dependency on
 * shared/asri/* or shared/icqa/*, so the independence guarantee documented
 * in docs/mallet-score.md is literally true (checkable by grep), not just
 * true in spirit -- same reasoning already applied for ICQA in Phase 5.
 * ----------------------------------------------------------------------------
 */

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

export { VersionedConfigStore };
