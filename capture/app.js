/**
 * app.js — capture session controller
 * Ties together: camera (front/back), PoseEngine (Landmark Detection,
 * delegating to the Biomechanical Engine), the full-sequence motion pipeline
 * (Phase 3: filter -> segment -> trajectory -> DMQE), ICQA (Phase 5), the
 * Modified Mallet Assessment Workflow (Phase 6: shared/assessment/*), and
 * the ASRI Engine composite score.
 *
 * Phase 6 note: the flat 4-task protocol from Phases 1-5 is replaced by the
 * 6-task Modified Mallet protocol (shared/assessment/TaskDefinitions.js),
 * driven through shared/assessment/ModifiedMalletWorkflow.js instead of a
 * local TASKS array + inline filter/DMQE calls. This file is now a thinner
 * DOM-binding layer: it owns the camera/video/canvas, the countdown/
 * recording UI, and translates user actions into workflow calls -- the
 * actual per-task pipeline (filter -> DMQE -> Mallet measurements -> grade)
 * lives in shared/assessment/TaskRecorder.js, extracted from what used to
 * be inline here. ASRI's scoring call itself is UNCHANGED (same
 * AsriEngine/perTaskParameters shape) -- only how perTaskParameters gets
 * assembled changed (workflow.buildAsriPerTaskParameters() instead of a
 * local reduce over state.taskResults).
 *
 * Phase 5's ICQA gate/idle-preview/pausable-timer/quality-timeline pieces
 * are REUSED VERBATIM below (same functions, same logic) -- only the call
 * sites around them changed to fit the new task-review-before-advancing
 * flow.
 */
import { PoseEngine } from "./pose-engine.js";
import { AsriEngine, VersionedConfigStore } from "../shared/asri/asri-engine.js";
import { resolveReferenceDataset } from "../shared/asri/reference-datasets.js";
import { analyzeCameraGeometry } from "../shared/icqa/camera-geometry.js";
import { analyzeFrameQuality } from "../shared/icqa/frame-quality.js";
import { analyzeVisibility } from "../shared/icqa/visibility-analysis.js";
import { analyzeStability } from "../shared/icqa/tracking-stability.js";
import { IcqaEngine } from "../shared/icqa/icqa-engine.js";
import { VersionedConfigStore as IcqaConfigStore } from "../shared/icqa/config-store.js";
import { buildGuidance } from "../shared/icqa/guidance-engine.js";
import { evaluateGate } from "../shared/icqa/recording-gate.js";
import { startTimeline, sample as sampleTimeline, finalize as finalizeTimeline } from "../shared/icqa/quality-timeline.js";
import { ModifiedMalletWorkflow } from "../shared/assessment/ModifiedMalletWorkflow.js";
import { VersionedConfigStore as MalletConfigStore } from "../shared/assessment/mallet-score-config-store.js";
import { getInstructionsForTask, speak, cancelSpeech } from "../shared/assessment/TaskInstructions.js";

const RESUME_STORAGE_KEY = "shoulder_rom_mallet_session";

const state = {
  side: "right",
  stage01: 0.5,
  ageMonths: null,
  monthsSinceSurgery: null,
  patientLabel: "unlabeled",
  facing: "user",
  sessionId: null,
  running: false,
  latestParams: null,
  latestLandmarks: null, // raw lm array from the most recent detect() call, for ICQA
  deviceOrientation: null, // {alpha, beta, gamma} from DeviceOrientationEvent, when available
  taskCollected: [], // frames collected in current task window
  activeTimer: null, // the pausable task-duration timer, while a task is recording
  activeTimeline: null, // the in-progress ICQA quality timeline, while a task is recording
  pendingCameraQuality: null, // gate result captured at the moment the current task started
  pendingResult: null, // {envelope, recorderResult, videoBlob} for the task currently in Task Review, not yet confirmed
  taskStartMs: null,
};

let poseEngine, storage, asriEngine, asriConfigStore, referenceConfig;
let icqaEngine, icqaConfigStore;
let malletConfigStore, workflow;
let videoEl, canvasEl, ctx, streamRef;

/** Loads one versioned config, preferring the backend and falling back to the
 *  bundled file. A reachable /api/health does NOT imply the config endpoints
 *  are present -- a backend deployed before the config routes existed answers
 *  health with 200 and every /api/*-config path with a 404 HTML body, on which
 *  the old unguarded `.then(r => r.json())` threw a SyntaxError that rejected
 *  boot() before a single listener was attached, leaving every button on the
 *  page dead with no visible error. Status is checked explicitly, and any
 *  remote failure falls through to the local copy instead of killing boot. */
async function loadVersionedConfig(remotePath, localPath, backendUp) {
  if (backendUp) {
    try {
      const res = await fetch(`${BACKEND_URL}${remotePath}`);
      if (res.ok) return await res.json();
      console.warn(`[boot] ${remotePath} returned ${res.status} — falling back to ${localPath}`);
    } catch (err) {
      console.warn(`[boot] ${remotePath} failed (${err.message}) — falling back to ${localPath}`);
    }
  }
  const res = await fetch(localPath);
  if (!res.ok) throw new Error(`could not load ${localPath} (${res.status}) and the backend copy of ${remotePath} was unavailable`);
  return res.json();
}

async function boot() {
  const backendUp = await fetch(`${BACKEND_URL}/api/health`).then((r) => r.ok).catch(() => false);
  if (!backendUp) {
    document.getElementById("bootStatus").textContent =
      "backend unreachable — start it with `npm start` in /backend, or sessions won't be reviewable from another device";
  }
  storage = new ApiStorage(BACKEND_URL);
  asriConfigStore = new VersionedConfigStore();
  const asriCfg = await loadVersionedConfig("/api/asri-config/2.0.0", "../config/asri-config.v2.json", backendUp);
  asriConfigStore.publish(asriCfg);
  asriEngine = new AsriEngine(asriConfigStore.getActive());

  referenceConfig = await loadVersionedConfig("/api/reference-datasets/1.0.0", "../config/reference-datasets.v1.json", backendUp);

  icqaConfigStore = new IcqaConfigStore();
  const icqaCfg = await loadVersionedConfig("/api/icqa-config/1.0.0", "../config/icqa-config.v1.json", backendUp);
  icqaConfigStore.publish(icqaCfg);
  icqaEngine = new IcqaEngine(icqaConfigStore.getActive());

  malletConfigStore = new MalletConfigStore();
  const malletCfg = await loadVersionedConfig("/api/mallet-score-config/1.0.0", "../config/mallet-score-config.v1.json", backendUp);
  malletConfigStore.publish(malletCfg);
  workflow = new ModifiedMalletWorkflow({ malletScoreConfig: malletConfigStore.getActive() });

  videoEl = document.getElementById("video");
  canvasEl = document.getElementById("overlay");
  ctx = canvasEl.getContext("2d");

  document.getElementById("startSessionBtn").addEventListener("click", startSession);
  document.getElementById("beginAssessmentBtn").addEventListener("click", beginAssessment);
  document.getElementById("toggleCameraBtn").addEventListener("click", toggleCamera);
  document.getElementById("startTaskBtn").addEventListener("click", () => runCurrentTask(false));
  document.getElementById("startAnywayBtn").addEventListener("click", () => runCurrentTask(true));
  document.getElementById("recheckBtn").addEventListener("click", () => refreshIcqaPanel(true)); // an explicit user re-check runs the full (authoritative) pass, including multi-person
  document.getElementById("speakInstructionBtn").addEventListener("click", () => {
    const task = workflow.currentTask;
    if (task) speak(`${task.label}. ${task.instruction}`);
  });
  document.getElementById("continueToNextTaskBtn").addEventListener("click", continueToNextTask);
  document.getElementById("retryTaskBtn").addEventListener("click", retryCurrentTask);
  document.getElementById("copySessionIdBtn").addEventListener("click", () =>
    navigator.clipboard.writeText(document.getElementById("sessionIdDisplay").textContent)
  );
  document.getElementById("copyCodeBtn").addEventListener("click", () =>
    navigator.clipboard.writeText(document.getElementById("codeDisplay").textContent)
  );
  document.getElementById("continueBtn").addEventListener("click", dismissAccessCodeModal);
  document.getElementById("resumeBtn").addEventListener("click", resumeAssessment);
  document.getElementById("discardResumeBtn").addEventListener("click", () => {
    localStorage.removeItem(RESUME_STORAGE_KEY);
    document.getElementById("resumeBanner").classList.add("hidden");
  });

  poseEngine = new PoseEngine();
  await poseEngine.init();
  poseEngine.preloadSecondaryLandmarker(); // warm the ICQA multi-person model now, not on the first gate check
  if (backendUp) document.getElementById("bootStatus").textContent = "pose model ready · backend connected";

  checkForResumableSession();
}

function checkForResumableSession() {
  const saved = localStorage.getItem(RESUME_STORAGE_KEY);
  if (!saved) return;
  let parsed;
  try {
    parsed = JSON.parse(saved);
  } catch {
    localStorage.removeItem(RESUME_STORAGE_KEY);
    return;
  }
  document.getElementById("resumeSummaryText").textContent =
    `${parsed.patientLabel || parsed.sessionId} · ${parsed.side} side · saved ${new Date(parsed.savedAt).toLocaleString()}`;
  document.getElementById("resumeBanner").classList.remove("hidden");
}

async function startCamera(facing) {
  if (streamRef) streamRef.getTracks().forEach((t) => t.stop());
  streamRef = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } },
    audio: false,
  });
  videoEl.srcObject = streamRef;
  await videoEl.play();
  canvasEl.width = videoEl.videoWidth;
  canvasEl.height = videoEl.videoHeight;
  requestAnimationFrame(frameLoop);
}

async function toggleCamera() {
  state.facing = state.facing === "user" ? "environment" : "user";
  document.getElementById("facingLabel").textContent = state.facing === "user" ? "FRONT" : "REAR";
  try {
    await startCamera(state.facing);
  } catch (e) {
    // Many laptops have no rear camera; fall back gracefully.
    state.facing = "user";
    document.getElementById("facingLabel").textContent = "FRONT (rear unavailable)";
    await startCamera("user");
  }
}

let _lastTimelineSampleMs = 0;

function frameLoop(ts) {
  if (videoEl.readyState >= 2) {
    const lm = poseEngine.detect(videoEl, performance.now());
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    state.latestLandmarks = lm;
    if (lm) {
      drawSkeleton(lm);
      const params = poseEngine.computeParameters(lm, state.side);
      const motion = poseEngine.computeMotionQuality(state.side);
      state.latestParams = { ...params, ...motion };
      renderReadout(state.latestParams);
      updateLiveLandmarkConfidence(lm);
      if (state.running) collectFrame(params);
    }
    if (!state.running) drawGuidanceOverlay();
    if (state.running && state.activeTimeline) sampleQualityDuringRecording(performance.now());
    if (state.running && state.taskStartMs != null) updateRecordingTimer(performance.now());
  }
  requestAnimationFrame(frameLoop);
}

/** Fraction of the 33 landmarks visible above a fixed display threshold,
 *  as a quick "landmark confidence" readout distinct from the full ICQA
 *  panel -- a lightweight, always-on signal rather than another full gate
 *  check every frame. */
function updateLiveLandmarkConfidence(lm) {
  const visible = lm.filter((p) => p && (p.visibility ?? 0) > 0.5).length;
  const pct = Math.round((visible / lm.length) * 100);
  document.getElementById("liveLandmarkConfidence").textContent = `${pct}%`;
}

function updateRecordingTimer(nowMs) {
  const elapsedSec = (nowMs - state.taskStartMs) / 1000;
  document.getElementById("recordingTimer").textContent = `${elapsedSec.toFixed(1)}s`;
}

/** A static dashed "ideal standing box" + center line, drawn between tasks
 *  (not during active recording, where skeleton-only drawing continues
 *  unchanged) so a caregiver has a visual target even before the ICQA
 *  panel calls out a specific problem. Matches the same bounding-box
 *  fractions shared/icqa/camera-geometry.js's distance heuristic treats as
 *  "ideal" (see config/icqa-config.v1.json's distance thresholds). */
function drawGuidanceOverlay() {
  const w = canvasEl.width, h = canvasEl.height;
  ctx.save();
  ctx.strokeStyle = "#E0A339AA";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(w * 0.3, h * 0.05, w * 0.4, h * 0.9);
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 0);
  ctx.lineTo(w * 0.5, h);
  ctx.stroke();
  ctx.restore();
}

/** Periodic, throttled quality sample taken during an active recording
 *  window -- deliberately cheaper than the pre-task gate check (no
 *  secondary-landmarker multi-person pass; that only runs pre-task, see
 *  pose-engine.js) so it doesn't compete with the main tracking loop for
 *  GPU time mid-recording. Also drives the live CQI readout. */
function sampleQualityDuringRecording(nowMs) {
  const interval = icqaConfigStore.getActive().timeline.sampleIntervalMs;
  if (nowMs - _lastTimelineSampleMs < interval) return;
  _lastTimelineSampleMs = nowMs;
  if (!state.latestLandmarks) return;

  const cfg = icqaConfigStore.getActive();
  const geometry = analyzeCameraGeometry({ landmarks: state.latestLandmarks, deviceOrientation: state.deviceOrientation, config: cfg });
  const frameQuality = analyzeFrameQuality({ imageData: poseEngine.grabFrame(videoEl), bboxNormalized: geometry.bbox });
  const visibility = analyzeVisibility({ landmarks: state.latestLandmarks, secondaryPersonCount: null, config: cfg });
  const stability = analyzeStability(poseEngine.getRecentHistory(8));
  const icqaResult = icqaEngine.score({ geometry, frameQuality, visibility, stability });
  document.getElementById("liveCqiReadout").textContent = icqaResult.cqi ?? "—";

  const tSec = (nowMs - state.taskStartMs) / 1000;
  const { autoPauseTriggered } = sampleTimeline(state.activeTimeline, icqaResult, tSec, cfg);
  if (autoPauseTriggered && state.activeTimer && !state.activeTimer.paused) {
    state.activeTimer.pause();
    document.getElementById("recordingPauseFlag").textContent = "paused — quality dropped, waiting for it to recover";
    document.getElementById("recordingPauseFlag").classList.remove("hidden");
  } else if (!autoPauseTriggered && state.activeTimer && state.activeTimer.paused) {
    state.activeTimer.resume();
    document.getElementById("recordingPauseFlag").classList.add("hidden");
  }
}

function drawSkeleton(lm) {
  const pairs = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [11, 23], [12, 24], [23, 24]];
  ctx.strokeStyle = "#2FA8A0";
  ctx.lineWidth = 3;
  for (const [a, b] of pairs) {
    if (!lm[a] || !lm[b]) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x * canvasEl.width, lm[a].y * canvasEl.height);
    ctx.lineTo(lm[b].x * canvasEl.width, lm[b].y * canvasEl.height);
    ctx.stroke();
  }
}

// M = measured, E = estimated, U = unavailable -- see shared/biomechanics/parameter-schema.js
function badgeFor(measurementType) {
  if (measurementType === "measured") return "M";
  if (measurementType === "estimated") return "E";
  return "U";
}

function fmtParam(p) {
  if (!p || p.value == null) return `— [${badgeFor(p?.measurementType)}]`;
  return `${p.value}° [${badgeFor(p.measurementType)}]`;
}

function renderReadout(p) {
  const rows = [
    ["ABDUCTION", fmtParam(p.shoulderAbductionDeg)],
    ["FLEXION", fmtParam(p.shoulderFlexionDeg)],
    ["ELEVATION", fmtParam(p.shoulderElevationDeg)],
    ["PLANE OF ELEVATION", fmtParam(p.planeOfElevationDeg)],
    ["EXT ROTATION", fmtParam(p.externalRotationDeg)],
    ["INT ROTATION", fmtParam(p.internalRotationDeg)],
    ["SCAP UPWARD ROT", fmtParam(p.scapularUpwardRotationDeg)],
    ["SCAP TILT", fmtParam(p.scapularTiltDeg)],
    ["SCAP WINGING", `${p.scapularWingingFlag?.value ? "FLAG" : "—"} [${badgeFor(p.scapularWingingFlag?.measurementType)}]`],
    ["TRUNK LEAN", `${fmtParam(p.trunkLateralLeanDeg)}${p.trunkCompensationFlag ? "  FLAG" : ""}`],
    ["TRUNK ROTATION", fmtParam(p.trunkRotationDeg)],
    ["SPEED", p.movementSpeed?.value != null ? `${p.movementSpeed.value.toFixed(3)} [${badgeFor(p.movementSpeed.measurementType)}]` : "—"],
    ["SMOOTHNESS", p.movementSmoothness?.value != null ? `${p.movementSmoothness.value} [${badgeFor(p.movementSmoothness.measurementType)}]` : "—"],
  ];
  document.getElementById("readout").innerHTML = rows
    .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v readout">${v}</span></div>`)
    .join("");
}

async function startSession() {
  const hospitalId = document.getElementById("hospitalId").value.trim();
  if (!/^\d{7}$/.test(hospitalId)) {
    alert("Patient hospital ID must be exactly 7 digits, e.g. 1234567.");
    return;
  }
  state.side = document.getElementById("sideSelect").value;
  state.stage01 = parseFloat(document.getElementById("stageSlider").value);
  const ageMonthsRaw = document.getElementById("ageMonths").value.trim();
  const monthsSinceSurgeryRaw = document.getElementById("monthsSinceSurgery").value.trim();
  state.ageMonths = ageMonthsRaw ? parseFloat(ageMonthsRaw) : null;
  state.monthsSinceSurgery = monthsSinceSurgeryRaw ? parseFloat(monthsSinceSurgeryRaw) : null;
  state.patientLabel = document.getElementById("patientLabel").value || "unlabeled";

  let sessionId, accessCode;
  try {
    ({ sessionId, accessCode } = await storage.createSession({
      sessionId: hospitalId,
      patientLabel: state.patientLabel,
      side: state.side,
      asriVersion: asriEngine.config.version,
      referenceDatasetVersion: referenceConfig.version,
      stage01: state.stage01,
      ageMonths: state.ageMonths,
      monthsSinceSurgery: state.monthsSinceSurgery,
      protocol: "modified_mallet",
    }));
  } catch (e) {
    alert(e.message);
    return;
  }
  state.sessionId = sessionId;
  persistResumeState();

  document.getElementById("registrationScreen").classList.add("hidden");
  document.getElementById("sessionIdDisplay").textContent = sessionId;
  document.getElementById("codeDisplay").textContent = accessCode;
  document.getElementById("accessCodeModal").classList.remove("hidden");
}

/** Saves just enough to reconstruct the session + resume progress after a
 *  reload -- the captureToken (needed for every authenticated write/read),
 *  patient context (needed to re-score ASRI locally), and a display label.
 *  Actual task PROGRESS is not duplicated here -- that's fetched fresh from
 *  the backend's /resume endpoint, which is the source of truth. */
function persistResumeState() {
  localStorage.setItem(
    RESUME_STORAGE_KEY,
    JSON.stringify({
      sessionId: state.sessionId,
      captureToken: storage.captureToken,
      side: state.side,
      stage01: state.stage01,
      ageMonths: state.ageMonths,
      monthsSinceSurgery: state.monthsSinceSurgery,
      patientLabel: state.patientLabel,
      savedAt: new Date().toISOString(),
    })
  );
}

async function resumeAssessment() {
  const saved = JSON.parse(localStorage.getItem(RESUME_STORAGE_KEY));
  state.sessionId = saved.sessionId;
  state.side = saved.side;
  state.stage01 = saved.stage01;
  state.ageMonths = saved.ageMonths;
  state.monthsSinceSurgery = saved.monthsSinceSurgery;
  state.patientLabel = saved.patientLabel;
  storage.captureToken = saved.captureToken;

  let data;
  try {
    data = await storage.resumeSession(state.sessionId);
  } catch (e) {
    alert(`Could not resume this session: ${e.message}. Starting a new one instead.`);
    localStorage.removeItem(RESUME_STORAGE_KEY);
    document.getElementById("resumeBanner").classList.add("hidden");
    return;
  }

  workflow = ModifiedMalletWorkflow.resumeFrom({ malletScoreConfig: malletConfigStore.getActive(), completedTaskResults: data.completedTasks });

  document.getElementById("resumeBanner").classList.add("hidden");
  document.getElementById("registrationScreen").classList.add("hidden");
  document.getElementById("assessmentSelectionScreen").classList.add("hidden");
  document.getElementById("captureScreen").classList.remove("hidden");

  if (workflow.isComplete) {
    await finishSession();
    return;
  }

  setupDeviceOrientation();
  await startCamera(state.facing);
  loadTaskUi();
}

function dismissAccessCodeModal() {
  document.getElementById("accessCodeModal").classList.add("hidden");
  document.getElementById("assessmentSelectionScreen").classList.remove("hidden");
}

function beginAssessment() {
  document.getElementById("assessmentSelectionScreen").classList.add("hidden");
  document.getElementById("captureScreen").classList.remove("hidden");
  setupDeviceOrientation(); // called from a click handler -- the user-gesture context iOS requires for its permission prompt
  startCamera(state.facing);
  loadTaskUi();
}

/** DeviceOrientationEvent gives camera-geometry.js a REAL tilt/roll sensor
 *  reading when available (see shared/icqa/camera-geometry.js); when it
 *  isn't (desktop webcams, permission denied, non-iOS browsers that don't
 *  gate it but also don't fire it reliably), state.deviceOrientation simply
 *  stays null and that module falls back to its documented pose-based
 *  proxy -- no separate handling needed here. */
async function setupDeviceOrientation() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== "granted") return;
    }
    window.addEventListener("deviceorientation", (e) => {
      if (e.beta == null && e.gamma == null) return; // some browsers fire an empty event once before real data arrives
      state.deviceOrientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    });
  } catch (e) {
    // No device-orientation sensor, or permission unavailable -- the pose-based proxy handles this.
  }
}

function loadTaskUi() {
  const task = workflow.currentTask;
  const progress = workflow.progress;
  document.getElementById("taskProgress").textContent = `STEP 3 · MODIFIED MALLET ASSESSMENT — TASK ${progress.completed + 1} / ${progress.total}`;
  document.getElementById("taskLabel").textContent = task.label;
  const instructions = getInstructionsForTask(task.id);
  document.getElementById("taskClinicalPurpose").textContent = instructions.clinicalPurpose;
  document.getElementById("taskInstruction").textContent = instructions.instruction;
  document.getElementById("startTaskBtn").disabled = false;
  document.getElementById("taskDoneFlag").textContent = "";
  document.getElementById("taskReviewPanel").classList.add("hidden");
  document.getElementById("recordingTimerWrap").classList.add("hidden");
  document.getElementById("recordingTimer").textContent = "0.0s";
  cancelSpeech();
  setTimeout(startIdleIcqaPreview, 400); // small delay so the camera has a frame or two before the first check
}

/** Runs the ICQA pre-task check against the CURRENT live frame: camera
 *  geometry, frame quality (lighting/sharpness/background), body
 *  visibility, and tracking stability. `includeMultiPerson` controls
 *  whether the (slower) secondary numPoses:2 landmarker also runs -- true
 *  only for the authoritative check made right when the user clicks "Start
 *  task" (see runCurrentTask()); the periodic idle-preview refresh below
 *  uses false, so continuous live guidance doesn't invoke a second GPU
 *  model every ~1.5s while the caregiver is just getting the child into
 *  position. A multi-person check skipped this way scores as `unavailable`
 *  (see visibility-analysis.js), which combineComponents() excludes rather
 *  than treats as passing -- so the idle preview is a real preview, not a
 *  falsely-reassuring one, right up until the authoritative check runs. */
async function runIcqaGate(includeMultiPerson = true) {
  const cfg = icqaConfigStore.getActive();
  const personCount = includeMultiPerson ? await poseEngine.countPeople(videoEl) : null;
  const geometry = analyzeCameraGeometry({ landmarks: state.latestLandmarks, deviceOrientation: state.deviceOrientation, config: cfg });
  const frameQuality = analyzeFrameQuality({ imageData: poseEngine.grabFrame(videoEl), bboxNormalized: geometry.bbox });
  const visibility = analyzeVisibility({ landmarks: state.latestLandmarks, secondaryPersonCount: personCount, config: cfg });
  const stability = analyzeStability(poseEngine.getRecentHistory(15));
  const icqaResult = icqaEngine.score({ geometry, frameQuality, visibility, stability });
  const gate = evaluateGate(icqaResult, cfg);
  const guidance = buildGuidance({ icqaResult, geometry, frameQuality, visibility, config: cfg });
  return { icqaResult, gate, guidance };
}

/** A fixed, no-analyzer-call result for "no pose detected at all yet" --
 *  distinct from a low body-visibility SCORE (which still requires SOME
 *  landmarks to compute). Kept as a fixed object rather than routing
 *  through the analyzers with null landmarks, since several of them (e.g.
 *  visibility-analysis.js's per-body-part averaging) assume an indexable
 *  landmark array and would throw on null rather than degrade gracefully --
 *  this is the one gate state that must never depend on the camera having
 *  found anyone yet. */
function noLandmarksGateResult() {
  return {
    icqaResult: { cqi: null, overallConfidencePct: 0, completeness: 0, icqaVersion: icqaConfigStore.getActive().version, subscores: {} },
    gate: { canRecord: false, blockingCriteria: [{ key: "bodyVisibility", label: "Body Visibility", score: null, minScore: null }], warnings: [], cqi: null, icqaVersion: icqaConfigStore.getActive().version },
    guidance: { primary: "I can't see your child yet — make sure they're standing where the camera can see them.", secondary: [], blockingCount: 1 },
  };
}

async function refreshIcqaPanel(includeMultiPerson = true) {
  const result = state.latestLandmarks ? await runIcqaGate(includeMultiPerson) : noLandmarksGateResult();
  renderIcqaPanel(result.icqaResult, result.gate, result.guidance);
  return result;
}

let _idleIcqaIntervalId = null;

/** Starts a periodic lightweight re-check (no multi-person pass, see
 *  runIcqaGate()) that keeps the pre-task panel live while the caregiver is
 *  adjusting the camera/child, instead of a single stale snapshot taken the
 *  moment this task became active. Runs once immediately, then every 1.5s,
 *  and only while a task isn't actively recording -- sampleQualityDuringRecording()
 *  in the frame loop takes over once state.running is true. */
function startIdleIcqaPreview() {
  refreshIcqaPanel(false);
  if (_idleIcqaIntervalId) return;
  _idleIcqaIntervalId = setInterval(() => {
    if (!state.running) refreshIcqaPanel(false);
  }, 1500);
}

function renderIcqaPanel(icqaResult, gate, guidance) {
  const panel = document.getElementById("cameraCheckPanel");
  panel.querySelector("#icqaScore").textContent = icqaResult.cqi ?? "—";
  document.getElementById("liveCqiReadout").textContent = icqaResult.cqi ?? "—";
  panel.querySelector("#icqaPrimaryGuidance").textContent = guidance.primary;
  panel.querySelector("#icqaSecondaryGuidance").innerHTML = guidance.secondary.map((m) => `<li>${m}</li>`).join("");
  panel.querySelector("#icqaSubscores").innerHTML = Object.entries(icqaResult.subscores)
    .map(([, s]) => `<div class="row"><span class="k">${s.label}</span><span class="v readout">${s.score ?? "—"}</span></div>`)
    .join("");
  document.getElementById("startAnywayBtn").classList.toggle("hidden", gate.canRecord);
  panel.classList.toggle("gate-blocked", !gate.canRecord);
}

/** A setTimeout wrapper that can be paused/resumed without losing track of
 *  how much time is left -- used so a severe mid-task quality drop (subject
 *  leaves frame, camera bumped) pauses the task countdown instead of just
 *  recording garbage frames for the remainder of a fixed window. Triggered
 *  from sampleQualityDuringRecording() in the frame loop above. */
function createPausableTimer(durationMs, onDone) {
  let remaining = durationMs;
  let segmentStart = performance.now();
  let timeoutId = setTimeout(onDone, remaining);
  let paused = false;
  return {
    get paused() { return paused; },
    pause() {
      if (paused) return;
      paused = true;
      clearTimeout(timeoutId);
      remaining -= performance.now() - segmentStart;
    },
    resume() {
      if (!paused) return;
      paused = false;
      segmentStart = performance.now();
      timeoutId = setTimeout(onDone, Math.max(0, remaining));
    },
  };
}

function waitForTaskDuration(durationMs) {
  return new Promise((resolve) => {
    state.activeTimer = createPausableTimer(durationMs, () => {
      state.activeTimer = null;
      resolve();
    });
  });
}

/** Shows a 3-2-1 countdown over the video before recording actually starts,
 *  giving the caregiver/patient a moment to get ready right after the ICQA
 *  gate passes. */
function runCountdown(seconds = 3) {
  const overlay = document.getElementById("countdownOverlay");
  overlay.classList.remove("hidden");
  return new Promise((resolve) => {
    let remaining = seconds;
    overlay.textContent = String(remaining);
    const id = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(id);
        overlay.classList.add("hidden");
        resolve();
      } else {
        overlay.textContent = String(remaining);
      }
    }, 1000);
  });
}

async function runCurrentTask(forceOverride) {
  const { icqaResult, gate } = await refreshIcqaPanel();
  if (!gate.canRecord && !forceOverride) {
    document.getElementById("startTaskBtn").disabled = false;
    return; // guidance panel already shows what to fix, plus a "Start anyway" option
  }
  state.pendingCameraQuality = { icqaResult, gateOverridden: !gate.canRecord && forceOverride, blockingCriteria: gate.blockingCriteria, warnings: gate.warnings };

  const task = workflow.currentTask;
  document.getElementById("startTaskBtn").disabled = true;
  document.getElementById("startAnywayBtn").classList.add("hidden");

  await runCountdown(3);

  state.taskCollected = [];
  state.running = true;
  state.taskStartMs = performance.now();
  state.activeTimeline = startTimeline();
  document.getElementById("recordingTimerWrap").classList.remove("hidden");
  poseEngine.startTaskCapture();
  const videoCapture = poseEngine.startVideoCapture(streamRef);

  await waitForTaskDuration(task.durationMs);
  state.running = false;
  document.getElementById("recordingPauseFlag").classList.add("hidden");
  document.getElementById("recordingTimerWrap").classList.add("hidden");

  const timelineSummary = finalizeTimeline(state.activeTimeline, icqaConfigStore.getActive());
  state.activeTimeline = null;
  const videoBlob = videoCapture.supported ? await poseEngine.stopVideoCapture() : null;

  const collected = state.taskCollected;
  const rawFrames = poseEngine.getTaskHistory();
  if (collected.length === 0) {
    alert("No pose detected during this task — please retry with the child in frame.");
    document.getElementById("startTaskBtn").disabled = false;
    return;
  }

  const cameraQuality = summarizeCameraQuality(state.pendingCameraQuality, timelineSummary);
  const result = workflow.recordCurrentTask({
    side: state.side,
    rawFrames,
    collected,
    icqaResult: state.pendingCameraQuality.icqaResult,
    sessionId: state.sessionId,
    cameraQuality,
  });
  if (result.status !== "ok") {
    alert("Could not process this task's recording — please retry.");
    document.getElementById("startTaskBtn").disabled = false;
    return;
  }

  state.pendingResult = { ...result, videoBlob };
  await captureStill(task.id, result.recorderResult.peakParameters, result.recorderResult.peakFrameT);
  showTaskReview(result.envelope);
}

function showTaskReview(envelope) {
  const grade = envelope.malletGrade;
  document.getElementById("reviewGrade").textContent = grade?.grade ?? "—";
  document.getElementById("reviewConfidence").textContent = grade?.confidence != null ? `Confidence ${grade.confidence}%` : "insufficient data";
  document.getElementById("reviewCqi").textContent = envelope.cameraQuality?.cqi != null ? `CQI ${envelope.cameraQuality.cqi}` : "";
  document.getElementById("reviewReasoning").textContent = grade?.reasoning ?? "No grade could be predicted for this task -- see the doctor portal for details once reviewed.";
  document.getElementById("taskReviewPanel").classList.remove("hidden");
}

/** Discards the just-recorded (not yet confirmed) result and re-enables
 *  recording the SAME task again -- safe because workflow.recordCurrentTask()
 *  never advanced the controller; only confirmCurrentTask() (called from
 *  continueToNextTask()) does. */
function retryCurrentTask() {
  state.pendingResult = null;
  document.getElementById("taskReviewPanel").classList.add("hidden");
  document.getElementById("startTaskBtn").disabled = false;
  startIdleIcqaPreview();
}

async function continueToNextTask() {
  const { envelope } = state.pendingResult;
  const task = workflow.currentTask;

  await storage.saveTaskResult(state.sessionId, task.id, {
    parameters: envelope.parameters,
    motionAnalysis: envelope.motionAnalysis,
    cameraQuality: envelope.cameraQuality,
    malletGrade: envelope.malletGrade,
  });
  await storage.saveTaskData({
    sessionId: state.sessionId,
    taskId: task.id,
    videoBlob: state.pendingResult.videoBlob,
    rawLandmarks: envelope.rawLandmarks,
    filteredLandmarks: envelope.filteredLandmarks,
  });

  workflow.confirmCurrentTask(task.id, envelope);
  state.pendingResult = null;
  document.getElementById("taskDoneFlag").textContent = "captured";
  document.getElementById("taskReviewPanel").classList.add("hidden");

  if (workflow.isComplete) {
    localStorage.removeItem(RESUME_STORAGE_KEY);
    await finishSession();
  } else {
    loadTaskUi();
  }
}

function collectFrame(params) {
  state.taskCollected.push({ t: performance.now(), params });
}

async function captureStill(taskId, parameters, t) {
  const off = document.createElement("canvas");
  off.width = videoEl.videoWidth;
  off.height = videoEl.videoHeight;
  off.getContext("2d").drawImage(videoEl, 0, 0);
  const blob = await new Promise((resolve) => off.toBlob(resolve, "image/jpeg", 0.85));
  await storage.saveCapture({ sessionId: state.sessionId, taskId, blob, parameters, timestamp: t });
}

/** Combines the gate snapshot taken at the moment this task started (was it
 *  blocked? did the user override it?) with the finalized during-recording
 *  Quality Timeline into the single `cameraQuality` object stored alongside
 *  this task's result -- same "trim for storage, keep the trace" principle
 *  DMQE's own summarizeMotionAnalysis() (now inside shared/assessment/
 *  TaskRecorder.js) already established. `gateOverridden` is the one field
 *  that matters most for interpreting the rest: a session with it true
 *  means the capture conditions are known to fall below this version's own
 *  bar, by explicit human choice, not silently. */
function summarizeCameraQuality(pending, timelineSummary) {
  if (!pending) return { status: "no_gate_data" };
  return {
    status: "ok",
    cqi: pending.icqaResult.cqi,
    overallConfidencePct: pending.icqaResult.overallConfidencePct,
    subscores: pending.icqaResult.subscores,
    icqaVersion: pending.icqaResult.icqaVersion,
    gateOverridden: pending.gateOverridden,
    blockingCriteriaAtStart: pending.blockingCriteria,
    warningsAtStart: pending.warnings,
    timeline: timelineSummary,
  };
}

const CATEGORY_ORDER = ["rom", "movementQuality", "compensation", "symmetry", "functionalPerformance"];

async function finishSession() {
  // perTaskParameters = {taskId: {paramKey: {value, measurementType, confidence, ...}}} --
  // assembled by the workflow from whatever's been confirmed so far (ASRI's
  // scoring code itself is completely unchanged from Phase 2-5).
  const perTaskParameters = workflow.buildAsriPerTaskParameters();
  const referenceTargets = resolveReferenceDataset(referenceConfig, {
    ageMonths: state.ageMonths,
    monthsSinceSurgery: state.monthsSinceSurgery,
    side: state.side,
  }).targets;
  const asriResult = asriEngine.score({ perTaskParameters, referenceTargets, stage01: state.stage01 });
  const malletOverall = workflow.computeOverallMalletScore();

  document.getElementById("captureScreen").classList.add("hidden");
  const summary = document.getElementById("summaryScreen");
  summary.classList.remove("hidden");

  renderMalletOverallSummary(malletOverall);

  summary.querySelector("#compositeScore").textContent = asriResult.composite ?? "—";
  summary.querySelector("#compositeCi").textContent = asriResult.confidenceInterval
    ? `95% CI ${asriResult.confidenceInterval.low} – ${asriResult.confidenceInterval.high}`
    : "no categories captured";
  summary.querySelector("#overallConfidence").textContent = `Overall confidence ${asriResult.overallConfidencePct ?? "—"}%`;
  summary.querySelector("#completeness").textContent = `${Math.round(asriResult.completeness * 100)}% of categories captured`;
  summary.querySelector("#asriVersion").textContent = `ASRI v${asriResult.asriVersion} · φ=${asriResult.phi}`;
  renderCategoryBreakdown(asriResult.categories);

  document.getElementById("downloadJsonReportBtn").href = storage.malletReportUrl(state.sessionId, "json");
  document.getElementById("downloadPdfReportBtn").href = storage.malletReportUrl(state.sessionId, "pdf");
}

function renderMalletOverallSummary(overall) {
  const el = document.getElementById("malletOverallSummary");
  if (overall.status !== "ok") {
    el.innerHTML = `<p class="readout" style="color:var(--slate);">insufficient data to compute an overall Modified Mallet Score</p>`;
    return;
  }
  el.innerHTML = `
    <div class="big-score" style="font-size:40px;">${overall.averageGradeRoman}</div>
    <div class="readout" style="color:var(--slate);">Total score ${overall.totalScore} · average ${overall.averageGrade} · ${overall.tasksGraded}/${overall.tasksTotal} tasks graded</div>
    <div class="readout" style="color:var(--slate);">Assessment confidence ${overall.assessmentConfidencePct}%</div>
  `;
}

function renderCategoryBreakdown(categories) {
  const container = document.getElementById("categoryBreakdown");
  container.innerHTML = CATEGORY_ORDER.map((key) => {
    const c = categories[key];
    const value = c.score != null ? c.score : c.status === "insufficient_data" ? "insufficient data" : "—";
    return `<div class="row"><span class="k">${c.label}</span><span class="v readout">${value}</span></div>`;
  }).join("");
}

// boot() wires every button on the page, so an unhandled rejection anywhere
// inside it presents to the user as "the app loaded but nothing responds".
// Surface the reason in the boot status line rather than failing silently.
window.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => {
    console.error("[boot] startup failed", err);
    const status = document.getElementById("bootStatus");
    status.classList.add("flag");
    status.textContent = `Startup failed — ${err.message}. Reload the page; if this persists the backend may be unreachable or out of date.`;
  });
});
