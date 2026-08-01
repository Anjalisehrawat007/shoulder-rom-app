/**
 * TaskInstructions.js — per-task guidance text + voice-guidance helper
 * ----------------------------------------------------------------------------
 * Text instructions come straight from TaskDefinitions.js. `speak(text)`
 * below is a minimal, independent use of the browser's own
 * SpeechSynthesisUtterance API -- the same underlying browser API
 * capture/tutorial/tutorial.js already relies on for the 16-language
 * onboarding tutorial, but NOT an import of that file (tutorial.js is a
 * plain non-module script scoped to the tutorial page, and its
 * multi-language voice-quality-ranking logic is more machinery than
 * a single in-task instruction needs -- this speaks in whatever the
 * browser's default/current voice is, a real but deliberately simple
 * "voice guidance" placeholder per the spec, not a copy of tutorial.js).
 * ----------------------------------------------------------------------------
 */
import { getTaskById } from "./TaskDefinitions.js";

/** @returns {{clinicalPurpose, instruction, demoVideoPlaceholder, illustrationPlaceholder}|null} */
function getInstructionsForTask(taskId) {
  const task = getTaskById(taskId);
  if (!task) return null;
  return {
    clinicalPurpose: task.clinicalPurpose,
    instruction: task.instruction,
    demoVideoPlaceholder: !!task.demoVideoPlaceholder,
    illustrationPlaceholder: !!task.illustrationPlaceholder,
  };
}

/** Speaks `text` aloud via the browser's SpeechSynthesis API, if available.
 *  No-ops (returns {spoke:false}) in any environment without it (Node
 *  tests, unsupported browsers) -- callers should treat voice guidance as
 *  an enhancement, never a requirement, same as the rest of this app's
 *  "placeholder" framing for demo video/illustration. */
function speak(text) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return { spoke: false };
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.9;
  window.speechSynthesis.speak(utter);
  return { spoke: true };
}

function cancelSpeech() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

export { getInstructionsForTask, speak, cancelSpeech };
