import { fireworksModelSlug, isFirerouterModel } from "./model-id.mjs";
import { lookupFireworksModelLimits } from "./model-specs.mjs";

/** Whether a Fireworks model/router accepts image input. FireRouter is excluded. */
export function modelSupportsVision(modelRef) {
  if (!modelRef || isFirerouterModel(modelRef)) {
    return true;
  }
  return lookupFireworksModelLimits(modelRef).vision;
}

/** Unique short IDs for text-only models in a mapping. */
export function uniqueNonVisionModelShortIds(modelRefs) {
  return [...new Set(
    [...modelRefs]
      .filter((modelRef) => modelRef && !isFirerouterModel(modelRef))
      .filter((modelRef) => !modelSupportsVision(modelRef))
      .map((modelRef) => fireworksModelSlug(modelRef))
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

/** Compact Claude image-safety warning. */
export function formatNonVisionModelsWarning(shortIds) {
  if (shortIds.length === 0) {
    return "";
  }
  return `Text-only: ${shortIds.join(", ")} · Avoid images; recover with /rewind.`;
}

/** Compact label for status and catalog output. */
export function visionCapabilityLabel(modelRef) {
  if (!modelRef || isFirerouterModel(modelRef)) {
    return "";
  }
  return modelSupportsVision(modelRef) ? "vision" : "text-only";
}
