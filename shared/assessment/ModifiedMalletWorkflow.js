/**
 * ModifiedMalletWorkflow.js — top-level orchestrator
 * ----------------------------------------------------------------------------
 * The single import surface capture/app.js's UI layer uses. Wires
 * TaskDefinitions + AssessmentController + TaskRecorder + TaskResults +
 * ModifiedMalletScoreEngine together, with zero DOM/video access itself --
 * the caller supplies raw frames already captured (from poseEngine) and an
 * already-computed ICQA result (from the existing, unchanged Phase 5 gate
 * flow); this class only orchestrates what happens to that data.
 * ----------------------------------------------------------------------------
 */
import { TASKS } from "./TaskDefinitions.js";
import { AssessmentController } from "./AssessmentController.js";
import { recordTask } from "./TaskRecorder.js";
import { buildTaskResultEnvelope, summarizeTaskResultEnvelope } from "./TaskResults.js";
import { ModifiedMalletScoreEngine } from "./ModifiedMalletScoreEngine.js";

class ModifiedMalletWorkflow {
  /** @param {object} args
   *  @param {object} args.malletScoreConfig - a published mallet-score-config.v1 object
   *  @param {Array<object>} [args.tasks] - defaults to TaskDefinitions.js's TASKS */
  constructor({ malletScoreConfig, tasks = TASKS }) {
    this.tasks = tasks;
    this.malletScoreEngine = new ModifiedMalletScoreEngine(malletScoreConfig);
    this.controller = new AssessmentController(tasks);
  }

  /** Reconstructs a workflow already in progress -- the resume path. See
   *  AssessmentController.resumeFrom() and docs/mallet-score.md.
   *  `completedTaskResults` is {taskId: summarizeTaskResultEnvelope(...)}. */
  static resumeFrom({ malletScoreConfig, tasks = TASKS, completedTaskResults }) {
    const workflow = new ModifiedMalletWorkflow({ malletScoreConfig, tasks });
    workflow.controller = AssessmentController.resumeFrom(tasks, completedTaskResults);
    return workflow;
  }

  get currentTask() {
    return this.controller.currentTask;
  }
  get progress() {
    return this.controller.progress;
  }
  get isComplete() {
    return this.controller.isComplete;
  }

  /**
   * Runs the per-task pipeline (filter -> DMQE -> Mallet measurements ->
   * grade) and builds the storage envelope -- does NOT advance the
   * controller. Recording produces a result for the caller's Task Review
   * step to show; the controller only advances once that result is
   * explicitly confirmed via confirmCurrentTask() below. This split exists
   * specifically so "Retry this task" (recording again without confirming)
   * doesn't require the controller to un-advance -- it never advanced in
   * the first place.
   * @param {object} args
   * @param {"left"|"right"} args.side
   * @param {Array} args.rawFrames - poseEngine.getTaskHistory()
   * @param {Array} args.collected - state.taskCollected
   * @param {object|null} args.icqaResult - the pre-task gate's IcqaEngine.score() result
   * @param {string} args.sessionId
   * @param {object|null} args.cameraQuality - capture/app.js's summarizeCameraQuality() output (Phase 5, unchanged)
   * @param {string|null} [args.videoRef]
   * @param {Array<string>} [args.photoRefs]
   * @returns {{status:"ok", envelope: object, recorderResult: object}|{status:"no_pose_detected"}}
   */
  recordCurrentTask({ side, rawFrames, collected, icqaResult, sessionId, cameraQuality, videoRef = null, photoRefs = [] }) {
    const task = this.currentTask;
    if (!task) throw new Error("ModifiedMalletWorkflow: recordCurrentTask() called with no current task -- assessment is already complete");

    const recorderResult = recordTask({
      task,
      side,
      rawFrames,
      collected,
      icqaResult,
      malletScoreEngine: this.malletScoreEngine,
      malletProxyConfig: this.malletScoreEngine.config.measurementProxies,
      // Phase 8: threads the already-in-scope cameraQuality's finalized
      // Quality Timeline into the rotation trajectory analysis's optional
      // CQI confidence factor -- see TaskRecorder.js and
      // shared/biomechanics/rotation-trajectory.js. cameraQuality itself
      // was already available here before this change; it just wasn't
      // reaching recordTask() yet.
      cqiTimeline: cameraQuality?.timeline ?? null,
    });
    if (recorderResult.status !== "ok") return recorderResult;

    const envelope = buildTaskResultEnvelope({ task, sessionId, side, recorderResult, cameraQuality, videoRef, photoRefs });
    return { status: "ok", envelope, recorderResult };
  }

  /** Advances the controller past `taskId` -- call once the caller's Task
   *  Review step is confirmed ("Continue"), never on "Retry". */
  confirmCurrentTask(taskId, envelope) {
    this.controller.markTaskComplete(taskId, summarizeTaskResultEnvelope(envelope));
  }

  /** {taskId: parameters} for whatever's been recorded so far -- exactly
   *  the shape shared/asri/asri-engine.js's score({perTaskParameters}) expects,
   *  since asriInputParameters is a documented alias of `parameters`
   *  (see TaskResults.js). ASRI's own scoring code is called by the
   *  caller (capture/app.js or backend/server.js), not by this class --
   *  this only assembles its input, keeping ASRI itself untouched and this
   *  workflow from needing to import shared/asri/* just to prepare data
   *  its caller already knows how to score. */
  buildAsriPerTaskParameters() {
    const out = {};
    for (const [taskId, summary] of Object.entries(this.controller.results)) {
      out[taskId] = summary.asriInputParameters;
    }
    return out;
  }

  /** Overall Modified Mallet Score across every task recorded so far. */
  computeOverallMalletScore() {
    const grades = Object.values(this.controller.results).map((s) => s.malletGrade);
    return this.malletScoreEngine.scoreOverall(grades);
  }
}

export { ModifiedMalletWorkflow };
