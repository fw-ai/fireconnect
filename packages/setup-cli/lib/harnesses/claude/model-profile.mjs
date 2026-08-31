import {
  CLAUDE_NATIVE_MODEL_ID,
  CLAUDE_NATIVE_SLOT_ALIAS,
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  fireworksModelSlug,
  isClaudeNativeModel,
  isClaudeNativeSlotAlias,
  isFirerouterModelPattern,
  firerouterRequiresAnthropicKey,
  normalizeModelId,
  validateModelId,
} from "../../fireworks/model-id.mjs";

export const CLAUDE_MODEL_SLOTS = Object.freeze([
  "main",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "subagent",
]);

/** Pinned Fireworks router aliases for each Claude slot (main stays native). */
export const CLAUDE_FIREWORKS_PINNED_DEFAULTS = Object.freeze({
  opus: "glm-latest",
  sonnet: "deepseek-pro-latest",
  haiku: "deepseek-flash-latest",
  fable: "glm-flash-latest",
  subagent: "deepseek-flash-latest",
});

/** Opus override applied on first connect when FireRouter auth is available. */
export const FIRST_CONNECT_AUTOMATIC_OPUS_MODEL = "firerouter";
/** Sonnet companion when Opus is FireRouter — GLM moves off the Opus slot. */
export const FIRST_CONNECT_AUTOMATIC_SONNET_MODEL = "glm-latest";

export const DEFAULT_OPUS_MODEL = CLAUDE_FIREWORKS_PINNED_DEFAULTS.opus;
export const DEFAULT_FABLE_MODEL = CLAUDE_FIREWORKS_PINNED_DEFAULTS.fable;
export const DEFAULT_SONNET_MODEL = CLAUDE_FIREWORKS_PINNED_DEFAULTS.sonnet;
export const DEFAULT_HAIKU_MODEL = CLAUDE_FIREWORKS_PINNED_DEFAULTS.haiku;
export const DEFAULT_SUBAGENT_MODEL = CLAUDE_FIREWORKS_PINNED_DEFAULTS.subagent;

const PROFILE_VERSION = 1;
const KEY_TYPES = ["fireworks", "firepass"];

export function defaultClaudeModelMapping(keyType = "fireworks") {
  if (keyType === "firepass") {
    return Object.fromEntries(
      CLAUDE_MODEL_SLOTS.map((slot) => [slot, DEFAULT_FIREPASS_MAIN_MODEL]),
    );
  }
  // Main is never pinned: Claude Code resolves an unset main through the
  // account-default alias (Opus/Sonnet), which the slots below already remap.
  // Pinning it would write settings.model and shadow the `/model` picker.
  return {
    main: CLAUDE_NATIVE_MODEL_ID,
    ...CLAUDE_FIREWORKS_PINNED_DEFAULTS,
  };
}

/**
 * Pinned model slugs from older FireConnect defaults that should be rewritten to
 * their stable `-latest` router alias when an existing Claude Code install is
 * re-`on`ed. The writer re-applies the Claude Code `[1m]` context tag per slot,
 * so entries map bare slug -> bare router alias (e.g. deepseek-v4-flash ->
 * deepseek-flash-latest, which the writer serves as deepseek-flash-latest[1m]).
 */
const LEGACY_CLAUDE_MODEL_MIGRATIONS = Object.freeze({
  "deepseek-v4-flash": "deepseek-flash-latest",
});

/**
 * Rewrite any slot whose model slug is a legacy pinned default to its `-latest`
 * router alias. Used on the persisted (saved profile / live settings) mapping
 * during activation so an existing `claude on` install is migrated to the
 * current default routing; explicit per-run CLI overrides are merged afterward
 * and are not migrated.
 * @param {Record<string, string>} mapping
 * @returns {{ mapping: Record<string, string>, changed: boolean }}
 */
export function migrateLegacyClaudeModelMapping(mapping = {}) {
  const next = {};
  let changed = false;
  for (const [slot, modelId] of Object.entries(mapping)) {
    if (typeof modelId !== "string" || !modelId.trim()) {
      next[slot] = modelId;
      continue;
    }
    const target = LEGACY_CLAUDE_MODEL_MIGRATIONS[fireworksModelSlug(modelId)];
    if (target) {
      next[slot] = target;
      changed = true;
    } else {
      next[slot] = modelId;
    }
  }
  return { mapping: next, changed };
}

/** Whether a slot should appear in `claude status` (overrides only). */
export function isClaudeMappingOverride(modelId, slot, keyType, defaults = defaultClaudeModelMapping(keyType)) {
  if (!modelId) {
    return false;
  }
  if (isClaudeNativeModel(modelId)) {
    return false;
  }
  if (modelId === defaults[slot]) {
    return false;
  }
  return true;
}

/** Merge model sources from lowest to highest precedence. */
export function mergeClaudeModelMappings(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const slot of CLAUDE_MODEL_SLOTS) {
      if (typeof source?.[slot] === "string" && source[slot].trim()) {
        merged[slot] = source[slot].trim();
      }
    }
  }
  return merged;
}

export function claudeModelOverridesFrom(ctx) {
  return Object.fromEntries(
    CLAUDE_MODEL_SLOTS.map((slot) => [slot, ctx[slot] ?? ""]),
  );
}

export function hasClaudeModelOverrides(ctx) {
  return Object.values(claudeModelOverridesFrom(ctx)).some(Boolean);
}

const CLAUDE_SLOT_FLAGS = Object.freeze({
  main: "--model",
  opus: "--opus",
  sonnet: "--sonnet",
  haiku: "--haiku",
  fable: "--fable",
  subagent: "--subagent",
});

/**
 * Reject FireConnect's internal unpinned-slot sentinel when it arrives as a
 * user-supplied slot value. `claude-default` names nothing Claude Code or the
 * gateway can serve — inside FireConnect it only means "write no pin" — so
 * accepting it as input is how it ends up back in settings.json as a model id.
 * `native` is the spelling users are given for that intent.
 *
 * Persisted state is deliberately not checked here: a saved profile or a
 * settings file written by an older release legitimately carries the sentinel,
 * and {@link resolveClaudeModelMapping} canonicalizes those instead of failing.
 */
export function assertClaudeModelOverrides(ctx) {
  for (const [slot, value] of Object.entries(claudeModelOverridesFrom(ctx))) {
    if (!value || isClaudeNativeSlotAlias(value)) {
      continue;
    }
    if (!isClaudeNativeModel(normalizeModelId(value))) {
      continue;
    }
    const flag = CLAUDE_SLOT_FLAGS[slot];
    throw new Error(
      `${flag} ${value} is not a model id. Use \`${flag} ${CLAUDE_NATIVE_SLOT_ALIAS}\` `
        + "to leave the slot on Claude Code's own default model.",
    );
  }
}

export function resolveClaudeModelMapping(overrides = {}, keyType = "fireworks") {
  const selected = mergeClaudeModelMappings(
    defaultClaudeModelMapping(keyType),
    overrides,
  );
  for (const [slot, flag] of Object.entries(CLAUDE_SLOT_FLAGS)) {
    selected[slot] = normalizeModelId(selected[slot]);
    validateModelId(selected[slot], flag);
  }
  return selected;
}

export function mappingUsesFirerouter(mapping) {
  return Object.values(mapping).some((modelId) => isFirerouterModelPattern(modelId));
}

/** Whether any Claude slot is an Anthropic-requiring FireRouter selection. */
export function mappingRequiresAnthropicKey(mapping) {
  return Object.values(mapping).some((modelId) => firerouterRequiresAnthropicKey(modelId));
}

function completeMapping(raw) {
  const mapping = mergeClaudeModelMappings(raw);
  return CLAUDE_MODEL_SLOTS.every((slot) => Boolean(mapping[slot]))
    ? mapping
    : null;
}

/**
 * Normalize the persisted, key-scoped Claude profile envelope.
 * Invalid/legacy entries are ignored because this schema has not shipped.
 */
export function normalizeClaudeProfiles(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const profiles = {};
  for (const keyType of KEY_TYPES) {
    const profile = raw[keyType];
    const models = profile?.version === PROFILE_VERSION
      ? completeMapping(profile.models)
      : null;
    if (models) {
      profiles[keyType] = { version: PROFILE_VERSION, models };
    }
  }
  return profiles;
}

export function savedClaudeModelMapping(profiles, keyType) {
  return normalizeClaudeProfiles(profiles)[keyType]?.models ?? {};
}

// A native-Claude slot is persisted as the sentinel but read live as null/unset.
// Treat the two as equal when matching a live mapping against saved profiles.
function claudeSlotValuesMatch(left, right) {
  const norm = (value) => (value == null ? CLAUDE_NATIVE_MODEL_ID : value);
  return norm(left) === norm(right);
}

export function inferClaudeActiveKeyType({
  tokenKeyType = "",
  recordedKeyType = "",
  profiles = {},
  activeMapping = {},
  currentKeyType,
}) {
  if (KEY_TYPES.includes(tokenKeyType)) return tokenKeyType;
  if (KEY_TYPES.includes(recordedKeyType)) return recordedKeyType;

  const normalized = normalizeClaudeProfiles(profiles);
  const entries = Object.entries(normalized);
  const exactMatches = entries.filter(([, profile]) => (
    CLAUDE_MODEL_SLOTS.every(
      (slot) => claudeSlotValuesMatch(profile.models[slot], activeMapping[slot]),
    )
  ));
  if (exactMatches.length === 1) return exactMatches[0][0];
  const scored = entries
    .map(([keyType, profile]) => ({
      keyType,
      matches: CLAUDE_MODEL_SLOTS.filter(
        (slot) => claudeSlotValuesMatch(profile.models[slot], activeMapping[slot]),
      ).length,
    }))
    .sort((left, right) => right.matches - left.matches);
  const strongMatch = scored[0]?.matches >= Math.ceil(CLAUDE_MODEL_SLOTS.length * 2 / 3);
  if (strongMatch && scored[0].matches > (scored[1]?.matches ?? 0)) {
    return scored[0].keyType;
  }

  // Only pre-profile installs lack durable scope metadata. Once any profile
  // exists, ambiguous evidence must stay unknown or a key switch could import
  // the old live mapping into the newly selected profile.
  return entries.length === 0 && KEY_TYPES.includes(currentKeyType)
    ? currentKeyType
    : "";
}

export function withSavedClaudeModelMapping(profiles, keyType, mapping) {
  const normalized = normalizeClaudeProfiles(profiles);
  const models = completeMapping(mapping);
  if (!KEY_TYPES.includes(keyType) || !models) {
    throw new Error(`Cannot persist an incomplete Claude ${keyType} model profile`);
  }
  return {
    ...normalized,
    [keyType]: {
      version: PROFILE_VERSION,
      models,
    },
  };
}
