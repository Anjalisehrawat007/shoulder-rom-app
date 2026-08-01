/**
 * frame-quality.js — ICQA lighting, sharpness, and background analysis
 * ----------------------------------------------------------------------------
 * Operates on a plain `{width, height, data}` RGBA pixel buffer -- the same
 * shape as the DOM's `ImageData` (and deliberately not typed against the DOM
 * class itself), so this module runs identically in the browser (via
 * `canvas.getContext("2d").getImageData(...)`, the same offscreen-canvas
 * pattern `capture/app.js`'s `captureStill()` already uses) and in Node for
 * `scripts/verify-icqa.mjs`'s synthetic tests -- no jsdom/canvas dependency
 * needed to test the math.
 *
 * LIGHTING: `measured` -- real pixel luminance statistics, not a proxy.
 * Standard luma formula (Rec. 601): L = 0.299R + 0.587G + 0.114B.
 *
 * SHARPNESS / MOTION BLUR: `estimated` via a Laplacian-variance sharpness
 * proxy (Pech-Pacheco et al., 2000, "Diatom autofocusing in brightfield
 * microscopy: a comparative study" -- the standard cheap sharpness heuristic:
 * a sharp image has high-variance response to a Laplacian edge kernel; a
 * blurred one has low variance). This measures blur/defocus in general, not
 * specifically motion blur vs. out-of-focus blur -- the two are not
 * distinguished by this heuristic, which is stated as a limitation, not
 * hidden.
 *
 * BACKGROUND COMPLEXITY: `estimated` via edge-density (gradient magnitude
 * fraction above a threshold) in the image region OUTSIDE the subject's
 * bounding box -- a simple, standard proxy for visual clutter, not a scene
 * classifier.
 * ----------------------------------------------------------------------------
 */
import { makeParameter } from "../biomechanics/parameter-schema.js";

/** Downsample-friendly grayscale conversion. `stride` skips pixels for speed
 *  on large frames -- ICQA runs this on a pre-downscaled offscreen canvas
 *  (see docs/icqa.md), so stride=1 is fine there; exposed for testability. */
function toGrayscale({ width, height, data }, stride = 1) {
  const gw = Math.ceil(width / stride);
  const gh = Math.ceil(height / stride);
  const gray = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * stride, y = gy * stride;
      const i = (y * width + x) * 4;
      gray[gy * gw + gx] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return { gray, gw, gh };
}

function analyzeLighting(imageData) {
  const { data } = imageData;
  const n = data.length / 4;
  let sum = 0;
  let over = 0;
  let under = 0;
  const lumas = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    lumas[p] = l;
    sum += l;
    if (l > 250) over++;
    if (l < 10) under++;
  }
  const mean = sum / n;
  let variance = 0;
  for (let p = 0; p < n; p++) variance += (lumas[p] - mean) ** 2;
  variance /= n;
  return {
    meanLuminance: makeParameter({ value: Math.round(mean * 10) / 10, unit: "0-255", measurementType: "measured", confidence: "high" }),
    overExposedFraction: makeParameter({ value: Math.round((over / n) * 1000) / 1000, unit: "fraction", measurementType: "measured", confidence: "high" }),
    underExposedFraction: makeParameter({ value: Math.round((under / n) * 1000) / 1000, unit: "fraction", measurementType: "measured", confidence: "high" }),
    contrast: makeParameter({ value: Math.round(Math.sqrt(variance) * 10) / 10, unit: "stddev_0-255", measurementType: "measured", confidence: "high" }),
  };
}

function analyzeSharpness(imageData) {
  const { gray, gw, gh } = toGrayscale(imageData);
  if (gw < 3 || gh < 3) {
    return makeParameter({ value: null, unit: "laplacian_variance", measurementType: "unavailable", limitation: "Frame too small to compute a 3x3 Laplacian response." });
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const c = gray[y * gw + x];
      const lap =
        gray[(y - 1) * gw + x] + gray[(y + 1) * gw + x] + gray[y * gw + (x - 1)] + gray[y * gw + (x + 1)] - 4 * c;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return makeParameter({
    value: Math.round(variance * 100) / 100, unit: "laplacian_variance", measurementType: "estimated", confidence: "moderate",
    limitation: "Laplacian-variance sharpness proxy (Pech-Pacheco et al. 2000) -- a low value indicates the frame is blurred, but does not distinguish motion blur from an out-of-focus lens.",
  });
}

/** bboxNormalized: {minX, maxX, minY, maxY} in 0-1 image-fraction coords
 *  (as returned by camera-geometry.js's boundingBox()), or null if no
 *  subject bounding box is available -- in that case background complexity
 *  is computed over the whole frame, documented as a weaker proxy. */
function analyzeBackgroundComplexity(imageData, bboxNormalized) {
  const { width, height } = imageData;
  const { gray, gw, gh } = toGrayscale(imageData);
  if (gw < 3 || gh < 3) {
    return makeParameter({ value: null, unit: "edge_density", measurementType: "unavailable", limitation: "Frame too small to compute a gradient response." });
  }
  const box = bboxNormalized
    ? { minX: bboxNormalized.minX * gw, maxX: bboxNormalized.maxX * gw, minY: bboxNormalized.minY * gh, maxY: bboxNormalized.maxY * gh }
    : null;

  let edgeCount = 0;
  let total = 0;
  const GRAD_THRESHOLD = 25; // documented default, see config/icqa-config.v1.json
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      if (box && x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY) continue; // inside subject bbox -- skip
      const gx = gray[y * gw + (x + 1)] - gray[y * gw + (x - 1)];
      const gy = gray[(y + 1) * gw + x] - gray[(y - 1) * gw + x];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > GRAD_THRESHOLD) edgeCount++;
      total++;
    }
  }
  if (total === 0) {
    return makeParameter({ value: null, unit: "edge_density", measurementType: "unavailable", limitation: "Subject bounding box covers the entire frame; no background region left to sample." });
  }
  return makeParameter({
    value: Math.round((edgeCount / total) * 1000) / 1000, unit: "edge_density", measurementType: "estimated", confidence: "moderate",
    limitation: bboxNormalized
      ? "Edge-density proxy for background visual clutter, sampled outside the subject's bounding box -- a busy patterned floor near the subject can still inflate this even though it wouldn't occlude tracking."
      : "No subject bounding box was available, so this was computed over the WHOLE frame including the subject -- a weaker proxy than the bbox-excluded version.",
  });
}

function analyzeFrameQuality({ imageData, bboxNormalized = null }) {
  return {
    lighting: analyzeLighting(imageData),
    sharpness: analyzeSharpness(imageData),
    backgroundComplexity: analyzeBackgroundComplexity(imageData, bboxNormalized),
  };
}

export { analyzeFrameQuality, toGrayscale };
