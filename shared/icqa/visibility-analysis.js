/**
 * visibility-analysis.js — ICQA body-part visibility, occlusion, multi-person
 * ----------------------------------------------------------------------------
 * BODY-PART VISIBILITY: `measured` directly from MediaPipe's own per-landmark
 * `visibility` score (0-1, MediaPipe's own model confidence that the point is
 * both present AND unoccluded) -- this is a real signal already computed by
 * the pose model, not a proxy ICQA invents. Grouped into head/shoulders/
 * arms/hips/feet via shared/icqa/landmark-groups.js.
 *
 * OCCLUSION: derived from the same visibility scores -- a body part group
 * whose average visibility drops below a configured threshold is flagged as
 * occluded. This cannot distinguish "occluded by an object" from "out of
 * frame" from "poor lighting confusing the model" -- all three lower
 * MediaPipe's visibility score identically. Documented as occlusion-OR-
 * absence, not true object-level occlusion detection.
 *
 * MULTI-PERSON: `measured` when a second-pass detection result is supplied
 * (capture/pose-engine.js's secondary numPoses:2 landmarker, run only during
 * the pre-task gate -- see docs/icqa.md); `unavailable` otherwise, since the
 * main single-pose task-capture pipeline never runs multi-person detection
 * and this module cannot infer a person count from a single-pose result.
 * ----------------------------------------------------------------------------
 */
import { makeParameter } from "../biomechanics/parameter-schema.js";
import { BODY_PART_GROUPS } from "./landmark-groups.js";

function groupVisibility(landmarks, indices) {
  let sum = 0;
  let count = 0;
  for (const idx of indices) {
    const p = landmarks[idx];
    if (!p) continue;
    sum += p.visibility ?? 0;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function analyzeVisibility({ landmarks, secondaryPersonCount = null, config }) {
  const cfg = config.visibility;
  const bodyParts = {};
  for (const [part, indices] of Object.entries(BODY_PART_GROUPS)) {
    const vis = landmarks ? groupVisibility(landmarks, indices) : 0;
    bodyParts[part] = makeParameter({
      value: Math.round(vis * 1000) / 1000, unit: "0-1", measurementType: "measured", confidence: vis > 0 ? "high" : null,
      limitation: vis > 0 ? "" : "No landmarks detected for this body part in the current frame.",
    });
  }

  const occludedParts = Object.entries(bodyParts)
    .filter(([, p]) => p.value != null && p.value < cfg.occlusionVisibilityThreshold)
    .map(([part]) => part);

  const occlusion = makeParameter({
    value: occludedParts.length > 0, unit: "boolean", measurementType: "measured", confidence: "moderate",
    limitation: "Derived from MediaPipe's per-landmark visibility score, which drops identically whether a body part is occluded by an object, out of frame, or just poorly lit -- this cannot distinguish those causes.",
  });

  let multiPerson;
  if (secondaryPersonCount != null) {
    multiPerson = makeParameter({ value: secondaryPersonCount > 1, unit: "boolean", measurementType: "measured", confidence: "moderate" });
  } else {
    multiPerson = makeParameter({ value: null, unit: "boolean", measurementType: "unavailable", limitation: "The secondary multi-person detection pass has not run this cycle (it runs only during the pre-task gate, at reduced frequency, to avoid the cost of a second model on every frame)." });
  }

  return { bodyParts, occludedParts, occlusion, multiPerson };
}

export { analyzeVisibility };
