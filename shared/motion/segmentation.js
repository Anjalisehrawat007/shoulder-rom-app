/**
 * segmentation.js — Part 3: Movement Segmentation
 * ----------------------------------------------------------------------------
 * Automatically detects movement start/peak/hold/return/end from a filtered
 * wrist-position sequence, so idle frames before and after the actual
 * movement are excluded from downstream analysis (no manual frame
 * selection, per spec).
 *
 * DELIBERATE DESIGN CHOICE: this module only depends on landmark POSITIONS
 * (from landmark-filter.js's output), never on joint angles from the
 * Biomechanical Engine. "Peak motion" is therefore defined as the frame of
 * maximum wrist displacement from the movement-start position (a
 * positional/kinematic definition), not maximum joint-angle elevation. This
 * keeps segmentation.js fully self-contained -- trajectory-analysis.js
 * depends on this module's output plus the Biomechanical Engine, not the
 * other way around, so there is no circular dependency (spec §8). In
 * practice, for the single-plane-dominant reaching tasks this protocol
 * uses, peak wrist displacement and peak elevation angle coincide closely,
 * but they are NOT defined to be identical, and could diverge for more
 * complex movements -- worth knowing if this module is reused elsewhere.
 *
 * ALGORITHM: velocity-threshold phase detection on wrist speed, with
 * debouncing (a transition must hold for several consecutive frames) so a
 * single noisy speed spike doesn't falsely trigger a phase boundary.
 *
 * ASSUMPTIONS / LIMITATIONS:
 *  - `speedNoiseFloor` and `debounceFrames` are placeholder constants
 *    (documented as such, not fabricated precision) pending calibration
 *    against a real cohort's actual stationary-frame jitter magnitude --
 *    same "external, adjustable, not hard-coded precision" stance already
 *    used for ASRI's weights and reference targets.
 *  - Assumes a single reach-and-return movement per task (matching the
 *    current capture protocol's 4 tasks). A sequence with multiple
 *    distinct reach attempts would need repeated segmentation, not
 *    supported here.
 *  - A sequence with too few frames, or no detected movement at all,
 *    returns an explicit status rather than fabricating phase boundaries.
 * ----------------------------------------------------------------------------
 */
import { vec3 } from "../biomechanics/coordinate-frame.js";

const { v3, magnitude } = vec3;

const DEFAULT_OPTS = {
  speedNoiseFloor: 0.15, // landmark-units/s; below this, treated as "not moving" -- placeholder, see header
  debounceFrames: 3, // consecutive frames required to confirm a phase transition
  minHoldFrames: 3, // consecutive low-speed frames near peak required to count as a "hold"
};

/** Frame-to-frame wrist speed, in landmark-units/s. speeds[0] is always null
 *  (no preceding sample). Null wherever a landmark is missing or dt<=0. */
function wristSpeedProfile(frames, wristIndex) {
  const speeds = [null];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].lm?.[wristIndex];
    const b = frames[i].lm?.[wristIndex];
    if (!a || !b) {
      speeds.push(null);
      continue;
    }
    const dt = (frames[i].t - frames[i - 1].t) / 1000;
    if (dt <= 0) {
      speeds.push(null);
      continue;
    }
    speeds.push(magnitude(v3(a, b)) / dt);
  }
  return speeds;
}

/** First index >= fromIndex where speed sustains `direction` relative to
 *  `threshold` for `debounceFrames` consecutive frames. Returns the index of
 *  the FIRST frame of that sustained run (the actual transition point), or
 *  null if no such run exists. */
function findDebouncedCrossing(speeds, fromIndex, direction, threshold, debounceFrames) {
  let run = 0;
  for (let i = fromIndex; i < speeds.length; i++) {
    const s = speeds[i];
    const above = s != null && s > threshold;
    const matches = direction === "up" ? above : !above;
    if (matches) {
      run++;
      if (run >= debounceFrames) return i - debounceFrames + 1;
    } else {
      run = 0;
    }
  }
  return null;
}

/**
 * @param {Array<{t:number, lm: object[]|null}>} frames - filtered sequence
 * @param {number} wristIndex - MediaPipe landmark index for the tested wrist
 * @param {object} [opts]
 * @returns {{status: string, phases: object|null, speeds: Array<number|null>}}
 */
function segmentMovement(frames, { wristIndex, opts = {} } = {}) {
  const { speedNoiseFloor, debounceFrames, minHoldFrames } = { ...DEFAULT_OPTS, ...opts };
  const speeds = wristSpeedProfile(frames, wristIndex);

  if (frames.length < debounceFrames * 3) {
    return { status: "insufficient_frames", phases: null, speeds };
  }

  const movementStart = findDebouncedCrossing(speeds, 0, "up", speedNoiseFloor, debounceFrames);
  if (movementStart == null) {
    return { status: "no_movement_detected", phases: null, speeds };
  }

  const startPos = frames[movementStart].lm?.[wristIndex];
  let peakIndex = movementStart;
  let peakDist = -Infinity;
  for (let i = movementStart; i < frames.length; i++) {
    const p = frames[i].lm?.[wristIndex];
    if (!p || !startPos) continue;
    const d = magnitude(v3(startPos, p));
    if (d > peakDist) {
      peakDist = d;
      peakIndex = i;
    }
  }

  // Hold: scan forward from peak for a sustained low-velocity plateau.
  let holdStart = null;
  let holdEnd = null;
  {
    let run = 0;
    let runStart = null;
    for (let i = peakIndex; i < speeds.length; i++) {
      const s = speeds[i];
      const low = s != null && s <= speedNoiseFloor;
      if (low) {
        if (run === 0) runStart = i;
        run++;
        if (run >= minHoldFrames) {
          holdStart = runStart;
          holdEnd = i;
        }
      } else {
        run = 0;
        runStart = null;
        if (holdStart != null) break; // hold plateau ended
      }
    }
  }

  const searchFromForEnd = holdEnd ?? peakIndex;
  const movementEnd = findDebouncedCrossing(speeds, searchFromForEnd, "down", speedNoiseFloor, debounceFrames) ?? frames.length - 1;

  return {
    status: "ok",
    phases: {
      movementStart,
      peakMotion: peakIndex,
      holdStart,
      holdEnd,
      returnStart: holdEnd ?? peakIndex,
      movementEnd,
    },
    speeds,
  };
}

export { segmentMovement, wristSpeedProfile, DEFAULT_OPTS };
