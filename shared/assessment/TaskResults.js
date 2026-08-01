/**
 * TaskResults.js — per-task result envelope builder/validator
 * ----------------------------------------------------------------------------
 * The "no task overwrites another" contract from the spec is enforced two
 * ways: (1) every envelope is tagged with its own `taskId` (validated here,
 * required field) and stored server-side keyed by `UNIQUE(session_id,
 * task_id)` (backend/db.js, unchanged from Phase 1) -- 6 distinct task ids
 * this phase means 6 distinct rows, never one overwriting another; (2)
 * within a single task, re-running it before "Continue" is pressed is a
 * legitimate retry that DOES replace that task's own prior attempt (same
 * `ON CONFLICT ... DO UPDATE` semantics every phase since Phase 1 has used)
 * -- that's a retry of the SAME task, not a different task overwriting it.
 *
 * This file only SHAPES data (pure, no I/O) -- actually persisting raw/
 * filtered landmarks and video to disk happens server-side (backend/
 * server.js's new task-data endpoint), matching how photo capture already
 * works (capture/app.js uploads bytes, the backend writes the file and
 * stores a path).
 * ----------------------------------------------------------------------------
 */

const REQUIRED_FIELDS = ["taskId", "malletCategory", "sessionId", "side", "timestamp", "parameters"];

/**
 * @param {object} args
 * @param {object} args.task - a TaskDefinitions.js entry
 * @param {string} args.sessionId
 * @param {"left"|"right"} args.side
 * @param {object} args.recorderResult - TaskRecorder.js's recordTask() output (status "ok")
 * @param {object|null} args.cameraQuality - the same shape capture/app.js's summarizeCameraQuality() already produces (Phase 5, unchanged)
 * @param {string|null} [args.videoRef] - server-assigned reference/id for this task's uploaded video, once stored
 * @param {Array<string>} [args.photoRefs] - server-assigned capture ids for this task's stills
 */
function buildTaskResultEnvelope({ task, sessionId, side, recorderResult, cameraQuality, videoRef = null, photoRefs = [] }) {
  const envelope = {
    taskId: task.id,
    malletCategory: task.malletCategory,
    sessionId,
    side,
    timestamp: new Date().toISOString(),

    // Biomechanical Engine output for this task's representative (peak) frame,
    // plus DMQE-sourced movementSmoothness/movementSpeed -- unchanged shape
    // from every prior phase's `parameters`.
    parameters: recorderResult.parameters,

    // New this phase: elbowFlexionDeg, reachSuccess, vertebralLevelProxy,
    // completionTimeSec, shoulderExtensionDeg (see TaskRecorder.js).
    malletMeasurements: recorderResult.malletMeasurements,

    // DMQE's full per-task output (Phase 3, unchanged).
    motionAnalysis: recorderResult.motionAnalysis,

    // AI-predicted Modified Mallet grade for this task (ModifiedMalletScoreEngine.js output).
    malletGrade: recorderResult.malletGrade,

    // ICQA's capture-quality result for this task (Phase 5, unchanged shape).
    cameraQuality,

    // The exact object ASRI's perTaskParameters will use for this task --
    // documented as an alias of `parameters`, not a separate computation,
    // so it's obvious to a reader why they look identical.
    asriInputParameters: recorderResult.parameters,

    // Raw + filtered landmark sequences for this task, kept in-memory here;
    // capture/app.js uploads them to the backend's task-data endpoint as a
    // separate file (see docs/mallet-score.md) rather than inlining them
    // into the main task-result JSON payload, the same file-on-disk-plus-
    // path-in-DB pattern already used for photos (backend/db.js CAPTURES_DIR).
    rawLandmarks: recorderResult.rawFrames,
    filteredLandmarks: recorderResult.filteredFrames,

    videoRef,
    photoRefs,

    softwareVersions: {
      dmqeVersion: recorderResult.motionAnalysis?.dmqeVersion ?? null,
      filterVersion: recorderResult.motionAnalysis?.filterVersion ?? null,
      icqaVersion: cameraQuality?.icqaVersion ?? null,
      malletScoreConfigVersion: recorderResult.malletGrade?.gradeConfigVersion ?? null,
    },
  };
  validateTaskResultEnvelope(envelope);
  return envelope;
}

function validateTaskResultEnvelope(envelope) {
  const missing = REQUIRED_FIELDS.filter((k) => envelope[k] == null);
  if (missing.length > 0) {
    throw new Error(`TaskResults: envelope missing required field(s): ${missing.join(", ")}`);
  }
  return true;
}

/** Strips the large raw/filtered landmark sequences for a lighter-weight
 *  in-memory/summary view (e.g. what capture/app.js keeps in `state.
 *  taskResults` for the live ASRI/Mallet summary screen, vs. what actually
 *  gets uploaded). Mirrors the same "trim for the common case, keep the
 *  full trace available separately" principle summarizeMotionAnalysis()
 *  already established in Phase 3. */
function summarizeTaskResultEnvelope(envelope) {
  const { rawLandmarks, filteredLandmarks, ...summary } = envelope;
  return summary;
}

export { buildTaskResultEnvelope, validateTaskResultEnvelope, summarizeTaskResultEnvelope };
