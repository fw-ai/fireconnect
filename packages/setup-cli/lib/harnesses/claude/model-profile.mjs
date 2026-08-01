import {
  DEFAULT_FIREPASS_MAIN_MODEL,
  defaultMainModel,
  isFirerouterModel,
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

export const DEFAULT_OPUS_MODEL = "glm-fast-latest";
export const DEFAULT_FABLE_MODEL = "kimi-fast-latest";
export const DEFAULT_SONNET_MODEL = "glm-fast-latest";
export const DEFAULT_HAIKU_MODEL = "deepseek-v4-flash";
export const DEFAULT_SUBAGENT_MODEL = DEFAULT_HAIKU_MODEL;

const PROFILE_VERSION = 1;
const KEY_TYPES = ["fireworks", "firepass"];

export function defaultClaudeModelMapping(keyType = "fireworks") {
  if (keyType === "firepass") {
    return Object.fromEntries(
      CLAUDE_MODEL_SLOTS.map((slot) => [slot, DEFAULT_FIREPASS_MAIN_MODEL]),
    );
  }
  return {
    main: defaultMainModel(),
    opus: DEFAULT_OPUS_MODEL,
    sonnet: DEFAULT_SONNET_MODEL,
    haiku: DEFAULT_HAIKU_MODEL,
    fable: DEFAULT_FABLE_MODEL,
    subagent: DEFAULT_SUBAGENT_MODEL,
  };
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

export function resolveClaudeModelMapping(overrides = {}, keyType = "fireworks") {
  const selected = mergeClaudeModelMappings(
    defaultClaudeModelMapping(keyType),
    overrides,
  );
  for (const [slot, flag] of [
    ["main", "--model"],
    ["opus", "--opus"],
    ["sonnet", "--sonnet"],
    ["haiku", "--haiku"],
    ["fable", "--fable"],
    ["subagent", "--subagent"],
  ]) {
    selected[slot] = normalizeModelId(selected[slot]);
    validateModelId(selected[slot], flag);
  }
  return selected;
}

export function mappingUsesFirerouter(mapping) {
  return Object.values(mapping).some((modelId) => isFirerouterModel(modelId));
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
      (slot) => profile.models[slot] === activeMapping[slot],
    )
  ));
  if (exactMatches.length === 1) return exactMatches[0][0];
  const scored = entries
    .map(([keyType, profile]) => ({
      keyType,
      matches: CLAUDE_MODEL_SLOTS.filter(
        (slot) => profile.models[slot] === activeMapping[slot],
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
