# Intelligent Camera Quality Assurance (ICQA) — Methodology Documentation

Covers `shared/icqa/*`: every algorithm, every threshold's provenance, the
Capture Quality Index (CQI) design, the recording gate, the guidance
system, and known limitations. Written in the same spirit as
`docs/biomechanics.md` (Phase 1), `docs/dmqe.md` (Phase 3), and
`docs/validation.md` (Phase 4) — nothing here is asserted without either a
citation, a stated assumption, or an explicit "this is a proxy, not a
measurement" flag.

## 1. Architecture and independence guarantee

```
capture/pose-engine.js
  ├─ main single-pose landmarker (unchanged since Phase 1)
  └─ secondary numPoses:2 landmarker (NEW -- gate-phase only, low frequency)
        ↓
shared/icqa/*  (independent engine, own package.json)
  camera-geometry.js, frame-quality.js, visibility-analysis.js, tracking-stability.js
        ↓ raw per-criterion results
  icqa-engine.js  -- 8 subscores + Capture Quality Index (CQI)
  guidance-engine.js, recording-gate.js, quality-timeline.js
        ↓
capture/app.js  -- gate before each task, during-recording monitoring
        ↓
backend: task_results.camera_quality_json / icqa_version, icqa_config_versions
        ↓
doctor-portal/portal.js  -- Capture Quality panel + Quality Timeline chart
```

`shared/icqa/*` **never imports from** `shared/asri/*`, `shared/motion/*`,
or `shared/validation/*`. Verified by grep, not just asserted (see the
Phase 5 engineering report for the exact command run). It DOES import from
`shared/biomechanics/*` (`parameter-schema.js`'s envelope, `coordinate-
frame.js`'s `vec3` math) — that is the one shared foundational layer every
phase is permitted to depend on, the same way DMQE (Phase 3) and the
Validation Engine (Phase 4) both do. Where ICQA would otherwise share a
small utility with ASRI (the versioned-config-store pattern), it
duplicates a ~30-line class locally in `shared/icqa/config-store.js`
rather than import it, to keep the independence guarantee literally true.

The one change to a pre-existing file that isn't purely additive is
`capture/pose-engine.js` gaining a second, separate `PoseLandmarker`
instance — additive in the sense that the original single-pose detection
path (`detect()`, `_history`, `_taskHistory`) is untouched; the new
`countPeople()`/`grabFrame()`/`getRecentHistory()` methods are new surface
area, not modifications to existing behavior.

## 2. What's measured vs. estimated vs. unavailable

Every criterion below uses the same envelope Phase 1 established
(`{value, unit, measurementType, confidence, limitation}` —
`shared/biomechanics/parameter-schema.js`). None of ICQA's inputs come
from a depth sensor or a calibrated camera, so most "position" criteria
are honestly `estimated`, not `measured`:

| Criterion | Type | Basis |
|---|---|---|
| Tilt / roll | `measured` (with sensor) / `estimated` (fallback) | `DeviceOrientationEvent` when available and permission-granted; else a pose-based proxy (shoulder-line angle for roll, trunk-midline angle for tilt) that assumes the subject stands upright |
| Distance / framing | `estimated` | Fraction of frame the detected bounding box occupies — a real depth in cm is `unavailable`, no depth sensor exists |
| Height/camera-angle proxy | `estimated` | Trunk-to-leg vertical-span ratio vs. a generic adult anthropometric reference (Winter, D.A., *Biomechanics and Motor Control of Human Movement*) — not pediatric-specific |
| Body-part visibility | `measured` | MediaPipe's own per-landmark `visibility` score — a real signal, no proxy |
| Occlusion | `measured` (derived) | Low visibility on a required body-part group — cannot distinguish occlusion from "out of frame" from poor lighting |
| Multi-person | `measured` (when checked) / `unavailable` (otherwise) | A genuine `numPoses:2` detection pass, run only during the pre-task gate |
| Lighting (luminance, exposure, contrast) | `measured` | Real pixel statistics from an offscreen canvas grab |
| Sharpness / motion blur | `estimated` | Laplacian-variance proxy (Pech-Pacheco et al., 2000) — doesn't distinguish motion blur from defocus |
| Background complexity | `estimated` | Edge-density outside the subject's bounding box — a visual-clutter proxy, not a scene classifier |
| Camera/tracking stability | `measured` | Frame-to-frame shoulder-midpoint displacement — cannot distinguish camera shake from the subject moving |
| Unexpected objects in frame | `unavailable` | No object-detection model exists in this pipeline; only inferred via unexplained occlusion patterns, never claimed as object classification |

## 3. Capture Quality Index (CQI) — `icqa-engine.js`

Eight named subscores, each 0-100, each built from one or more raw
criteria converted to a score via a documented threshold shape
(`scoreBand`, `scoreCeiling`, `scoreFloor`, `scoreRange` in
`icqa-engine.js`) and combined via confidence-weighted average
(`combineComponents`) — the same `effectiveWeight = configWeight ×
confidenceMultiplier` pattern `shared/asri/asri-engine.js` uses, applied
independently here (not imported):

- **Camera Position** — tilt, roll, distance category, framing/centering, height-angle proxy
- **Lighting** — mean luminance (ideal-range scoring, since both too-dark and too-bright hurt), over/under-exposure, contrast, sharpness
- **Body Visibility** — average visibility per body-part group (head/shoulders/arms/hips/feet) plus the multi-person check (a second person folds in here as a `singlePerson` component — see §3.1)
- **Pose Readiness** — how consistently the pose was detected across the recent history window (detection rate), distinct from per-frame completeness above
- **Background Quality** — edge-density-based clutter proxy
- **Tracking Stability** — shoulder-midpoint jitter over the FULL check window
- **Occlusion Score** — a worst-case penalty (`100 - occludedPartCount×20`), deliberately NOT the same combination as Body Visibility (see §3.1)
- **Movement Readiness** — jitter over only the MOST RECENT few frames ("is the subject still right now"), distinct from Tracking Stability's full-window signal

**Composite CQI**: category weights come entirely from
`config/icqa-config.v1.json`'s `subscores.*.weight` — never hard-coded in
`icqa-engine.js`. Missing subscores (no data available) are excluded from
renormalization, not scored as zero, same "missing ≠ failing" principle
Phase 2 established for ASRI.

### 3.1 Why Body Visibility uses a "worst-case blend," not a plain average

A plain confidence-weighted average of 6 components (5 body parts + the
multi-person check) would let one entirely-missing required part (e.g.
feet completely out of frame) get diluted into near-invisibility by five
other parts that happen to be fine — averaging 5×100 and one 5 still
scores ~84, well above any reasonable gating threshold, which is
clinically wrong: framing completeness is closer to an AND than an
average. `combineComponents()` therefore accepts a `worstCaseBlend`
parameter (0-1); Body Visibility uses `0.6`, blending 60% of the single
lowest-scoring component into the result alongside the 40%-weighted
average. Every OTHER subscore uses the default plain average (`0`),
because their components genuinely trade off against each other (a
camera slightly tilted AND slightly too close is proportionally worse
than either alone, not "as bad as the worse one"). This is a deliberate,
documented per-subscore choice, not a uniform rule — see the code comment
on `combineComponents()` for the full reasoning, and
`scripts/verify-icqa.mjs`'s cropped-feet and multi-person test cases for
the behavior this produces.

## 4. Guidance system — `guidance-engine.js`

Produces ONE primary, plain-language instruction plus a secondary list —
not a red/green criterion checklist, which is meaningless to a
non-clinical caregiver. Severity ranking: `(warnThreshold - score) ×
(2 if gate-blocking else 1)`, so the worst BLOCKING issue always surfaces
first; among non-blocking issues, the worst deviation wins. Messages are
built from the RAW analyzer outputs (not just the subscore number) so
they can be specific — "Step back so I can see your child's feet" instead
of "Body Visibility: 35/100." Duplicate messages (e.g. Body Visibility and
Occlusion Score both failing for the same missing-feet reason) are
de-duplicated before ranking.

## 5. Recording gate — `recording-gate.js`

Purely config-driven: `config/icqa-config.v1.json`'s `gating` section
marks each subscore `required: true|false` and a `minScore`. A `required`
subscore below its `minScore` blocks recording; everything else becomes an
advisory warning. A `required` subscore with NO data at all (`score:
null`) also blocks — "we don't know if this is good enough" is treated the
same as "not good enough," not silently passed, per this project's
never-fabricate policy. `capture/app.js`'s "Continue anyway" action can
override a blocked gate, but the override is always recorded
(`gateOverridden: true` in the stored `cameraQuality`, plus the specific
blocking criteria at the moment of override) — never a silent bypass.

## 6. Quality Timeline — `quality-timeline.js`

Samples the (lighter-weight, no multi-person pass) ICQA result
periodically during an active recording window
(`config.timeline.sampleIntervalMs`, default 500ms). Auto-pause triggers
after `autoPauseConsecutiveSamples` (default 3) CONSECUTIVE samples below
`autoPauseCqiThreshold` — a single bad sample (a transient frame drop)
does not pause; a sustained drop does. `capture/app.js`'s
`createPausableTimer()` actually pauses/resumes the task's countdown when
this fires; `quality-timeline.js` itself only detects the condition and
records the event. The finalized timeline collapses consecutive
below-`warnCqiThreshold` samples into single warning entries (one per
contiguous dip, not one per sample) and carries `warnCqiThreshold` along
so a renderer (the doctor portal) doesn't need a separate config fetch to
draw the threshold line.

## 7. Multi-person detection — a genuine second model pass, not a proxy

Detecting a second person from a single-pose landmark stream is not
possible by inference alone. `capture/pose-engine.js` therefore creates a
SEPARATE `PoseLandmarker` instance configured with `numPoses: 2`, used
ONLY by `countPeople()` during the pre-task gate. This is warmed
("preloaded") once, right after the main model finishes loading in
`boot()`, specifically so the FIRST real gate check of a session doesn't
pay the full model-creation cost inline — see §9 for the observed cost of
skipping this.

## 8. Threshold provenance — explicitly not derived from a usability study

Every numeric threshold in `config/icqa-config.v1.json` (tilt/roll bands,
distance fractions, lighting ranges, sharpness/jitter/edge-density
cutoffs, subscore weights, gating minimums) is a **documented starting
default** drawn from standard CV/photography heuristics and this
project's own reasoning about what "good enough for markerless pose
tracking" looks like — NOT fit to outcome data from this patient
population, because none exists yet. This mirrors Phase 2's own
`asri-config.v2.json` and Phase 4's `docs/validation.md` §8 in spirit: a
versioned, externally-editable config is the honest way to hold a
provisional number, rather than embedding it in code as if it were
settled. Retuning is a new published `icqa-config` version (same
`VersionedConfigStore` pattern as ASRI/reference-datasets), never an
in-place edit.

## 9. Real-world deployment readiness and observed limitations

- **DeviceOrientationEvent availability**: unreliable on desktop browsers
  and gated behind an explicit permission prompt on iOS Safari (which must
  be requested from a user-gesture context — `capture/app.js` requests it
  from the "I've saved them — continue" button click, the first available
  gesture after session creation). Every device without it falls back to
  the pose-based tilt/roll proxy, correctly labeled `estimated` — verified
  by `scripts/verify-icqa.mjs`'s device-orientation fallback test.
- **Secondary-landmarker cost is real, not hypothetical**: in local
  Playwright testing (headless Chromium, no hardware GPU delegate),
  creating the second `numPoses:2` model instance took several seconds.
  Preloading it right after boot (§7) moves this cost off the first gate
  check, but on slow/GPU-less hardware the pre-task panel can still show a
  "Checking your camera setup…" placeholder for longer than ideal before
  its first live update. This is a genuine hardware/browser-dependent
  latency cost of running two on-device models, not a logic bug — worth
  re-measuring on real target devices (phones/tablets with a real GPU
  delegate) before treating the current ~1.5s idle-refresh cadence as
  final.
- **Occlusion-vs-absence ambiguity** (§2): MediaPipe's visibility score
  cannot distinguish a body part that's occluded by an object from one
  that's simply out of frame. A future version could add a bounding-box-
  edge check to at least separate "landmark predicted just past the frame
  edge" from "landmark predicted at moderate confidence, likely occluded"
  — not implemented in this phase.
- **The height/camera-angle proxy uses a generic adult reference ratio**
  (§2), not pediatric anthropometry specific to this population's age
  range — flagged in that parameter's own `limitation` string every time
  it's produced, not just here.
- **No true "unexpected object" detection** (§2) — would require a
  general-purpose object-detection model this pipeline doesn't include.

## 10. Future improvements

A pediatric-specific anthropometric reference table for the height/angle
proxy (age-banded, mirroring how `reference-datasets.v1.json` already
age-bands ASRI's ROM targets). A lightweight background optical-flow
signal to disambiguate camera shake from subject movement in Tracking
Stability (§2's stated limitation). An object-detection pass (even a
lightweight one) to make "unexpected objects" a genuinely measured
criterion instead of an occlusion-pattern inference. Re-measuring and
retuning `icqa-config.v1.json`'s thresholds against real capture sessions
once enough of them exist, publishing the result as `icqa-config.v2.0.0`
rather than editing v1 in place.
