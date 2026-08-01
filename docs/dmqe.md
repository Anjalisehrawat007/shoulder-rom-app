# Dynamic Movement Quality Engine (DMQE) — Mathematical Documentation

Covers `shared/motion/*`: the full-sequence motion pipeline (landmark
filtering, segmentation, trajectory analysis) and the Dynamic Movement
Quality Engine itself. Written for a reviewer validating this system, in
the same spirit as `docs/biomechanics.md` (Phase 1) and the confidence
architecture in `shared/asri/asri-engine.js` (Phase 2) — every formula,
every assumption, every limitation stated plainly.

## 1. Why full-sequence analysis, not a single frame

Phases 1-2 computed every clinical parameter from one representative frame
per task (the frame of maximum shoulder elevation). That frame is real, but
it discards everything about *how* the child got there — hesitation,
compensation onset, jerkiness of approach, whether the reach overshot and
corrected. DMQE analyzes every captured frame of a task's ~7s window instead
of one.

## 2. Pipeline

```
Video → Every Frame → Landmark Extraction (Phase 1, MediaPipe, unchanged)
      → Landmark Filtering (landmark-filter.js)
      → Segmentation (segmentation.js)
      → Biomechanical Engine (Phase 1, re-run per filtered frame)
      → Trajectory Analysis (trajectory-analysis.js)
      → DMQE (dmqe-engine.js)
      → ASRI (Phase 2, unchanged — consumes two DMQE outputs)
```

Two separate frame-history buffers exist in `capture/pose-engine.js`:
`_history` (capped at 60 frames, drives the live on-screen readout, a
real-time UX concern, unchanged since Phase 1) and `_taskHistory` (cleared
at `startTaskCapture()`, grows unbounded for the task's full window,
returned by `getTaskHistory()` for this pipeline). Conflating the two would
mean "motion quality" reflected whatever the last ~2s of camera activity
happened to be, not the task in question — a real bug in the pre-Phase-3
implementation, fixed here.

## 3. Landmark filtering — `landmark-filter.js`

**Method: Savitzky-Golay** (local polynomial least-squares regression), not
One Euro Filter, Kalman, or plain EMA. Full rationale for this choice is in
that file's header comment; summary: this stage runs **offline** on an
already-fully-captured, fixed-length sequence, so a non-causal filter
(using past *and future* samples within a window) is strictly better than
a causal, latency-optimized filter like One Euro — there is no latency to
optimize for. One Euro Filter remains the right choice for a *future* live-
smoothing enhancement to the real-time on-screen readout, a genuinely
different (causal, low-latency) problem.

**Formula**: for each output point at time `t_i`, fit a polynomial of
degree `order` (default 2) to the `2*halfWindow+1` (default 9) nearest
samples by least squares, using actual elapsed time (not frame index) as
the independent variable, centered so the evaluation point is `x=0`. The
fitted polynomial's constant term is the smoothed value at that point.
Solved via the normal equations `(XᵀX)c = Xᵀy`, Gaussian elimination with
partial pivoting (small, well-conditioned systems — window sizes of 5-15
points, order 2-3).

**Missing-sample handling**: a frame with no detected landmarks (failed
MediaPipe detection) contributes no sample to any window it falls in;
surrounding valid samples in the window still let the filter *reconstruct*
a value at that point (present the polynomial fit doesn't need every
input point, only enough to constrain the requested polynomial order). A
gap too large to have enough surrounding valid samples (see `xs.length <
effectiveOrder + 1` in the code) is left `null` — genuinely propagated as
missing, not guessed.

**Assumptions**: the signal is locally polynomial (degree 2-3) within each
window — appropriate for smooth biological reaching motion, not for
signals with genuine discontinuities. Window size/order are fixed
constants, not adaptively re-tuned per movement speed (unlike One Euro
Filter's adaptive cutoff) — documented placeholders pending real-cohort
calibration, the same "not fabricated precision" stance already used for
ASRI's weights and reference targets (Phase 2).

**Limitations**: larger windows smooth more but distort near sequence
boundaries (an asymmetric, not zero-padded, window is used there) and near
sharp velocity changes (movement onset/offset, exactly where segmentation
needs precision).

## 4. Segmentation — `segmentation.js`

**Algorithm**: velocity-threshold phase detection on filtered wrist speed,
with debouncing (a transition must hold for `debounceFrames` consecutive
frames, default 3) so a single noisy speed spike can't falsely trigger a
phase boundary.

```
wristSpeed[i] = |wrist[i] - wrist[i-1]| / (t[i] - t[i-1])   (landmark-units/s)
```

Phases, in order: **movement start** (first debounced crossing above
`speedNoiseFloor`, default 0.15 landmark-units/s) → **peak motion** (frame
of maximum wrist *displacement from the movement-start position* — see
below) → **hold** (sustained low-speed plateau near peak, ≥
`minHoldFrames`, default 3) → **return phase** (from hold end, or peak if
no hold, to movement end) → **movement end** (debounced crossing back below
threshold).

**Deliberate design choice**: "peak motion" is defined by wrist
*displacement*, not joint-angle elevation — this keeps `segmentation.js`
dependent only on landmark positions, never on the Biomechanical Engine
(Phase 1), so `trajectory-analysis.js` can depend on *both*
`landmark-filter.js` and `segmentation.js` without any circular dependency
(spec §8). For the single-plane-dominant reaching tasks this protocol
uses, peak displacement and peak elevation angle coincide closely in
practice, but they are not defined to be identical.

**Assumptions/limitations**: `speedNoiseFloor` and `debounceFrames` are
placeholder constants pending calibration against a real cohort's
stationary-frame jitter magnitude. Assumes one reach-and-return per task
(matches the current 4-task protocol); a sequence with multiple distinct
reach attempts isn't segmented into multiple movements. Sequences with too
few frames or no detected movement return an explicit status
(`insufficient_frames` / `no_movement_detected`) rather than fabricated
phase boundaries.

## 5. Trajectory analysis — `trajectory-analysis.js`

Re-runs Phase 1's `computeShoulderAngles` per filtered frame within the
movement window (movement start → movement end) to build an elevation-angle
curve, then differentiates:

```
velocity[i]     = (angle[i+1] - angle[i-1]) / (t[i+1] - t[i-1])     (central difference, preferred)
acceleration[i] = (velocity[i+1] - velocity[i-1]) / (t[i+1] - t[i-1])
jerk[i]         = (acceleration[i+1] - acceleration[i-1]) / (t[i+1] - t[i-1])
```

One-sided differences are used at sequence edges or wherever a neighbor is
`null`. This is **dt-aware**: it uses actual elapsed time between valid
samples, not an assumed fixed frame rate, so irregular timestamps or
dropped frames don't corrupt the derivative (verified in
`scripts/verify-motion.mjs`'s "Frame drops" case).

**Confidence degrades with derivative order** — a well-known property of
numerical differentiation of a discrete, noisy signal: dividing a
difference by a small `dt` amplifies whatever noise remains, even after
Savitzky-Golay smoothing of the source. Elevation angle keeps its Phase 1
rating (measured/moderate — filtering reduces noise, it doesn't change
what *kind* of claim the measurement is). Velocity: estimated/moderate.
Acceleration and jerk: both estimated/low, with jerk explicitly documented
as the least reliable of the three — treat *trends* in jerk across a
session as more meaningful than any single point's absolute value.

**Trajectory length & path efficiency** (reach phase only — movement start
to peak, not the return trip, since the reach's efficiency is the
clinically relevant question):

```
trajectoryLength = Σ |wrist[i] - wrist[i-1]|              (3D, landmark-units)
pathEfficiency = min(1, straightLineDistance(start, peak) / trajectoryLength) × 100
```

100 = perfectly direct path; lower = more wasted/indirect motion. By the
triangle inequality, `trajectoryLength ≥ straightLineDistance` always, so
this ratio is naturally bounded in (0, 1].

**Compensation timeline**: Phase 1's `detectCompensation` re-applied per
frame across the movement window — inherits that function's estimated/low
rating (depends on MediaPipe's weak monocular depth estimate for the
rotation component).

**Symmetry timeline**: `unavailable` — same reason as ASRI's Symmetry
category (Phase 2): requires bilateral capture, not supported by the
current single-arm-per-session protocol.

## 6. Dynamic Movement Quality Engine — `dmqe-engine.js`

Mirrors ASRI's architecture: every domain is a `{value, measurementType,
confidence, limitation}` envelope (`shared/biomechanics/parameter-schema.js`,
reused directly), domains are confidence-weighted into a composite score,
and a full contribution trace is returned — not just a final number.

### 6.1 Smoothness — Log Dimensionless Jerk (LDLJ)

```
LDLJ = -ln( (T³ / v_peak²) × ∫ jerk(t)² dt )
```

`T` = reach-phase duration, `v_peak` = peak angular velocity magnitude in
that window, integral approximated via the trapezoidal rule over the
discrete jerk curve. Higher (less negative) = smoother. This is the
Hogan & Sternad (2009) / Balasubramanian et al. dimensionless-jerk
smoothness family, **adapted here to the angular elevation signal** rather
than the classical Cartesian hand-position jerk — a deliberate choice to
reuse the single elevation/velocity/jerk curve pipeline already computed
in `trajectory-analysis.js`, rather than maintaining a second, parallel
linear-jerk computation. Documented as an adaptation, not presented as
identical to the literature's original formulation.

The raw LDLJ value is always preserved in the contribution trace. Its
conversion to a 0-100 sub-score (`clamp(50 + LDLJ×5, 0, 100)`) is a
**placeholder linear scaling** — there is no real-cohort LDLJ distribution
yet to calibrate what value should read as 50 vs. 90. This mirrors ASRI's
own "placeholder pending pilot cohort" stance for its weights and reference
targets (Phase 2) exactly.

### 6.2 Stability — trajectory straightness

```
stability_raw = stddev(lateral deviation from the straight start→peak line) / path length
```

Lower raw value = straighter, more stable reach. Converted to a 0-100
score via another placeholder linear scaling
(`clamp(100 - stability_raw×300, 0, 100)`), same caveat as above.

### 6.3 Efficiency

Reused directly from `trajectory-analysis.js`'s `pathEfficiency` (already
0-100 by construction) — no re-derivation.

### 6.4 Angular kinematics summary

Peak values from the velocity/acceleration curves (§5), plus **peak wrist
speed in landmark-units/s** (not deg/s) — computed separately from the
segmentation module's speed profile specifically so it can replace
`shared/biomechanics/motion-quality.js`'s live estimate as the source for
ASRI's `movementSpeed` parameter (Phase 2) without a unit mismatch (see §8).

### 6.5 Pause detection

Additional low-speed intervals within the movement window that fall
**outside** the expected hold phase — using the same speed threshold as
segmentation, a hesitation/pause proxy distinct from the intentional
reach-and-hold behavior the protocol asks for.

### 6.6 Compensation onset / duration

From the per-frame compensation timeline (§5): onset = elapsed time from
movement start to the first frame where the compensation flag activates;
duration = approximate total time the flag was active. Inherits the
underlying flag's estimated/low confidence.

### 6.7 Movement control — corrective submovements

Counts acceleration sign changes within the final 20% of the reach-to-peak
window — an established motor-control proxy: extra deceleration/
reacceleration events near the target indicate a corrective submovement
(overshoot-and-correct), not one clean ballistic approach. Converted to a
0-100 score via `clamp(100 - count×15, 0, 100)`, placeholder scaling.

### 6.8 Trajectory Consistency & Motion Repeatability — `unavailable`

Both are fundamentally **cross-repetition** metrics (comparing multiple
attempts of the same movement against each other), but each of the 4 tasks
is captured once per session. Reported as `measurementType: "unavailable"`
with an explicit limitation string rather than a fabricated single-rep
proxy — confirmed with the project owner as the correct approach for this
phase. The module is architected so these become computable automatically
once a future capture-flow change adds repeated trials per task; no other
code would need to change.

### 6.9 Fatigue indicators — deliberately not implemented

The brief's own condition — "only if scientifically justified" — is
answered here as **not justified**, and that conclusion is itself
documented as a contribution entry (`fatigueIndicators`, status
`unavailable`) rather than silently omitted. Reasoning: a single ~7s task
repetition provides no baseline/rest comparison and no physiological
signal to assess fatigue against. Comparing trends across the 4 *different*
tasks in a session would confound fatigue with each task's distinct
inherent difficulty — order effects and task-difficulty effects aren't
separable with this protocol. Fabricating a fatigue score here would
violate the project's core research-integrity requirement more than simply
not producing one.

### 6.10 Composite DMQE score & confidence

```
dmqeScore = Σ(confidenceWeight_i × domainScore_i) / Σ(confidenceWeight_i)   [over scored domains]
```

over `{smoothness, stability, efficiency, pauseCount, movementControl}` —
the bounded 0-100 domains. `confidenceWeight` maps `(measurementType,
confidence)` to a 0-1 multiplier via the same table structure as ASRI
(`measured_high: 1.0, measured_moderate: 0.8, estimated_moderate: 0.6,
estimated_low: 0.35, unavailable: 0`).

**Movement Confidence %** additionally multiplies in a **data-completeness
factor** — the fraction of frames in the movement window that had an
actual MediaPipe detection, before any filter reconstruction:

```
movementConfidencePct = (meanConfidenceWeight × 100) × dataCompletenessFraction
```

This is why a sequence with a large contiguous gap of missing landmarks
reports meaningfully lower confidence than a cleanly-tracked one, even when
the filter successfully reconstructs enough of the gap to avoid a crash —
verified directly in `scripts/verify-motion.mjs` ("Confidence comparison"
case: a clean sequence reports ~45% confidence, an otherwise-identical
sequence with a ~1.3s tracking gap reports ~24%).

## 7. Scope decision: no externalized DMQE config (yet)

Unlike ASRI (Phase 2), DMQE's domain weights are inline documented
constants in `dmqe-engine.js`, not a versioned external JSON config. Phase
2's config-externalization was an explicit requirement for ASRI; Phase 3's
brief for DMQE emphasizes measurement rigor and confidence rather than
repeating that architecture. Externalizing DMQE's weights into a
`VersionedConfigStore`-backed config (the same mechanism `asri-engine.js`
already provides generically) is a natural, low-risk future enhancement,
deliberately not built here to keep this already-large phase bounded.

## 8. DMQE → ASRI integration (no circular dependency)

`capture/app.js`'s `runCurrentTask()` uses `dmqe.domains.smoothness` and
`dmqe.domains.peakWristSpeed` as the **source values** for the
`movementSmoothness` / `movementSpeed` parameter keys ASRI's
`asri-config.v2.json` already declares (Phase 2) — same
parameter-schema shape, same units (`score(0-100)` and
`landmark-units/s` respectively). **Zero changes to ASRI's config or
scoring code.** `shared/biomechanics/motion-quality.js` (the Phase 1 live
estimate) is untouched and still drives the real-time on-screen readout
during capture — a different job (immediate UX feedback) from DMQE's
rigorous post-hoc full-sequence analysis. DMQE's richer outputs (stability,
efficiency, jerk, pauses, compensation timing, movement control) are
stored alongside every task result but not yet weighted into ASRI's
composite — available for a future ASRI config version to incorporate.

Dependency direction is strictly one-way: `dmqe-engine.js` depends on
`trajectory-analysis.js` and `segmentation.js`; `trajectory-analysis.js`
depends on `segmentation.js` and the Biomechanical Engine;
`segmentation.js` depends on nothing but `landmark-filter.js`'s output
shape. No module in `shared/motion/` imports from `shared/asri/`, and
`shared/asri/asri-engine.js` never imports from `shared/motion/` — the
integration happens entirely in `capture/app.js`, outside both engines.

## 9. What this phase does and does not establish

Confirmed by `scripts/verify-motion.mjs` (16 checks, all passing): the
pipeline runs every frame of a task through filtering, segmentation, and
DMQE without crashing across no-movement, slow, fast, interrupted,
poor-tracking, and frame-drop scenarios, and confidence measurably degrades
(not just floors at some fixed low value) as tracking quality degrades.

This is **not** clinical validation. It confirms the pipeline is internally
robust and mathematically consistent under synthetic conditions, not that
LDLJ-derived smoothness, the stability/efficiency ratios, or the
placeholder 0-100 scalings agree with any established clinical reference
standard for movement quality in children with OBPP. That comparison is
the explicit purpose of the planned Validation Engine
(`shared/validation/README.md`) and requires real paired clinician
assessment, not synthetic sequences.

## 10. Readiness for clinical validation

Not ready as-is, and this document should say so plainly: the 0-100
scalings for smoothness, stability, and movement control are placeholders
with no empirical basis yet, segmentation's velocity thresholds are
uncalibrated constants, and DMQE's domain weights are inline rather than
externally fittable. Before any validation study, these would need
real-cohort calibration — exactly the same category of work already
flagged as outstanding for ASRI's reference targets and weights (Phase 2).
