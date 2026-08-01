/**
 * landmark-filter.js — Part 2: Landmark Stabilization
 * ----------------------------------------------------------------------------
 * FILTER CHOICE: Savitzky-Golay, not One Euro Filter / Kalman / EMA.
 *
 * This stage runs OFFLINE on a fully-captured, fixed-length frame sequence
 * after a task's ~7s window closes -- not a live/streaming context. That
 * distinction drives the choice:
 *
 *  - One Euro Filter is purpose-built to trade smoothing quality for low
 *    latency in a CAUSAL, real-time setting (it only ever sees past
 *    samples). That tradeoff buys nothing here -- the whole sequence is
 *    already available, so a non-causal filter (using past AND future
 *    samples within a window) is strictly better: no reason to accept
 *    latency-driven smoothing loss when latency isn't a concern. One Euro
 *    Filter IS the right choice for a future live-smoothing enhancement to
 *    the on-screen readout during capture (shared/biomechanics/motion-
 *    quality.js) -- a genuinely causal, real-time use case -- but that is a
 *    different pipeline stage than this one.
 *  - Kalman filtering requires a tuned process/motion model; unjustified
 *    complexity for position-only smoothing with no state-estimation goal
 *    beyond noise reduction.
 *  - Plain EMA introduces phase lag and poorly preserves peak curvature,
 *    which matters directly for peak-ROM / peak-motion detection
 *    (segmentation.js depends on accurate peak timing).
 *  - Savitzky-Golay (local polynomial least-squares regression) is
 *    well-established in movement-science literature for smoothing marker
 *    trajectories before kinematic differentiation, and -- because the
 *    fitted polynomial is available at each point -- could in principle
 *    supply analytic derivatives too, though this module only exposes the
 *    smoothed VALUE; trajectory-analysis.js differentiates the smoothed
 *    signal via finite differences instead (simpler, and every derivative
 *    stage's confidence degradation is documented there explicitly).
 *
 * ASSUMPTIONS:
 *  - The signal is treated as a locally polynomial (degree 2-3) function of
 *    time within each window -- appropriate for smooth, biological reaching
 *    movements, not for signals with genuine discontinuities.
 *  - Window size is a fixed constant (not adaptively re-tuned per movement
 *    speed, unlike One Euro Filter's adaptive cutoff) -- documented as a
 *    placeholder pending real-cohort calibration, same stance already used
 *    for ASRI's weights and reference targets.
 *
 * LIMITATIONS:
 *  - Larger windows smooth more but truncate/distort near sequence
 *    boundaries (asymmetric window there, not zero-padded) and near sharp
 *    velocity changes (movement onset/offset).
 *  - A frame with no detected landmarks (poor tracking) is treated as a
 *    missing sample and reconstructed from surrounding window points when
 *    enough are available, rather than fabricated from nothing -- if too
 *    few surrounding points exist, the output stays null (honestly
 *    propagated, not guessed).
 *
 * Exposed via a small strategy registry (STRATEGIES, same pattern as
 * shared/asri/aggregation-strategies.js) so the method is swappable later
 * without touching call sites.
 * ----------------------------------------------------------------------------
 */
// Phase 4 addition (Part 8, dataset metadata): identifies which filtering
// method/revision produced a stored task result. Bump manually if the
// smoothing algorithm changes; no behavior depends on this string.
const FILTER_VERSION = "savitzky_golay_v1";

const EPSILON = 1e-9;

/** Solve a small linear system Ax=b via Gaussian elimination with partial pivoting. */
function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < EPSILON) continue; // near-singular window; best-effort
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || EPSILON));
}

/** Least-squares polynomial fit of `ys` at positions `xs` (pre-centered so the
 *  evaluation point is x=0). Returns coefficients [c0, c1, ...] such that
 *  fitted(x) = c0 + c1*x + c2*x^2 + ...; c0 is the smoothed value at x=0. */
function fitLocalPolynomial(xs, ys, order) {
  const terms = order + 1;
  const XtX = Array.from({ length: terms }, () => new Array(terms).fill(0));
  const Xty = new Array(terms).fill(0);
  for (let i = 0; i < xs.length; i++) {
    const powers = new Array(terms);
    let p = 1;
    for (let k = 0; k < terms; k++) {
      powers[k] = p;
      p *= xs[i];
    }
    for (let r = 0; r < terms; r++) {
      Xty[r] += powers[r] * ys[i];
      for (let c = 0; c < terms; c++) XtX[r][c] += powers[r] * powers[c];
    }
  }
  return solveLinearSystem(XtX, Xty);
}

/**
 * Savitzky-Golay smoothing of a 1D signal at given (possibly irregular) times.
 * @param {Array<number|null>} values
 * @param {number[]} times - same length as values, in seconds
 * @param {object} [opts]
 * @param {number} [opts.halfWindow=4] - points considered on each side of center
 * @param {number} [opts.order=2] - polynomial order (2-3 typical for biological motion)
 */
function savitzkyGolaySmooth(values, times, { halfWindow = 4, order = 2 } = {}) {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n - 1, i + halfWindow);
    const xs = [];
    const ys = [];
    for (let j = lo; j <= hi; j++) {
      if (values[j] == null) continue; // missing sample within the window -- excluded, not zeroed
      xs.push(times[j] - times[i]);
      ys.push(values[j]);
    }
    const effectiveOrder = Math.min(order, Math.max(0, xs.length - 1));
    if (xs.length < effectiveOrder + 1 || xs.length === 0) {
      out[i] = null; // not enough surrounding data to reconstruct this point at all
      continue;
    }
    const coeffs = fitLocalPolynomial(xs, ys, effectiveOrder);
    out[i] = coeffs[0];
  }
  return out;
}

const STRATEGIES = { savitzky_golay: savitzkyGolaySmooth };

/**
 * Smooth every x/y/z channel of a landmark sequence. `frames` is an array of
 * {t, lm} (lm = MediaPipe landmark array or null for a failed-detection
 * frame), as produced by PoseEngine.getTaskHistory(). Returns a NEW array of
 * {t, lm} with smoothed landmark coordinates -- same {x,y,z} shape, so the
 * Biomechanical Engine (shared/biomechanics/*) re-runs on this output
 * completely unaware filtering happened.
 */
function filterLandmarkSequence(frames, { method = "savitzky_golay", halfWindow = 4, order = 2 } = {}) {
  const strategy = STRATEGIES[method];
  if (!strategy) throw new Error(`filterLandmarkSequence: unknown method "${method}"`);
  if (frames.length === 0) return [];

  const times = frames.map((f) => f.t / 1000); // ms -> s
  const landmarkCount = frames.find((f) => f.lm)?.lm.length ?? 0;

  const smoothed = { x: [], y: [], z: [] };
  for (const axis of ["x", "y", "z"]) {
    for (let idx = 0; idx < landmarkCount; idx++) {
      const values = frames.map((f) => (f.lm ? (f.lm[idx]?.[axis] ?? null) : null));
      smoothed[axis][idx] = strategy(values, times, { halfWindow, order });
    }
  }

  return frames.map((f, i) => ({
    t: f.t,
    lm:
      landmarkCount === 0
        ? null
        : Array.from({ length: landmarkCount }, (_, idx) => {
            const x = smoothed.x[idx][i];
            const y = smoothed.y[idx][i];
            if (x == null || y == null) return null;
            return { x, y, z: smoothed.z[idx][i] ?? 0 };
          }),
  }));
}

export { filterLandmarkSequence, savitzkyGolaySmooth, STRATEGIES, FILTER_VERSION };
