import { claudeCodeModelId } from "./code-context.mjs";
import { normalizeModelId, shortFireworksModelRef } from "../../fireworks/model-id.mjs";
import {
  fireworksModelPickerDescription,
  fireworksModelPickerName,
} from "./picker-labels.mjs";

/** Marker on settings.modelPicker so `off` can remove FireConnect rows only. */
export const FIRECONNECT_MODEL_PICKER_MANAGED_KEY = "fireconnectManaged";
export const INVALID_MODEL_PICKER_MESSAGE =
  "Claude Code's modelPicker must be an object whose options are rows with a non-empty model string. "
  + "FireConnect did not change it.";
export const FIREPASS_MODEL_PICKER_CONFLICT_MESSAGE =
  "Claude Code's modelPicker does not have fireconnectManaged: true, so FireConnect "
  + "cannot remove it for Fire Pass. FireConnect did not change it.";

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
 * Validate the picker before `on` mutates settings. Standard keys append to a
 * valid options list. Fire Pass leaves a pre-existing picker alone unless a
 * prior standard-key setup requires removing FireConnect's marked picker.
 */
export function validateClaudeModelPicker(
  settings,
  { keyType = "fireworks", priorKeyType = "" } = {},
) {
  if (!Object.hasOwn(settings, "modelPicker")) {
    return;
  }
  const picker = settings.modelPicker;
  const valid = picker
    && typeof picker === "object"
    && !Array.isArray(picker)
    && (picker.options === undefined || (
      Array.isArray(picker.options)
      && picker.options.every((row) => (
        row
        && typeof row === "object"
        && !Array.isArray(row)
        && typeof row.model === "string"
        && row.model.trim()
      ))
    ));
  if (!valid) {
    throw new Error(INVALID_MODEL_PICKER_MESSAGE);
  }
  if (keyType === "firepass" && priorKeyType !== "fireworks") {
    return;
  }
  if (keyType === "firepass" && !isFireconnectModelPicker(picker)) {
    throw new Error(FIREPASS_MODEL_PICKER_CONFLICT_MESSAGE);
  }
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
    const normalized = typeof id === "string"
      ? shortFireworksModelRef(normalizeModelId(id))
      : "";
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    options.push(fireconnectModelPickerOption(normalized));
  }
  return options;
}

/**
 * Preserve existing picker rows and append missing FireConnect rows. Model ids
 * are canonicalized first, so full, short, bare, and `[1m]` forms dedupe.
 * @param {Record<string, unknown>} settings
 * @param {string[]} registerableIds
 * @returns {Record<string, unknown>}
 */
export function withFireconnectModelPicker(settings, registerableIds) {
  const options = buildFireconnectModelPickerOptions(registerableIds);
  if (!options.length) {
    return settings;
  }
  if (!Object.hasOwn(settings, "modelPicker")) {
    return {
      ...settings,
      modelPicker: {
        [FIRECONNECT_MODEL_PICKER_MANAGED_KEY]: true,
        replaceBuiltInOptions: false,
        options,
      },
    };
  }
  validateClaudeModelPicker(settings);
  const existing = settings.modelPicker;
  const existingOptions = existing.options ?? [];
  const present = new Set(
    existingOptions
      .map((row) => (typeof row?.model === "string"
        ? shortFireworksModelRef(normalizeModelId(row.model))
        : ""))
      .filter(Boolean),
  );
  const missing = [];
  for (const row of options) {
    const id = shortFireworksModelRef(normalizeModelId(row.model));
    if (!id || present.has(id)) {
      continue;
    }
    present.add(id);
    missing.push(row);
  }
  if (!missing.length) {
    return settings;
  }
  return {
    ...settings,
    modelPicker: {
      ...existing,
      options: [...existingOptions, ...missing],
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
