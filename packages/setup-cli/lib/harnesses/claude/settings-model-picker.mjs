import { claudeCodeModelId } from "./code-context.mjs";
import { shortFireworksModelRef } from "../../fireworks/model-id.mjs";
import {
  fireworksModelPickerDescription,
  fireworksModelPickerName,
} from "./picker-labels.mjs";

/** Marker on settings.modelPicker so `off` can remove FireConnect rows only. */
export const FIRECONNECT_MODEL_PICKER_MANAGED_KEY = "fireconnectManaged";

/**
 * @param {unknown} modelPicker
 * @returns {boolean}
 */
export function isFireconnectModelPicker(modelPicker) {
  return Boolean(
    modelPicker
    && typeof modelPicker === "object"
    && !Array.isArray(modelPicker)
    && modelPicker[FIRECONNECT_MODEL_PICKER_MANAGED_KEY] === true,
  );
}

/**
 * @param {string} modelId bare or full Fireworks slug
 * @returns {{ model: string, label: string, description: string }}
 */
export function fireconnectModelPickerOption(modelId) {
  const tagged = shortFireworksModelRef(claudeCodeModelId(modelId));
  return {
    model: tagged,
    label: fireworksModelPickerName(modelId),
    description: fireworksModelPickerDescription(modelId),
  };
}

/**
 * Build Claude Code `modelPicker.options` for the registerable catalog.
 * @param {string[]} registerableIds bare slugs / router ids (in display order)
 * @returns {{ model: string, label: string, description: string }[]}
 */
export function buildFireconnectModelPickerOptions(registerableIds = []) {
  const seen = new Set();
  /** @type {{ model: string, label: string, description: string }[]} */
  const options = [];
  for (const id of registerableIds) {
    if (typeof id !== "string" || !id.trim() || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push(fireconnectModelPickerOption(id));
  }
  return options;
}

/**
 * @param {Record<string, unknown>} settings
 * @param {string[]} registerableIds
 * @returns {Record<string, unknown>}
 */
export function withFireconnectModelPicker(settings, registerableIds) {
  const options = buildFireconnectModelPickerOptions(registerableIds);
  if (!options.length) {
    return settings;
  }
  const existing = settings.modelPicker;
  if (existing && typeof existing === "object" && !Array.isArray(existing)
    && !isFireconnectModelPicker(existing)) {
    return settings;
  }
  return {
    ...settings,
    modelPicker: {
      [FIRECONNECT_MODEL_PICKER_MANAGED_KEY]: true,
      replaceBuiltInOptions: false,
      options,
    },
  };
}

/**
 * @param {Record<string, unknown>} settings
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function stripFireconnectModelPicker(settings) {
  if (!isFireconnectModelPicker(settings?.modelPicker)) {
    return { settings, changed: false };
  }
  const next = { ...settings };
  delete next.modelPicker;
  return { settings: next, changed: true };
}
