/**
 * AssessmentController.js — pure assessment state machine
 * ----------------------------------------------------------------------------
 * Task order, current position, and completion tracking for the 6-task
 * Modified Mallet protocol. No DOM access -- capture/app.js's UI layer
 * drives this (calls markTaskComplete after each task, reads currentTask/
 * progress/isComplete to update the screen) and reacts to its state,
 * exactly the "pure state machine, UI layer drives it" split used for
 * TaskRecorder.js above.
 *
 * RESUME: `resumeFrom()` reconstructs a controller from whichever tasks the
 * backend already has stored results for (see the new session-resume GET
 * endpoint in backend/server.js), so reloading the page mid-assessment
 * lands back on the correct next task rather than restarting at task 1 or
 * silently losing progress.
 * ----------------------------------------------------------------------------
 */

class AssessmentController {
  /** @param {Array<object>} tasks - TaskDefinitions.js's TASKS array (or a subset, for testing) */
  constructor(tasks) {
    this.tasks = tasks;
    this.currentIndex = 0;
    this.completedTaskIds = new Set();
    this.results = {}; // taskId -> whatever summary the caller passed to markTaskComplete
  }

  get currentTask() {
    return this.tasks[this.currentIndex] ?? null;
  }

  get isComplete() {
    return this.completedTaskIds.size >= this.tasks.length;
  }

  get progress() {
    return { completed: this.completedTaskIds.size, total: this.tasks.length };
  }

  /** Record a task as complete and advance to the next INCOMPLETE task (not
   *  simply currentIndex+1) -- resuming after an interruption can leave
   *  gaps (e.g. a task retried out of order), and this keeps the controller
   *  correct in that case rather than assuming strictly linear progress. */
  markTaskComplete(taskId, resultSummary) {
    if (!this.tasks.some((t) => t.id === taskId)) {
      throw new Error(`AssessmentController: "${taskId}" is not one of this assessment's tasks`);
    }
    this.completedTaskIds.add(taskId);
    this.results[taskId] = resultSummary;
    this._advanceToNextIncomplete();
  }

  _advanceToNextIncomplete() {
    const idx = this.tasks.findIndex((t) => !this.completedTaskIds.has(t.id));
    this.currentIndex = idx === -1 ? this.tasks.length : idx;
  }

  /** Reconstructs a controller from a map of {taskId: resultSummary} for
   *  whichever tasks already have a stored result -- the resume path. */
  static resumeFrom(tasks, completedTaskResults) {
    const controller = new AssessmentController(tasks);
    for (const [taskId, summary] of Object.entries(completedTaskResults || {})) {
      if (!tasks.some((t) => t.id === taskId)) continue; // ignore results for tasks not in THIS protocol version
      controller.completedTaskIds.add(taskId);
      controller.results[taskId] = summary;
    }
    controller._advanceToNextIncomplete();
    return controller;
  }

  toJSON() {
    return {
      currentIndex: this.currentIndex,
      currentTaskId: this.currentTask?.id ?? null,
      completedTaskIds: Array.from(this.completedTaskIds),
      tasksTotal: this.tasks.length,
    };
  }
}

export { AssessmentController };
