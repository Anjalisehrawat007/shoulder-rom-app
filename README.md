# Shoulder Kinematics Capture — Hoffer Tendon Transfer Protocol

A browser-based prototype for the capture and scoring workflow described in
*"Three-Dimensional Motion Analysis of Shoulder Kinematics Following Hoffer
Tendon Transfer in Children with Obstetric Brachial Plexus Palsy."*

It has three parts:

- **`capture/`** — the patient-facing camera app. Guides the child through four
  standardized tasks (reach the head, reach the mouth, comb the hair, lift the
  arm sideways), tracks pose in real time, auto-captures still photos at the
  representative moment of each task, and computes the kinematic parameter set
  live.
- **`backend/`** — a small Express + SQLite sync server. This is what lets a
  session captured on the child's phone/tablet be opened later on the
  clinician's computer — without it, sessions were only ever readable from the
  exact device that captured them (browser-local IndexedDB doesn't sync
  anywhere on its own).
- **`doctor-portal/`** — an access-code-gated viewer where a clinician enters a
  session ID + one-time access code to review the captured photos and
  parameters, and see the composite recovery score, from any device.

The `capture/` and `doctor-portal/` apps are static HTML/JS talking to the
backend over HTTP — no build step for the frontend.

## Running it

**1. Start the backend** (needs Node 18+):

```
cd shoulder-rom-app/backend
npm install
npm start
# listening on http://localhost:4000
```

This creates `backend/data/rom.sqlite` (session/parameter records) and
`backend/data/captures/` (photo files) on first run, and auto-publishes
`config/theta-config.v1.json` as theta version `1.0.0`.

**2. Serve the frontend** from the project root in a second terminal:

```
cd shoulder-rom-app
python3 -m http.server 8000
# capture app:   http://localhost:8000/capture/index.html
# doctor portal: http://localhost:8000/doctor-portal/index.html
```

Both pages default to `http://localhost:4000` for the backend
(`shared/config.js`). For a real deployment, host the backend somewhere
reachable from both the capture device and the clinician's device, and set
`window.SHOULDER_ROM_BACKEND_URL` before the app scripts load (e.g. in a
small inline `<script>` in each `index.html`) to that URL.

A camera and, ideally, a phone/tablet browser is recommended so that
"flip camera" genuinely switches between front and rear sensors (most laptops
only have a front camera, so the app falls back gracefully if no rear camera
exists).

### Credential model

Session creation returns two separate one-time secrets — this split is
deliberate:

- **`captureToken`** — held only by the capturing device, required to write
  task results and photos. Never shown to the clinician.
- **`accessCode`** — the short human-readable code shown to the clinician,
  required to *unlock* (read) a session. Only its SHA-256 hash is ever stored.
  Unlocking issues a **review token** valid for 60 minutes, which gates photo
  downloads — so a copied photo URL can't be replayed indefinitely.

`shared/storage.js` (the original local-only IndexedDB implementation) is
still included for reference / offline-capture experiments, but the apps now
use `shared/api-storage.js` by default, which talks to the backend.

## Architecture

```
shared/
  theta-engine.js   — the versioned, re-fittable weight (theta) scoring system
                       (required by both the frontend and the backend)
  api-storage.js    — frontend client for the backend (default storage layer)
  storage.js        — original local-only IndexedDB storage (kept for reference)
  config.js         — BACKEND_URL for the frontend
  style.css         — shared visual identity
capture/
  pose-engine.js    — MediaPipe PoseLandmarker wrapper + kinematic math
  app.js            — camera control, task protocol, capture, scoring
  index.html
doctor-portal/
  portal.js, index.html
backend/
  server.js         — Express API: sessions, task results, photo uploads,
                       access-code unlock, theta-config versioning
  db.js             — SQLite schema (sessions, task_results, captures,
                       theta_versions, review_tokens)
  data/             — sqlite file + uploaded photos (gitignored in practice)
config/
  theta-config.v1.json — first published weight version
```

## The theta (θ) scoring architecture

This is the part of the system most distinct from prior "camera measures
range-of-motion" tools, because it concerns **how the composite score is
computed and maintained over time**, not pose estimation itself. Four
properties, all implemented in `shared/theta-engine.js`:

1. **External, versioned weight configuration.** Domain weights live in
   `config/theta-config.v1.json`, not in the scoring code. `ThetaConfigStore`
   refuses to overwrite a published version — re-fitting weights on new cohort
   data must publish `1.1.0`, `1.2.0`, etc. Every session records which
   version scored it, so a session can always be re-scored later using the
   *exact* weights active on the day it was captured (see
   `doctor-portal/portal.js`, which deliberately looks up the session's
   original `thetaVersion` rather than the latest one).

2. **Continuous two-endpoint blending.** Each domain weight is a pair,
   `{early, late}`, not a single number. The weight actually applied is
   `lerp(early, late, φ(stage))`, where `φ` is a sigmoid of recovery stage
   (`ThetaEngine.effectiveWeights`). This shifts emphasis smoothly across
   recovery — e.g. from protective early-stage domains toward functional
   late-stage domains — with no discontinuity at a "phase boundary."

3. **Renormalization over captured parameters only.** `ThetaEngine.score()`
   excludes any domain not marked `captured` from both the numerator and the
   weight-sum denominator, instead of scoring a missed measurement as zero.
   A session where external rotation couldn't be measured is scored fairly
   over the domains that *were* measured.

4. **Completeness-aware confidence interval.** The reported CI widens both
   with per-domain measurement variance and with how few domains/parameters
   were captured (`kCompleteness * (1 - completeness)` term), so an
   incomplete session visibly shows a wider band rather than a falsely
   precise number.

See the inline comments at the top of `theta-engine.js` for the same
description in a form you can lift directly into a patent specification's
"summary of the invention" section.

## Kinematic parameters captured

| Parameter | How it's computed | Confidence |
|---|---|---|
| Shoulder abduction / flexion | Angle of the upper-arm vector from the trunk axis, split by lateral vs. anterior component | Research-grade estimate |
| External / internal rotation | Forearm vector projected perpendicular to the humeral axis vs. a vertical reference | Approximate — most reliable near ~90° elbow flexion, which the four tasks are chosen to elicit |
| Scapular upward rotation / tilt | Heuristic proxies derived from shoulder landmark depth and coupling to abduction | **Proxy only** — flagged for clinician confirmation on the captured photo |
| Scapular winging | Asymmetry heuristic on shoulder landmark depth | **Flag only**, not a measurement — always requires clinician confirmation |
| Trunk compensation | Lateral lean of the shoulder-hip line from vertical + a shoulder-depth-difference rotation proxy | Approximate |
| Speed / smoothness | Wrist-trajectory velocity and a simplified velocity-inflection smoothness score over the task window | Approximate |

