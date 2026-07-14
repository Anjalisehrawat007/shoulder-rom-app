/**
 * app.js — capture session controller
 * Ties together: camera (front/back), PoseEngine, task protocol, RomStorage,
 * and the ThetaEngine composite score.
 *
 * NORMS below are PLACEHOLDER target values for converting a raw kinematic
 * measurement into a 0-100 domain sub-score. Replace with the validated
 * reference values from your own cohort before drawing clinical conclusions.
 */
const NORMS = {
  shoulder_abduction: { key: "shoulderAbductionDeg", target: 170 },
  shoulder_flexion: { key: "shoulderFlexionDeg", target: 170 },
  external_rotation: { key: "externalRotationDeg", target: 80 },
  internal_rotation: { key: "internalRotationDeg", target: 70 },
};

const TASKS = [
  { id: "reach_head", label: "Reach the top of the head", instruction: "Ask the child to touch the crown of their head with the hand on the tested side.", durationMs: 7000 },
  { id: "reach_mouth", label: "Reach the mouth", instruction: "Ask the child to bring their hand to their mouth, as if eating.", durationMs: 7000 },
  { id: "comb_hair", label: "Comb the hair", instruction: "Ask the child to mime combing their hair, moving the hand across the scalp.", durationMs: 7000 },
  { id: "lift_arm", label: "Lift the arm sideways", instruction: "Ask the child to lift the tested arm out to the side, as high as comfortable.", durationMs: 7000 },
];

const state = {
  side: "right",
  stage01: 0.5,
  facing: "user",
  sessionId: null,
  taskIndex: 0,
  running: false,
  latestParams: null,
  taskCollected: [], // frames collected in current task window
  taskResults: {}, // taskId -> {parameters, domainScores}, accumulated locally as tasks complete
};

let poseEngine, storage, thetaEngine, thetaStore;
let videoEl, canvasEl, ctx, streamRef;

async function boot() {
  const backendUp = await fetch(`${BACKEND_URL}/api/health`).then((r) => r.ok).catch(() => false);
  if (!backendUp) {
    document.getElementById("bootStatus").textContent =
      "backend unreachable — start it with `npm start` in /backend, or sessions won't be reviewable from another device";
  }
  storage = new ApiStorage(BACKEND_URL);
  thetaStore = new ThetaConfigStore();
  // Prefer the backend's published config (source of truth once deployed); fall back to the
  // bundled file so the capture app still works if the backend is briefly unreachable.
  const cfg = backendUp
    ? await fetch(`${BACKEND_URL}/api/theta-config/1.0.0`).then((r) => r.json())
    : await fetch("../config/theta-config.v1.json").then((r) => r.json());
  thetaStore.publish(cfg);
  thetaEngine = new ThetaEngine(thetaStore.getActive());

  videoEl = document.getElementById("video");
  canvasEl = document.getElementById("overlay");
  ctx = canvasEl.getContext("2d");

  document.getElementById("startSessionBtn").addEventListener("click", startSession);
  document.getElementById("toggleCameraBtn").addEventListener("click", toggleCamera);
  document.getElementById("startTaskBtn").addEventListener("click", runCurrentTask);
  document.getElementById("copySessionIdBtn").addEventListener("click", () =>
    navigator.clipboard.writeText(document.getElementById("sessionIdDisplay").textContent)
  );
  document.getElementById("copyCodeBtn").addEventListener("click", () =>
    navigator.clipboard.writeText(document.getElementById("codeDisplay").textContent)
  );
  document.getElementById("continueBtn").addEventListener("click", dismissAccessCodeModal);

  poseEngine = new PoseEngine();
  await poseEngine.init();
  if (backendUp) document.getElementById("bootStatus").textContent = "pose model ready · backend connected";
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

function frameLoop(ts) {
  if (videoEl.readyState >= 2) {
    const lm = poseEngine.detect(videoEl, performance.now());
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (lm) {
      drawSkeleton(lm);
      const params = poseEngine.computeParameters(lm, state.side);
      const motion = poseEngine.computeMotionQuality(state.side);
      state.latestParams = { ...params, ...motion };
      renderReadout(state.latestParams);
      if (state.running) collectFrame(params);
    }
  }
  requestAnimationFrame(frameLoop);
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

function renderReadout(p) {
  const rows = [
    ["ABDUCTION", `${p.shoulderAbductionDeg}°`],
    ["FLEXION", `${p.shoulderFlexionDeg}°`],
    ["EXT ROTATION", `${p.externalRotationDeg}°`],
    ["INT ROTATION", `${p.internalRotationDeg}°`],
    ["SCAP UPWARD ROT (proxy)", `${p.scapularUpwardRotationDeg_proxy}°`],
    ["SCAP TILT (proxy)", `${p.scapularTiltDeg_proxy}°`],
    ["SCAP WINGING", p.scapularWingingFlag_proxy ? "FLAG" : "—"],
    ["TRUNK LEAN", `${p.trunkLateralLeanDeg}°${p.trunkCompensationFlag ? "  FLAG" : ""}`],
    ["SPEED", p.speed != null ? p.speed.toFixed(3) : "—"],
    ["SMOOTHNESS", p.smoothness != null ? p.smoothness : "—"],
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
  const patientLabel = document.getElementById("patientLabel").value || "unlabeled";

  let sessionId, accessCode;
  try {
    ({ sessionId, accessCode } = await storage.createSession({
      sessionId: hospitalId,
      patientLabel,
      side: state.side,
      thetaVersion: thetaEngine.config.version,
      stage01: state.stage01,
    }));
  } catch (e) {
    alert(e.message);
    return;
  }
  state.sessionId = sessionId;

  document.getElementById("setupScreen").classList.add("hidden");
  document.getElementById("sessionIdDisplay").textContent = sessionId;
  document.getElementById("codeDisplay").textContent = accessCode;
  document.getElementById("accessCodeModal").classList.remove("hidden");
}

function dismissAccessCodeModal() {
  document.getElementById("accessCodeModal").classList.add("hidden");
  document.getElementById("captureScreen").classList.remove("hidden");
  startCamera(state.facing);
  loadTaskUi();
}

function loadTaskUi() {
  const task = TASKS[state.taskIndex];
  document.getElementById("taskProgress").textContent = `STEP ${state.taskIndex + 1} / ${TASKS.length}`;
  document.getElementById("taskLabel").textContent = task.label;
  document.getElementById("taskInstruction").textContent = task.instruction;
  document.getElementById("startTaskBtn").disabled = false;
}

async function runCurrentTask() {
  const task = TASKS[state.taskIndex];
  document.getElementById("startTaskBtn").disabled = true;
  state.taskCollected = [];
  state.running = true;

  await new Promise((resolve) => setTimeout(resolve, task.durationMs));
  state.running = false;

  // Pick the frame with max combined abduction+flexion as the representative capture,
  // plus one at roughly the midpoint of the window.
  const collected = state.taskCollected;
  if (collected.length === 0) {
    alert("No pose detected during this task — please retry with the child in frame.");
    document.getElementById("startTaskBtn").disabled = false;
    return;
  }
  const peak = collected.reduce((best, c) =>
    c.params.shoulderAbductionDeg + c.params.shoulderFlexionDeg >
    best.params.shoulderAbductionDeg + best.params.shoulderFlexionDeg
      ? c
      : best
  );
  const mid = collected[Math.floor(collected.length / 2)];

  const motion = poseEngine.computeMotionQuality(state.side);
  const taskParams = { ...peak.params, ...motion };

  await captureStill(task.id, peak.params, peak.t);
  if (mid !== peak) await captureStill(task.id, mid.params, mid.t);

  const domainScores = buildDomainScores(taskParams);
  await storage.saveTaskResult(state.sessionId, task.id, { parameters: taskParams, domainScores });
  state.taskResults[task.id] = { parameters: taskParams, domainScores };

  document.getElementById("taskDoneFlag").textContent = "captured";
  state.taskIndex++;
  if (state.taskIndex < TASKS.length) {
    setTimeout(loadTaskUi, 600);
  } else {
    await finishSession();
  }
}

function collectFrame(params) {
  state.taskCollected.push({ t: performance.now(), params });
}

function buildDomainScores(p) {
  const scoreFromAngle = (val, target) => Math.max(0, Math.min(100, (val / target) * 100));
  const scapWingingScore = p.scapularWingingFlag_proxy ? 40 : 90;
  const scapTiltScore = Math.max(0, 100 - p.scapularTiltDeg_proxy * 2);
  const scapUpwardScore = Math.min(100, (p.scapularUpwardRotationDeg_proxy / 60) * 100);
  const trunkScore = Math.max(0, 100 - Math.max(p.trunkLateralLeanDeg, p.trunkRotationProxyDeg));
  const smoothnessScore = p.smoothness ?? null;

  return {
    shoulder_abduction: { value: scoreFromAngle(p.shoulderAbductionDeg, NORMS.shoulder_abduction.target), expectedSd: 8, captured: true },
    shoulder_flexion: { value: scoreFromAngle(p.shoulderFlexionDeg, NORMS.shoulder_flexion.target), expectedSd: 8, captured: true },
    external_rotation: { value: scoreFromAngle(p.externalRotationDeg, NORMS.external_rotation.target), expectedSd: 10, captured: p.externalRotationDeg > 0 },
    internal_rotation: { value: scoreFromAngle(p.internalRotationDeg, NORMS.internal_rotation.target), expectedSd: 10, captured: p.internalRotationDeg > 0 },
    scapular_upward_rotation: { value: scapUpwardScore, expectedSd: 12, captured: true },
    scapular_tilt: { value: scapTiltScore, expectedSd: 12, captured: true },
    scapular_winging: { value: scapWingingScore, expectedSd: 15, captured: true },
    trunk_compensation: { value: trunkScore, expectedSd: 10, captured: true },
    movement_smoothness: { value: smoothnessScore, expectedSd: 10, captured: smoothnessScore != null },
  };
}

async function captureStill(taskId, parameters, t) {
  const off = document.createElement("canvas");
  off.width = videoEl.videoWidth;
  off.height = videoEl.videoHeight;
  off.getContext("2d").drawImage(videoEl, 0, 0);
  const blob = await new Promise((resolve) => off.toBlob(resolve, "image/jpeg", 0.85));
  await storage.saveCapture({ sessionId: state.sessionId, taskId, blob, parameters, timestamp: t });
}

async function finishSession() {
  // Aggregate: take the best-captured domain score across all four tasks, using the results
  // accumulated locally as each task completed (ApiStorage has no raw session read — session
  // data is only readable back through the access-code-gated doctor portal).
  const aggregate = {};
  for (const domain of Object.keys(thetaEngine.config.domains)) {
    let best = null;
    for (const t of Object.values(state.taskResults)) {
      const d = t.domainScores[domain];
      if (d && d.captured && (best == null || d.value > best.value)) best = d;
    }
    aggregate[domain] = best || { captured: false };
  }
  const result = thetaEngine.score(aggregate, state.stage01);

  document.getElementById("captureScreen").classList.add("hidden");
  const summary = document.getElementById("summaryScreen");
  summary.classList.remove("hidden");
  summary.querySelector("#compositeScore").textContent = result.composite ?? "—";
  summary.querySelector("#compositeCi").textContent = result.confidenceInterval
    ? `95% CI ${result.confidenceInterval.low} – ${result.confidenceInterval.high}`
    : "no domains captured";
  summary.querySelector("#completeness").textContent = `${Math.round(result.completeness * 100)}% of domains captured`;
  summary.querySelector("#thetaVersion").textContent = `theta v${result.thetaVersion} · φ=${result.phi}`;
}

window.addEventListener("DOMContentLoaded", boot);
