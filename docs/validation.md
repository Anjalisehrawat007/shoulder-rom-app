# Clinical Validation Engine — Methodology Documentation

Covers `shared/validation/*`: every formula, every assumption, sample-size
guidance, study design notes, and regulatory considerations. Written in
the same spirit as `docs/biomechanics.md` (Phase 1) and `docs/dmqe.md`
(Phase 3) — nothing here is asserted without a citation or an explicit
"this is a placeholder" flag.

## 1. Architecture and independence guarantee

```
Clinician Assessment Forms (validation-portal/)
        ↓ append-only, versioned
Backend: clinician_assessments, validation_datasets, validation_reports
        ↓
Validation Engine (shared/validation/*) -- reads ASRI/DMQE output
        ↓
Statistics → Bland-Altman → Reliability → Calibration Advice → QC → Report
```

The Validation Engine **only ever reads** stored session/task data and
clinician assessments. It never imports from, calls into, or writes back
to `shared/asri/*` or `shared/motion/*`. The one addition to those modules
in this phase is two exported version-string constants
(`DMQE_ENGINE_VERSION`, `FILTER_VERSION`) for dataset metadata (Part 8) —
zero behavioral change, verified by grep before this phase was called
done (see the final engineering report).

## 2. Clinician assessment versioning

`clinician_assessments` rows are **append-only** — a correction inserts a
new row with `supersedes_id` pointing at the prior row and `version`
incremented, never an `UPDATE`. This is the same immutable-history
principle `shared/asri/asri-engine.js`'s `VersionedConfigStore` already
uses for config versions: a report generated on a given date can always be
reproduced later using exactly the assessment data that existed then.

## 3. Comparison metrics (`comparison-engine.js`)

For each of the four ROM parameters (abduction, flexion, external/internal
rotation — the only parameters with a direct clinician-measured
counterpart; Mallet/AMS are composite scores compared separately, not
angle-for-angle), per paired session:

```
diff            = appValue - clinicianValue
absoluteError   = |diff|
relativeError   = |diff| / |clinicianValue|
normalizedError = |diff| / referenceTarget      (reuses reference-datasets.v1.json, not a new constant)
```

`withinTolerancePct` (default ±5°) is reported as a **labeled, parameterized
convenience metric**, explicitly not presented as a universal "percentage
agreement" statistic — that concept is native to categorical/kappa-style
data, not continuous angles, and dressing it up as a standard statistic
here would be misleading.

Results are always **one row per parameter**. Never blended into a single
score — gross ROM and rotation carry different expected validity per
Phase 1's own documentation.

## 4. Statistical methods (`statistics.js`)

**Pearson r**: standard product-moment correlation.

**Spearman ρ**: Pearson r computed on ranks, with fractional (average)
tie-ranking.

**MAE, RMSE, bias, SD, SE**: standard definitions;
`SE = SD/√n`.

**95% CI**: `mean ± t(0.975, df) × SE`. The t-critical value uses a
**lookup table for df 1-30** and converges to the normal approximation
(1.96) beyond that — see `tCritical95()`. This is adequate for
exploratory/preliminary reporting at the sample sizes this project will
realistically see for some time, but is **not a substitute for exact
p-values from R/Python/SPSS before publication** — stated here, not hidden
in a comment no one reads.

### Intraclass correlation — three forms, not one

Computed from the standard two-way ANOVA mean squares over a subjects ×
raters matrix (Shrout & Fleiss 1979; McGraw & Wong 1996):

| Form | Model | Used for |
|---|---|---|
| ICC(1,1) | one-way random | Test-retest, intra-rater (Part 6) — no fixed second "rater" to model |
| ICC(2,1) | two-way random, **absolute agreement** | **Default for app-vs-clinician comparison** — a systematic offset matters clinically and should hurt the score |
| ICC(3,1) | two-way mixed, **consistency** | Reported alongside ICC(2,1); answers "do they move together," not "do they agree in absolute terms" |

A large gap between ICC(2,1) and ICC(3,1) for a given parameter is itself
a diagnostic: it means there's a systematic bias between the app and the
clinician (one consistently reads higher/lower), not just random scatter —
`report-generator.js` calls this out explicitly when it appears.

**Interpretation bands** (Koo & Li 2016, cited every time they're used,
not silently applied): <0.5 poor, 0.5–0.75 moderate, 0.75–0.9 good, >0.9
excellent.

### Recommended-statistic logic

`recommendedStatistic({n})` returns a reasoned recommendation, not a
silent default:
- n<5: no correlation/ICC statistic is meaningful — report raw
  differences only.
- n<10: Spearman recommended over Pearson (more robust to outliers/
  non-normality at this sample size); any ICC CI should be treated as
  unreliable.
- Otherwise: Pearson/ICC reasonable, still labeled preliminary below the
  recommended minimum n (§8).

## 5. Bland-Altman analysis (`bland-altman.js`)

```
bias           = mean(diff)
SD(diff)
upperLoA       = bias + 1.96 × SD
lowerLoA       = bias - 1.96 × SD
SE(bias)       = SD / √n
SE(LoA)        ≈ SD × √(3/n)                    (Bland & Altman 1999)
```

95% confidence bands for bias and each LoA use the same t-critical
approximation as §4. Points outside the limits of agreement are flagged
as outliers. The chart itself (`validation-portal/app.js`) is built
following the project's dataviz skill: thin marks, 4px point markers,
recessive gridlines, direct line labels instead of a legend box (each
line's meaning — bias, upper/lower LoA — is unambiguous once labeled),
native SVG hover tooltips per point.

## 6. Reliability (`reliability-engine.js`)

Automatically groups repeated measurements — a dataset with no repeats
yet reports "0 groups found," not a fabricated number:

- **Test-retest**: same hospital ID, multiple app sessions within a
  configurable window (default 30 days) → ICC(1,1) per parameter.
- **Inter-rater**: sessions with 2+ distinct clinician assessments →
  ICC(2,1) per parameter. Simplification: only the first assessment from
  each of the first two distinct clinicians is used per session, so the
  comparison matrix stays a clean 2-rater matrix — documented, not
  silently dropping extra raters.
- **Intra-rater**: same clinician, same hospital ID, multiple assessment
  dates within a window (default 90 days) → ICC(1,1) per parameter.

## 7. Calibration advisor (`calibration-advisor.js`)

Flags parameters with ICC(2,1) < 0.75 (moderate or poor per Koo & Li) and
n ≥ 8, and generates a **recommendation** — a suggested new reference
target derived from the observed mean bias, phrased as "publish a NEW
`reference-datasets` version via the existing endpoint to test this."
**Never calls that endpoint itself.** Below n=8 it reports
`insufficient_data` rather than a recommendation that would just be noise.
This keeps ASRI's versioned/immutable guarantee (Phase 2) fully intact —
recalibration is always a deliberate human action.

## 8. Sample-size guidance

**Recommended minimum n = 30** paired measurements (and 30 unique
patients) for a reasonably stable ICC/correlation point estimate at
conventional (0.80) power for a moderate expected effect. This is
**standard textbook guidance** (e.g. Bujang & Baharum 2017 for ICC studies;
general correlation-study conventions), not a claim specific to this
app's actual required precision — a real power analysis would need an
assumed minimum acceptable ICC and expected true ICC, which nobody has
estimated for this system yet. Below n=30, `report-generator.js` marks
**every** result "preliminary" and states so in the rendered report, per
the explicit "never fake statistical significance" requirement.

**As of this phase, real paired data = 0.** Every number this engine can
currently produce is either `null` ("no paired data available") or
computed from prototype/smoke-test sessions with no real clinical basis.
This is stated plainly, not glossed over — see the Phase 4 engineering
report for what that means for research readiness.

## 9. Quality control (`quality-control.js`)

Checks: impossible angles (outside generous anatomical bounds, meant to
catch data-entry/sensor errors, not to second-guess genuine clinical
extremes), incomplete sessions (<4 tasks), invalid assessment dates
(future-dated, or predating the linked session), duplicate patients with
conflicting demographics (same hospital ID, different sex, or age
spanning >2 years), ASRI/reference-dataset **version mismatches** within a
single validation run (comparing sessions scored under different config
versions without flagging it would itself be a methodological error), and
estimated/low-confidence app parameters included in a comparison (flagged
as informational, not an error — they're legitimately included, just
should be interpreted with their confidence rating in mind).

## 10. Study design notes

- **Paired design**: each session's app output is compared against ONE
  clinician assessment per parameter (the most recent version if
  multiple exist). A future extension could compare against multiple
  independent clinician raters per session directly (feeding inter-rater
  reliability, §6, already supports this — the comparison engine
  currently doesn't average across raters, it uses the single latest
  assessment).
- **Representative task selection**: the app-side value compared is drawn
  from the task with the highest recorded `shoulderElevationDeg` across
  the session's four tasks — the same "peak ROM across tasks" principle
  ASRI's own ROM category already uses, applied here for consistency
  rather than inventing a different selection rule.
- **No marker-based reference system** exists in this study design — the
  "ground truth" is a clinician's manual goniometry/visual assessment,
  itself subject to its own measurement error (not modeled here; a
  three-way comparison against a marker-based system would be a stronger
  design for a future phase).

## 11. Regulatory considerations

This is a **research prototype**, not a cleared or CE-marked medical
device. Nothing in this system should inform an actual clinical decision
without independent verification. If this work progresses toward
regulatory submission, relevant frameworks to research (not assessed
here) include FDA's Software as a Medical Device (SaMD) guidance and, for
markerless motion capture specifically, precedent from cleared digital
gait/motion-analysis devices — this document does not claim any regulatory
pathway has been evaluated.

## 12. Limitations

- T-quantile and all "placeholder scaling" limitations already
  documented in `docs/biomechanics.md` and `docs/dmqe.md` propagate
  directly into any statistic computed here — validating a measurement
  built on documented placeholders validates the *pipeline's internal
  consistency*, not that the placeholders themselves are correct.
- ICC computation assumes complete data per subject-rater cell; sessions
  with only one of the two values are excluded from that parameter's
  matrix entirely (not imputed).
- `withinTolerancePct`'s ±5° default is an arbitrary, documented,
  adjustable convenience threshold — not derived from any clinical
  minimal-detectable-difference study for this population.
- No formal power analysis has been run for this specific system; §8's
  n=30 is generic guidance, not a computed requirement.

## 13. Future improvements

Externalize an `AsriEngine`-style versioned config for calibration
thresholds and tolerance bands (currently inline constants, same
documented scope decision already made for DMQE in Phase 3). Multi-rater
averaging in the comparison engine. A proper inverse-t implementation
instead of the lookup-table approximation. Bootstrap confidence intervals
for ICC (more robust at small n than the closed-form approximation used
here).
