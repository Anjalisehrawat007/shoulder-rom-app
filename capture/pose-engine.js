/**
 * pose-engine.js — Landmark Detection
 * ----------------------------------------------------------------------------
 * The ONLY module in this system that touches MediaPipe directly (spec §11:
 * "No module should directly depend on MediaPipe except Landmark
 * Detection"). Wraps MediaPipe Tasks Vision PoseLandmarker to turn video
 * frames into raw landmarks, buffers a short history for motion-quality
 * analysis, and delegates all clinical computation to
 * shared/biomechanics/index.js (the Biomechanical Engine orchestrator).
 *
 * IMPORTANT SCIENTIFIC / CLINICAL LIMITATION (see docs/biomechanics.md for
 * the full derivation, assumptions, and per-parameter confidence):
 *   A single RGB smartphone/webcam camera estimates 3D landmark positions
 *   monocularly. This is NOT equivalent to marker-based multi-camera motion
 *   capture (e.g. Vicon). Every parameter returned by computeParameters()
 *   carries a `measurementType` ("measured" | "estimated" | "unavailable")
 *   and a `limitation` string rather than being presented as an
 *   undifferentiated clinical measurement.
 *
 * TWO SEPARATE HISTORY BUFFERS (Phase 3): `_history` is a short rolling
 * buffer (capped at 60 frames) that exists only to drive the live on-screen
 * readout during capture -- unchanged since Phase 1, still fine for that
 * real-time UX purpose. `_taskHistory` is a NEW, separately-scoped buffer
 * cleared at the start of each task (`startTaskCapture()`) and left
 * unbounded for that task's ~7s window, so `getTaskHistory()` returns EVERY
 * frame of that task for the full-sequence pipeline
 * (shared/motion/landmark-filter.js onward) -- not a recent slice of
 * whatever was happening in the last ~2s of camera activity, which is what
 * `_history` alone would give you if reused for this purpose.
 *
 * SECONDARY LANDMARKER (Phase 5, ICQA): a second, separate PoseLandmarker
 * instance configured with numPoses:2, created lazily and used ONLY by
 * detectSecondary() during the pre-task ICQA gate (see shared/icqa/
 * visibility-analysis.js's multi-person check) -- never in the main
 * per-frame task-capture loop, so live capture performance during the
 * actual 7s recording window is completely unaffected. This keeps
 * multi-person detection real (a genuine numPoses:2 pass) rather than an
 * inferred proxy, at the cost of extra latency confined to the gate check.
 *
 * VIDEO CAPTURE (Phase 6, Modified Mallet): startVideoCapture()/
 * stopVideoCapture() wrap the browser's own MediaRecorder API against the
 * SAME camera stream startCamera() already opened in capture/app.js --
 * this class doesn't open a second stream or touch MediaPipe for this,
 * it only starts/stops a recorder alongside the existing per-task landmark
 * capture window. Feature-detected: browsers/devices without MediaRecorder
 * support simply don't get a stored video for that task (`supported:
 * false`), never a crash or a fabricated file.
 * ----------------------------------------------------------------------------
 */
import { LM, computeParameters, computeMotion } from "../shared/biomechanics/index.js";

const VIDEO_MIME_CANDIDATES = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];

class PoseEngine {
  constructor() {
    this.landmarker = null;
    this.ready = false;
    this._history = []; // {t, landmarks} for the live readout only (capped, rolling)
    this._taskHistory = []; // {t, landmarks} for the current task's full sequence (uncapped)
    this._capturingTask = false;
    this._vision = null; // cached FilesetResolver result, reused to create the secondary landmarker without a second WASM fetch
    this._secondaryLandmarker = null;
    this._mediaRecorder = null;
    this._videoChunks = null;
  }

  async init() {
    this._vision = await window.MediapipeTasksVision.FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    this.landmarker = await window.MediapipeTasksVision.PoseLandmarker.createFromOptions(this._vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    this.ready = true;
  }

  /** Fire-and-forget warm-up, called once from boot() right after the main
   *  landmarker is ready. Without this, the FIRST pre-task ICQA gate check
   *  of a session pays the full secondary-model creation cost (a second
   *  model fetch + GPU init, observed to take multiple seconds) inline,
   *  which is a noticeably worse first impression than every gate check
   *  after it (cached, just a detectForVideo() call). Errors are swallowed
   *  here on purpose -- countPeople() re-attempts creation and degrades to
   *  "unavailable" on failure regardless, see its own doc comment. */
  preloadSecondaryLandmarker() {
    this._ensureSecondaryLandmarker().catch(() => {});
  }

  /** Lazily create the numPoses:2 landmarker used only for the ICQA
   *  pre-task multi-person check. Not created until first needed, so
   *  sessions that never trigger a gate re-check (or browsers where this
   *  fails) don't pay the cost. */
  async _ensureSecondaryLandmarker() {
    if (this._secondaryLandmarker) return this._secondaryLandmarker;
    this._secondaryLandmarker = await window.MediapipeTasksVision.PoseLandmarker.createFromOptions(this._vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 2,
    });
    return this._secondaryLandmarker;
  }

  /** Run the secondary (numPoses:2) landmarker once and return how many
   *  people were detected. Used only by the ICQA gate, at reduced
   *  frequency -- see shared/icqa/visibility-analysis.js. Returns null
   *  (not 0/1) if the secondary landmarker couldn't be created (e.g. a
   *  device that can't afford a second GPU-backed model instance), so
   *  callers can tell "checked, found 1 person" apart from "didn't check."
   */
  async countPeople(videoEl) {
    try {
      const landmarker = await this._ensureSecondaryLandmarker();
      const result = landmarker.detectForVideo(videoEl, performance.now());
      return result.landmarks ? result.landmarks.length : 0;
    } catch (e) {
      return null;
    }
  }

  /** Grab the current video frame as a plain {width, height, data} RGBA
   *  buffer, the same shape shared/icqa/frame-quality.js expects (and the
   *  same shape Node's synthetic tests use, with no DOM dependency). Reuses
   *  the exact offscreen-canvas drawImage pattern captureStill() already
   *  used before this phase, factored out here so both call sites share it
   *  instead of duplicating the boilerplate. `maxDim` downsizes the grab
   *  (frame-quality analysis doesn't need full resolution and this keeps
   *  per-check cost low enough to run before every task). */
  grabFrame(videoEl, maxDim = 240) {
    const vw = videoEl.videoWidth || 1;
    const vh = videoEl.videoHeight || 1;
    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const octx = off.getContext("2d");
    octx.drawImage(videoEl, 0, 0, w, h);
    const imageData = octx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: imageData.data };
  }

  /** Run detection on a single video frame. Returns raw landmarks or null.
   *  A null-landmark frame (failed detection) is still recorded in both
   *  history buffers as {t, lm: null} when task capture is active, rather
   *  than silently skipped -- shared/motion/landmark-filter.js needs to know
   *  a frame was attempted and missed, not just see a gap in timestamps. */
  detect(videoEl, timestampMs) {
    if (!this.ready) return null;
    const result = this.landmarker.detectForVideo(videoEl, timestampMs);
    const lm = result.landmarks && result.landmarks.length > 0 ? result.landmarks[0] : null;

    if (lm) {
      this._history.push({ t: timestampMs, lm });
      if (this._history.length > 60) this._history.shift();
    }
    if (this._capturingTask) {
      this._taskHistory.push({ t: timestampMs, lm });
    }
    return lm;
  }

  /** Begin collecting a fresh, unbounded, task-scoped frame history. Call at
   *  the start of each task window (runCurrentTask in capture/app.js). */
  startTaskCapture() {
    this._taskHistory = [];
    this._capturingTask = true;
  }

  /** Stop collecting and return every frame recorded since startTaskCapture()
   *  (including failed-detection frames as {t, lm: null}), for the
   *  full-sequence pipeline (shared/motion/*). */
  getTaskHistory() {
    this._capturingTask = false;
    return this._taskHistory;
  }

  /** Start recording a video clip of `stream` (the same MediaStream
   *  capture/app.js's startCamera() already opened -- this does NOT open a
   *  second camera stream). Call alongside startTaskCapture(). Returns
   *  {supported: false} on any browser/device without MediaRecorder or a
   *  supported mime type, rather than throwing -- video is an enhancement
   *  to a task result, never a requirement for the task itself to work. */
  startVideoCapture(stream) {
    if (typeof MediaRecorder === "undefined") return { supported: false };
    const mimeType = VIDEO_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mimeType) return { supported: false };
    try {
      // `chunks` is captured by the closure below, NOT re-read from
      // `this._videoChunks` on each event -- MediaRecorder.stop() fires one
      // final `ondataavailable` flush AFTER stopVideoCapture() has already
      // set `this._videoChunks = null` (to avoid the NEXT task's recorder
      // colliding with it), so reading the instance property inside the
      // handler would throw on that final event. Closing over the array
      // reference itself sidesteps the race entirely.
      const chunks = [];
      this._videoChunks = chunks;
      this._mediaRecorder = new MediaRecorder(stream, { mimeType });
      this._mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      this._mediaRecorder.start();
      return { supported: true, mimeType };
    } catch (e) {
      this._mediaRecorder = null;
      this._videoChunks = null;
      return { supported: false };
    }
  }

  /** Stop recording and resolve to the captured video as a Blob, or null if
   *  video capture wasn't supported/started for this task. */
  stopVideoCapture() {
    if (!this._mediaRecorder) return Promise.resolve(null);
    const recorder = this._mediaRecorder;
    const chunks = this._videoChunks;
    this._mediaRecorder = null;
    this._videoChunks = null;
    if (recorder.state === "inactive") {
      return Promise.resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null);
    }
    return new Promise((resolve) => {
      recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null);
      recorder.stop();
    });
  }

  /** Last `n` entries of the short rolling `_history` buffer, as {t, lm}
   *  frames -- used by shared/icqa/tracking-stability.js both for the
   *  pre-task gate (a slightly longer window) and for periodic in-recording
   *  sampling (a shorter one). Deliberately reuses `_history` rather than a
   *  third buffer: it already accumulates continuously during live camera
   *  activity, which is exactly the "how stable has tracking been
   *  recently" signal ICQA needs, with no extra bookkeeping. */
  getRecentHistory(n = 12) {
    return this._history.slice(-n);
  }

  /** Compute the full clinical parameter set for the current frame. Delegates
   *  to the Biomechanical Engine (shared/biomechanics/index.js) -- this
   *  class no longer contains any anatomical math itself. */
  computeParameters(lm, side = "right") {
    return computeParameters(lm, side);
  }

  /** Speed & smoothness of the wrist trajectory over the buffered history. */
  computeMotionQuality(side = "right") {
    return computeMotion({ history: this._history, side });
  }
}

export { PoseEngine, LM };
