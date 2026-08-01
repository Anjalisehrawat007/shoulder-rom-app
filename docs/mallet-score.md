# Modified Mallet Assessment — Methodology Documentation

Covers `shared/assessment/*` (the workflow + grading engine), `shared/reporting/*`
(the combined report), and how they integrate Phases 1-5 (Biomechanical
Engine, ASRI, DMQE, Validation, ICQA) into a guided clinical exam. Written
in the same spirit as `docs/biomechanics.md`, `docs/dmqe.md`,
`docs/validation.md`, and `docs/icqa.md` — nothing here is asserted
without a citation, a stated assumption, or an explicit "this is a proxy"
flag.

## 1. Architecture and independence guarantee

```
capture/app.js (thin DOM-binding layer)
        ↓
shared/assessment/ModifiedMalletWorkflow.js  (orchestrator)
  ├─ AssessmentController.js   -- pure task-order/progress state machine
  ├─ TaskRecorder.js           -- filter -> DMQE -> Mallet measurements -> grade
  │     ├─ shared/motion/*             (Phase 3, unmodified, called not merged)
  │     ├─ shared/biomechanics/*       (Phase 1, unmodified, called not merged)
  │     └─ mallet-measurements.js      (NEW, this phase)
  ├─ TaskResults.js            -- per-task storage envelope builder
  └─ ModifiedMalletScoreEngine.js  -- THE independent grading engine
        ↓
shared/reporting/report-generator.js  -- combined report (reads ASRI/DMQE/
  ICQA/Mallet output, imports none of their logic)
        ↓
backend: task_results.mallet_grade_json, mallet_grade_overrides (append-only),
  mallet_score_config_versions, TASK_DATA_DIR (video/landmarks)
        ↓
doctor-portal/portal.js  -- Mallet grade panel + clinician override form
```

**`shared/assessment/ModifiedMalletScoreEngine.js` has zero imports** —
confirmed by `grep "^import" shared/assessment/ModifiedMalletScoreEngine.js`
returning nothing. This is the "completely independent module" the spec
requires: it is never merged into Biomechanics, ASRI, DMQE, Validation, or
ICQA, and none of them import from it either (checked the same way Phase 5
verified ICQA's independence). `TaskRecorder.js` and `ModifiedMalletWorkflow.js`
DO import `shared/motion/*` and `shared/biomechanics/*` — that is
orchestration (reading their output to build a task result), not a
redesign of either, the same relationship `capture/app.js` already had
with them before this phase. `shared/reporting/*` similarly reads
ASRI/DMQE/ICQA/Mallet output without importing their internal logic.

## 2. Clinical grading reference (research integrity)

The **Modified Mallet Score** (Mallet, 1972; standardized for pediatric
OBPP by Bae DS, Waters PM, Zurakowski D., "Reliability of three
classification systems measuring active motion in brachial plexus birth
palsy," *J Bone Joint Surg Am* 2003;85(9):1733-1738) defines **5**
categories, each graded I (no function) to V (normal): Global Abduction,
Global External Rotation, Hand to Neck, Hand to Spine, Hand to Mouth.

**This app's protocol adds a 6th task, "Internal Rotation," which is not
part of the original 5-category scale.** This is the deployed protocol's
explicit design, implemented as specified. It is graded I-V using the
same ordinal philosophy as the other five (bucketed thresholds on the
existing `internalRotationDeg` proxy), but `config/mallet-score-config.v1.json`
labels its `tasks.internalRotation.label` and `citation` fields as
"supplementary item -- NOT part of the classic 5-category Mallet 1972 /
Bae et al. 2003 scale" so this is never silently presented as published
criteria.

**Grade bands are an operationalization, not a transcription.** Mallet's
original I-V descriptions are qualitative clinical observations (e.g.
"reaches neck with marked abduction of the shoulder"), not device-measured
angle cutoffs. `config/mallet-score-config.v1.json`'s `gradingRules` per
task are a documented, versioned interpretation of those descriptions
into automatable thresholds — an interpretation choice made explicit here,
not hidden inside code. See §8 for how this is intended to be improved.

## 3. A real tension, surfaced not hidden: Task 2 vs. Task 6

`shared/biomechanics/angle-computation.js`'s `computeAxialRotation()`
(Phase 1, **unmodified this phase**) is documented as a forearm-orientation
proxy "reliable mainly near ~90° elbow flexion." Task 2 (Global External
Rotation: "keep the elbow close to the body, flex the elbow approximately
90°, rotate the forearm outward") matches that operating window by
instruction — a good fit, used as-is.

**Task 6 (Internal Rotation / hand-behind-back) does not match that
window.** A hand-behind-back posture doesn't hold the elbow near 90°, so
`internalRotationDeg`'s own documented validity assumption doesn't hold
for this task's actual arm configuration. Per the explicit instruction
not to redesign this algorithm, Task 6 uses the existing value completely
unchanged. This is NOT silently accepted: `ModifiedMalletScoreEngine.js`'s
`collectLimitations()` pulls the parameter's own `.limitation` string
(written in Phase 1, unmodified) into every Task 6 grade's
`measurementLimitations` field automatically — the mismatch surfaces on
every single Task 6 result, not just here in the docs. See §8 for why
this makes Task 6 (and Task 2, to a lesser extent since it's a better fit
but still an estimated proxy) the top candidate for a future
Internal/External Rotation algorithm redesign phase.

## 4. New measurements — `shared/assessment/mallet-measurements.js`

Four measurements that exist nowhere else in the codebase, computed from
data the existing engines already expose (raw landmarks, a DMQE result's
segmentation phases) — never by editing `shared/biomechanics/*` or
`shared/motion/*`:

| Measurement | Type | Basis |
|---|---|---|
| `elbowFlexionDeg` | `measured` | A genuine 3-point joint angle (shoulder-elbow-wrist) — same geometric category as the existing `shoulderFlexionDeg`, not a heuristic |
| `reachSuccess` | `estimated` | Is the wrist within a configurable radius of an approximate neck region (shoulder/ear midpoint)? MediaPipe has no "back of neck" landmark, and a frontal camera can't see the back of the neck at all — a coarse "reached the head/neck area" proxy, not a confirmed touch |
| `vertebralLevelProxy` | `estimated` | Fraction of the shoulder-hip span the wrist traveled down/back, bucketed into named approximate levels (cannot-reach / sacrum-buttock / L3 / T12 / T7-or-higher). No spine landmarks exist in MediaPipe's set and a frontal camera can't see the hand against the back — a positional bucket, not vertebral palpation |
| `completionTimeSec` | `measured` | Real elapsed time between DMQE's own segmentation-detected `movementStart`/`movementEnd` timestamps — inherits DMQE's own documented placeholder noise-floor/debounce caveat (`shared/motion/segmentation.js`) |

`shoulderExtensionDeg` (Hand to Spine's supporting context) is explicitly
`unavailable`: the existing `shoulderFlexionDeg` is an unsigned angle from
rest and doesn't distinguish flexion from extension. Computing a true
signed extension angle would require a biomechanics change, out of scope
for an integration-only phase — stated as a limitation, not silently
substituted with a wrong-signed value.

All four use the same `{value, unit, measurementType, confidence,
limitation}` envelope as every other parameter in this system
(`shared/biomechanics/parameter-schema.js`'s `makeParameter`, imported
read-only).

## 5. `ModifiedMalletScoreEngine.js` — grading algorithm

**Grade determination**: each Mallet category
(`config/mallet-score-config.v1.json`'s `tasks.<category>`) defines an
ORDERED list of `gradingRules`, evaluated from grade V down to II — the
first rule whose ALL conditions are met wins; if none match,
`fallbackGrade` ("I") applies. This is a general condition-list evaluator
(`key`/`op`/`value` triples), not a single-value threshold lookup, because
the published criteria for Hand to Neck/Spine/Mouth are multi-factor
(reach AND how much compensation it took), not a single angle band.

**Compensation demotion**: an optional `compensationDemotion` rule
(config-driven, applied to Global Abduction/External Rotation/Internal
Rotation) drops a grade by one band when `trunkCompensationFlag` is set
alongside a grade of III or higher — reflecting that a large ROM value
achieved only through trunk-lean substitution shouldn't grade as cleanly
as one achieved without it.

**Confidence** (0-100): a config-weighted blend of (a) the primary
measurement's own `measurementType`/`confidence`, (b) DMQE's
`movementConfidencePct` for the task, (c) the task's CQI
`overallConfidencePct`, and (d) distance from the nearest grade-band
boundary (a value sitting right at a threshold is less confident than one
solidly mid-band — computed only for numeric primary measurements; a
boolean/bucket primary has no partial-credit concept, so this factor is
`1` — full confidence — for `reachSuccess`/`vertebralLevelProxy`). Missing
components (no DMQE/CQI result available) are EXCLUDED from
renormalization, not scored as zero — the same principle ASRI's category
scoring and ICQA's subscore combination already established, applied here
independently (no import).

**Never fabricates**: a task whose configured `primaryMeasurementKey` is
`unavailable` returns `grade: null, status: "insufficient_data"` with a
stated reason — the same pattern as ASRI's `insufficient_data` categories
and DMQE's `no_movement_detected` status.

**Overall score rollup** (`scoreOverall()`): total score = sum of numeric
grades (I=1..V=5) across graded tasks only; ungraded tasks are EXCLUDED,
never scored as grade I — a missing measurement is not clinical evidence
of "no function."

## 6. Workflow — recording, review, and confirmation

`ModifiedMalletWorkflow.recordCurrentTask()` runs the pipeline and builds
a storage envelope but does **not** advance `AssessmentController` --
that only happens via the separate `confirmCurrentTask()`, called from
`capture/app.js`'s "Continue" button after the caregiver/clinician reviews
the Task Review panel (predicted grade, confidence, reasoning). This
split exists specifically so "Retry this task" can re-record without the
controller having already moved on — recording produces a *candidate*
result; confirming is what advances the assessment.

**Countdown**: a 3-2-1 overlay runs after the ICQA gate passes and before
recording starts, giving the caregiver/patient a moment to get ready.

**Video capture**: `capture/pose-engine.js`'s `startVideoCapture()`/
`stopVideoCapture()` wrap the browser's `MediaRecorder` API against the
SAME camera stream already open for pose detection — no second stream.
Feature-detected: a browser/device without `MediaRecorder` support simply
stores no video for that task, never a crash. Raw and filtered landmark
sequences and the video are uploaded to a dedicated endpoint and written
to `TASK_DATA_DIR` on disk (file-on-disk-plus-path-in-DB, the same
pattern `CAPTURES_DIR` already uses for photos) — not inlined as JSON
columns, avoiding the storage bloat Phase 3 already flagged as a concern
for much smaller payloads.

**Resume**: `sessionId`+`captureToken` are persisted to `localStorage` on
session creation. On boot, a saved session offers "Resume assessment,"
backed by a capture-token-gated `GET /api/sessions/:id/resume` that
returns completed task summaries; `AssessmentController.resumeFrom()`
reconstructs progress and lands on the correct next task — verified
end-to-end (2/6 tasks seeded via the backend API, page reloaded, correctly
resumed at task 3).

## 7. Clinician override — append-only, never overwrites the prediction

`mallet_grade_overrides` (backend/db.js) is append-only, the same
immutable-history principle as Phase 4's `clinician_assessments`: a
correction is a NEW row with `supersedes_id` set, never an `UPDATE`. It is
a **separate table** from `clinician_assessments` — that table holds an
independent clinician-entered ground-truth assessment for Phase 4's
validation design; this one holds a clinician's review of THIS APP'S OWN
prediction for one task. Conflating the two would corrupt Phase 4's
app-vs-clinician validation, which depends on the two staying independent.
The predicted grade is never modified by an override — both are always
shown side by side, with their difference and the override reason.

## 8. Report generation

`shared/reporting/report-generator.js`'s `generateMalletReport()` returns
one structured object (task-wise measurements, predicted vs. clinician
grades, agreement, CQI/DMQE/ASRI summaries, recommendations, limitations)
consumed by THREE renderers: `renderMarkdown()` (this module),
`backend/pdf-renderer.js` (pdfkit — a Node-only dependency kept out of the
browser-facing `shared/*` tree; Node's module resolution walks up from the
importing file's own directory, so a package installed only in
`backend/node_modules` wouldn't resolve from `shared/reporting/*` anyway),
and the doctor portal's own JSON endpoint response. One data source, three
output formats, no logic duplicated between them.

## 9. Limitations and readiness for an Internal/External Rotation redesign

- **Grade-band thresholds are initial, versioned defaults** — an
  operationalization of Mallet's qualitative descriptions (§2), not fit to
  clinician-labelled outcome data for this population (none exists yet).
  `mallet-score-config.v1.json`'s architecture (grading rules, weights,
  buckets, all externalized) is specifically designed so a future
  clinician-labelled dataset can inform a new published version — never an
  in-place edit, same guarantee ASRI's config already has.
- **Task 6's operating-window mismatch (§3) is the clearest, most
  concrete candidate for a future Internal/External Rotation algorithm
  redesign.** The current proxy is usable as a rough directional
  indicator (more/less rotation) but its absolute values under a
  hand-behind-back posture should not be over-interpreted. A redesign
  would need either genuine elbow-angle-aware correction or a
  differently-derived signal for hand-behind-back postures specifically.
- **`reachSuccess` and `vertebralLevelProxy`** are coarse 2D positional
  proxies with no way to confirm actual skin contact or true vertebral
  level from a single frontal RGB camera — stated in their own
  `limitation` strings every time they're produced, not just here.
- **No real clinician-labelled Mallet grades exist yet to validate the
  grading engine's own accuracy against** — this phase makes the
  ARCHITECTURE ready for that validation (Phase 4's Validation Engine
  already supports comparing app output to clinician ground truth; the
  same infrastructure could be pointed at Mallet grades in a future
  phase), but does not itself constitute that validation.

## 10. Future improvements

Pediatric-specific thresholds for `vertebralLevelProxy`'s bucket
boundaries and the grade bands generally, once real labelled data exists.
A genuine elbow-angle-aware correction (or an alternative signal) for
hand-behind-back rotation. Multi-rater override support (currently one
"most recent version per task" clinician grade, mirroring how Phase 4's
comparison engine also uses "most recent assessment" as a simplification).
CSV/Excel export (the original `shared/reporting/README.md` planned this;
not implemented this phase, JSON/PDF only per the explicit request).
