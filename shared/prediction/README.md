# Prediction Engine (not yet implemented)

Planned module boundary for spec §10 (recovery-curve / trend prediction)
and any future ML-based forecasting of recovery trajectory from
longitudinal ASRI history.

**Planned interface** (subject to revision once the ASRI Engine itself is
redesigned in the phase covering spec §4):

```js
/**
 * @param {Array<{date: string, asri: number, stage01: number}>} history
 * @returns {{ projectedAsri: number, confidenceInterval: [number, number], horizon: string }}
 */
function predictRecoveryTrajectory(history) { ... }
```

Depends on: `shared/asri/asri-engine.js` output history for a patient.
Must not depend on MediaPipe or any capture-time module directly (spec §11).
