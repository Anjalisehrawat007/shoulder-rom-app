/**
 * quality-timeline.js — ICQA during-recording quality monitoring
 * ----------------------------------------------------------------------------
 * The pre-task gate (recording-gate.js) only answers "is it good enough to
 * START." This module answers the separate question "did it STAY good
 * enough" -- sampled periodically (config.timeline.sampleIntervalMs, default
 * 500ms, throttled from the frame loop by capture/app.js) across an active
 * task's recording window, producing a compact time series plus derived
 * warnings and auto-pause events for the doctor-facing Quality Timeline
 * (doctor-portal/portal.js).
 *
 * AUTO-PAUSE: triggered when `config.timeline.autoPauseConsecutiveSamples`
 * consecutive samples all fall below `autoPauseCqiThreshold` -- a single bad
 * sample (a transient frame drop) does not pause; a sustained drop (subject
 * left frame, camera bumped) does. `capture/app.js` is the caller that
 * actually pauses/resumes the task timer; this module only detects the
 * condition and records the event, it doesn't control playback itself.
 * ----------------------------------------------------------------------------
 */

function startTimeline() {
  return { samples: [], autoPauseEvents: [] };
}

/** Compact per-subscore snapshot -- scores only, not the full contribution
 *  trace, so a ~7s task sampled every 500ms doesn't bloat stored data (same
 *  "trim for storage" principle capture/app.js's summarizeMotionAnalysis()
 *  already applies to DMQE output). */
function compactSubscores(subscores) {
  const out = {};
  for (const [key, s] of Object.entries(subscores || {})) out[key] = s.score;
  return out;
}

/** Record one sample. Returns {autoPauseTriggered} so the caller can react
 *  immediately without re-scanning the timeline itself. */
function sample(timeline, icqaResult, tSec, config) {
  timeline.samples.push({ tSec, cqi: icqaResult.cqi, subscores: compactSubscores(icqaResult.subscores) });

  const n = config.timeline.autoPauseConsecutiveSamples;
  const recent = timeline.samples.slice(-n);
  const triggered = recent.length === n && recent.every((s) => s.cqi != null && s.cqi < config.timeline.autoPauseCqiThreshold);

  if (triggered) {
    const openEvent = timeline.autoPauseEvents[timeline.autoPauseEvents.length - 1];
    const alreadyOpen = openEvent && openEvent.resumedAtSec == null;
    if (!alreadyOpen) timeline.autoPauseEvents.push({ triggeredAtSec: tSec, resumedAtSec: null });
  } else {
    const openEvent = timeline.autoPauseEvents[timeline.autoPauseEvents.length - 1];
    if (openEvent && openEvent.resumedAtSec == null && icqaResult.cqi != null && icqaResult.cqi >= config.timeline.autoPauseCqiThreshold) {
      openEvent.resumedAtSec = tSec;
    }
  }

  return { autoPauseTriggered: triggered };
}

/** Collapse consecutive below-threshold samples into single warning entries
 *  (one per contiguous low-quality run, not one per sample) so a 2-second
 *  dip doesn't produce four nearly-identical warning strings. */
function collapseWarnings(samples, threshold) {
  const warnings = [];
  let runStart = null;
  let runMinCqi = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const low = s.cqi != null && s.cqi < threshold;
    if (low) {
      if (runStart == null) runStart = s.tSec;
      runMinCqi = Math.min(runMinCqi, s.cqi);
    }
    if ((!low || i === samples.length - 1) && runStart != null) {
      warnings.push({ startSec: Math.round(runStart * 10) / 10, minCqi: runMinCqi, message: `Capture quality dropped to ${Math.round(runMinCqi)} starting at ${runStart.toFixed(1)}s` });
      runStart = null;
      runMinCqi = Infinity;
    }
  }
  return warnings;
}

/** Summarize the finished timeline for storage/display. */
function finalize(timeline, config) {
  const cqis = timeline.samples.map((s) => s.cqi).filter((v) => v != null);
  const minCqi = cqis.length ? Math.min(...cqis) : null;
  const meanCqi = cqis.length ? Math.round((cqis.reduce((a, b) => a + b, 0) / cqis.length) * 10) / 10 : null;

  return {
    sampleCount: timeline.samples.length,
    minCqi,
    meanCqi,
    warnings: collapseWarnings(timeline.samples, config.timeline.warnCqiThreshold),
    warnCqiThreshold: config.timeline.warnCqiThreshold, // carried along so a renderer (doctor-portal) can draw the threshold line without a separate config fetch
    autoPauseEvents: timeline.autoPauseEvents,
    autoPaused: timeline.autoPauseEvents.length > 0,
    samples: timeline.samples,
  };
}

export { startTimeline, sample, finalize };
