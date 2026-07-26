import { fireworksModelSlug, isFirerouterModel } from "./model-id.mjs";
import { lookupFireworksModelLimits } from "./model-specs.mjs";

/** Whether a Fireworks model/router accepts image input. FireRouter is excluded. */
export function modelSupportsVision(modelRef) {
  if (!modelRef || isFirerouterModel(modelRef)) {
    return true;
  }
  return lookupFireworksModelLimits(modelRef).vision;
}

/**
 * Unique short model IDs in a mapping that lack vision support.
 * FireRouter slots are skipped because routing may still reach vision models.
 * @param {Iterable<string>} modelRefs
 * @returns {string[]}
 */
export function uniqueNonVisionModelShortIds(modelRefs) {
  const seen = new Set();
  /** @type {string[]} */
  const nonVision = [];
  for (const modelRef of modelRefs) {
    if (!modelRef || isFirerouterModel(modelRef) || modelSupportsVision(modelRef)) {
      continue;
    }
    const shortId = fireworksModelSlug(modelRef);
    if (!shortId || seen.has(shortId)) {
      continue;
    }
    seen.add(shortId);
    nonVision.push(shortId);
  }
  return nonVision.sort((left, right) => left.localeCompare(right));
}

/**
 * User-facing warning when Claude Code is configured with text-only models.
 * @param {string[]} shortIds
 * @returns {string}
 */
export function formatNonVisionModelsWarning(shortIds) {
  if (shortIds.length === 0) {
    return "";
  }
  const models = shortIds.length === 1
    ? `${shortIds[0]} is`
    : `${shortIds.slice(0, -1).join(", ")} and ${shortIds.at(-1)} are`;
  return (
    `${models} text-only (no vision). Claude Code cannot mark models as text-only, `
    + "so pasting or attaching images in a session with these models can break it — use /rewind to recover."
  );
}

/** Compact label for status and catalog output. */
export function visionCapabilityLabel(modelRef) {
  if (!modelRef || isFirerouterModel(modelRef)) {
    return "";
  }
  return modelSupportsVision(modelRef) ? "vision" : "text-only";
}
