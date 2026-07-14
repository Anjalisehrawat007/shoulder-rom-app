const storage = new ApiStorage(BACKEND_URL);

async function boot() {
  document.getElementById("unlockBtn").addEventListener("click", unlock);
}

async function unlock() {
  const sessionId = document.getElementById("sessionIdInput").value.trim();
  const code = document.getElementById("codeInput").value.trim();
  const result = await storage.unlockSession(sessionId, code);
  if (!result.ok) {
    document.getElementById("unlockError").textContent = result.reason;
    return;
  }
  document.getElementById("lockScreen").classList.add("hidden");
  document.getElementById("viewScreen").classList.remove("hidden");
  // taskResults values carry `parameters` inline; captures carry backend-hosted photoUrls
  // gated by a short-lived review token issued at unlock time.
  render(result.session, result.taskResults, result.captures, result.thetaResult);
}

function render(session, taskResults, captures, thetaResult) {
  document.getElementById("patientLabel").textContent = session.patientLabel;
  document.getElementById("sessionMeta").textContent =
    `${session.side} side · stage ${session.stage01} · captured ${new Date(session.createdAt).toLocaleString()} · theta v${session.thetaVersion}`;

  // This score was computed server-side using the theta version that was ACTIVE at capture
  // time, not necessarily the latest -- versions are immutable, so it always reproduces the
  // exact score the clinician originally saw, regardless of later re-fits.
  document.getElementById("compositeScore").textContent = thetaResult?.composite ?? "—";
  document.getElementById("compositeCi").textContent = thetaResult?.confidenceInterval
    ? `95% CI ${thetaResult.confidenceInterval.low}–${thetaResult.confidenceInterval.high} · ${Math.round(thetaResult.completeness * 100)}% complete`
    : "insufficient data";

  session.taskResults = taskResults; // keep the card-rendering loop below unchanged
  const cardsEl = document.getElementById("taskCards");
  cardsEl.innerHTML = "";
  for (const [taskId, taskResult] of Object.entries(session.taskResults)) {
    const card = document.createElement("div");
    card.className = "panel task-card";
    const taskCaptures = captures.filter((c) => c.taskId === taskId);
    card.innerHTML = `
      <h3>${taskId.replaceAll("_", " ")}</h3>
      <div class="thumbs">${taskCaptures.map((c, i) => `<img data-idx="${i}" data-task="${taskId}" />`).join("")}</div>
      <table class="params-table">${paramRows(taskResult.parameters)}</table>
    `;
    cardsEl.appendChild(card);
    const imgs = card.querySelectorAll("img");
    taskCaptures.forEach((c, i) => {
      imgs[i].src = c.photoUrl;
      imgs[i].addEventListener("click", () => openLightbox(c.photoUrl));
    });
  }
}

function paramRows(p) {
  const rows = [
    ["Shoulder abduction", `${p.shoulderAbductionDeg}°`],
    ["Shoulder flexion", `${p.shoulderFlexionDeg}°`],
    ["External rotation", `${p.externalRotationDeg}°`],
    ["Internal rotation", `${p.internalRotationDeg}°`],
    ["Scapular upward rotation (proxy)", `${p.scapularUpwardRotationDeg_proxy}°`],
    ["Scapular tilt (proxy)", `${p.scapularTiltDeg_proxy}°`],
    ["Scapular winging", p.scapularWingingFlag_proxy ? "flagged — confirm on image" : "not flagged"],
    ["Trunk lateral lean", `${p.trunkLateralLeanDeg}°${p.trunkCompensationFlag ? " — compensation flagged" : ""}`],
    ["Movement speed", p.speed != null ? p.speed : "—"],
    ["Movement smoothness", p.smoothness != null ? p.smoothness : "—"],
  ];
  return rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

function openLightbox(url) {
  document.getElementById("lightboxImg").src = url;
  document.getElementById("lightbox").classList.remove("hidden");
  document.getElementById("lightbox").onclick = () => document.getElementById("lightbox").classList.add("hidden");
}

window.addEventListener("DOMContentLoaded", boot);
