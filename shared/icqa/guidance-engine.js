/**
 * guidance-engine.js — ICQA human-friendly guidance
 * ----------------------------------------------------------------------------
 * Turns subscore numbers into ONE primary, plain-language instruction a
 * parent/caregiver can act on ("Move back a little"), plus a secondary list
 * of anything else worth mentioning -- not a red/green checklist of
 * criterion codes, which is meaningless to a non-clinical user standing in
 * their living room. Severity ranking prioritizes gate-BLOCKING issues over
 * merely-advisory ones, and among blocking issues, the one furthest below
 * its threshold -- fixing the worst problem first is more useful than an
 * alphabetical or arbitrary list.
 * ----------------------------------------------------------------------------
 */

function messageForCameraPosition({ geometry }) {
  if (geometry.distanceCategory.value === "too_close") return "Move back a little — I can only see part of your child's body.";
  if (geometry.distanceCategory.value === "too_far") return "Move a bit closer — your child looks quite small in the frame.";
  if (geometry.framing.touchesTopEdge || geometry.framing.touchesBottomEdge) return "Step back so your child's whole body fits in the picture, head to feet.";
  if (geometry.tilt.value != null && Math.abs(geometry.tilt.value) > 10) return "Hold the camera more level — it looks tilted up or down.";
  if (geometry.roll.value != null && Math.abs(geometry.roll.value) > 8) return "Straighten the camera — it looks rotated to one side.";
  if (geometry.framing.centeredness.value != null && geometry.framing.centeredness.value < 0.6) return "Center your child in the middle of the frame.";
  return "Adjust the camera position — your child isn't well framed yet.";
}

function messageForLighting({ frameQuality }) {
  const L = frameQuality.lighting;
  if (L.meanLuminance.value != null && L.meanLuminance.value < 60) return "It's too dark — turn on more light or move to a brighter room.";
  if (L.meanLuminance.value != null && L.meanLuminance.value > 200) return "It's too bright — try softening direct light.";
  if (L.overExposedFraction.value != null && L.overExposedFraction.value > 0.05) return "There's a bright light behind your child — try facing them toward a window or lamp instead of away from it.";
  if (frameQuality.sharpness.value != null && frameQuality.sharpness.value < 40) return "The picture looks a little blurry — hold the phone or camera steady.";
  return "Improve the lighting so your child is clearly visible.";
}

function worstBodyPart(visibility) {
  const priority = ["feet", "hips", "shoulders", "arms", "head"];
  for (const part of priority) {
    if (visibility.occludedParts.includes(part)) return part;
  }
  return visibility.occludedParts[0] ?? null;
}

const BODY_PART_MESSAGES = {
  feet: "Step back so I can see your child's feet.",
  hips: "Step back so I can see your child's hips and legs.",
  shoulders: "Make sure both shoulders are visible in the frame.",
  arms: "Make sure the arm being tested is fully visible.",
  head: "Make sure your child's head and face are visible.",
};

function messageForBodyVisibility({ visibility }) {
  if (visibility.multiPerson.value === true) return "Only your child should be in frame — please ask anyone else to step out of view.";
  const part = worstBodyPart(visibility);
  if (part) return BODY_PART_MESSAGES[part];
  return "Make sure your child's whole body is visible in the frame.";
}

const MESSAGE_BUILDERS = {
  cameraPosition: messageForCameraPosition,
  lighting: messageForLighting,
  bodyVisibility: messageForBodyVisibility,
  occlusionScore: messageForBodyVisibility,
  poseReadiness: () => "Hold still for a moment so tracking can lock on.",
  backgroundQuality: () => "A plainer background behind your child can help tracking, though this isn't required.",
  trackingStability: () => "Keep the camera steady for a moment.",
  movementReadiness: () => "Ask your child to stand still for a moment before starting.",
};

/**
 * @param {object} args
 * @param {object} args.icqaResult - output of icqa-engine.js's IcqaEngine.score()
 * @param {object} args.geometry - raw camera-geometry.js output (for message specificity)
 * @param {object} args.frameQuality - raw frame-quality.js output
 * @param {object} args.visibility - raw visibility-analysis.js output
 * @param {object} args.config - the active icqa-config, for gating/threshold lookups
 */
function buildGuidance({ icqaResult, geometry, frameQuality, visibility, config }) {
  const warnBelow = config.guidance.warnBelowScore;
  const gating = config.gating;
  const raw = { geometry, frameQuality, visibility };

  const candidates = [];
  for (const [key, sub] of Object.entries(icqaResult.subscores || {})) {
    if (sub.score == null || sub.score >= warnBelow) continue;
    const gate = gating[key] || {};
    const blocking = !!gate.required && sub.score < gate.minScore;
    const severity = (warnBelow - sub.score) * (blocking ? 2 : 1);
    const builder = MESSAGE_BUILDERS[key];
    const message = builder ? builder(raw) : `${sub.label} could be improved.`;
    candidates.push({ key, message, blocking, severity });
  }

  // De-duplicate identical messages (e.g. bodyVisibility and occlusionScore
  // both failing for the same missing-feet reason shouldn't repeat itself).
  const seen = new Set();
  const deduped = candidates.filter((c) => (seen.has(c.message) ? false : (seen.add(c.message), true)));
  deduped.sort((a, b) => b.severity - a.severity);

  return {
    primary: deduped[0]?.message ?? "Looks good — ready to start.",
    secondary: deduped.slice(1).map((c) => c.message),
    blockingCount: deduped.filter((c) => c.blocking).length,
  };
}

export { buildGuidance };
