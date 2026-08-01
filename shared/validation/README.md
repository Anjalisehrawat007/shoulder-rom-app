# Validation Engine (not yet implemented)

Planned module boundary for spec §8: the Research Validation Module.
Lets a researcher enter clinician measurements (goniometry, Mallet score,
AMS score, notes) per session and automatically compares them against this
app's output.

**Planned interface** (subject to revision):

```js
/**
 * @param {Array<{appValue: number, clinicianValue: number}>} pairs - per
 *   parameter, per session
 * @returns {{
 *   pearsonR: number, spearmanRho: number, icc: number,
 *   mae: number, rmse: number,
 *   blandAltman: { bias: number, limitsOfAgreement: [number, number] },
 *   confidenceInterval: [number, number]
 * }}
 */
function computeAgreementStatistics(pairs) { ... }
```

Must report agreement **per parameter**, not as one blended verdict for the
whole system — per the prior analysis in this project, gross ROM
(abduction/flexion) and estimated parameters (rotation, scapular tilt/
winging) have very different expected validity and should never be
collapsed into a single pass/fail number.

Depends on: `shared/biomechanics/parameter-schema.js` (to know which
parameters are `measured` vs `estimated` when interpreting results),
`shared/asri/asri-engine.js`.
Must not depend on MediaPipe or any capture-time module directly (spec §11).
