import {
  CLAUDE_NATIVE_MODEL_ID,
  CLAUDE_NATIVE_SLOT_ALIAS,
  DEFAULT_FIREPASS_MAIN_MODEL,
  firerouterRequiresOpenaiKey,
  fireworksModelSlug,
  isClaudeNativeModel,
  isClaudeNativeSlotAlias,
  isFirerouterModel,
  isFirerouterModelPattern,
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
  return Object.fromEntries(
    CLAUDE_MODEL_SLOTS.map((slot) => [slot, CLAUDE_NATIVE_MODEL_ID]),
  );
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
  const value = ctx.main?.trim();
  if (value && !isClaudeNativeSlotAlias(value) && isClaudeNativeModel(normalizeModelId(value))) {
    throw new Error(
      `--model ${value} is not a Fireworks model id. Tier slots stay on Claude defaults; `
        + `\`--model\` chooses a serverless model and adds it to the /model picker.`,
    );
  }
  for (const [slot, flag] of Object.entries(CLAUDE_SLOT_FLAGS)) {
    if (slot === "main") {
      continue;
    }
    const raw = ctx[slot]?.trim();
    if (!raw || isClaudeNativeSlotAlias(raw)) {
      continue;
    }
    if (isClaudeNativeModel(normalizeModelId(raw))) {
      throw new Error(
        `${flag} ${raw} is not a model id. Use \`${flag} ${CLAUDE_NATIVE_SLOT_ALIAS}\` `
          + "to leave the slot on Claude Code's own default model.",
      );
    }
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

/**
 * Whether any Claude slot pins the bare `firerouter` model. The routing
 * preference is only honored there — not for `auto` or `firerouter/*`
 * compounds, which pin their own targets.
 */
export function mappingUsesBareFirerouter(mapping) {
  return Object.values(mapping).some((modelId) => isFirerouterModel(modelId));
}

/**
 * Whether any FireRouter route — bare `firerouter` or a `firerouter/*`
 * compound — is the `--model` pick or pinned to any slot. Fire Pass keys
 * cannot use FireRouter at all, so `on` rejects every such route there.
 * Mirrors `firePassRejectsRouter` in `SlotMapping.lean`.
 * @param {Record<string, string>} mapping resolved Claude slot mapping
 * @param {string|null} extraPickerModel normalized `--model` pick, if any
 */
export function claudeMappingUsesAnyFirerouter(mapping, extraPickerModel = null) {
  return [extraPickerModel, ...Object.values(mapping)]
    .some((modelId) => isFirerouterModelPattern(modelId ?? ""));
}

/**
 * Whether a configured OpenAI key should ride along as `x-openai-api-key`:
 * bare `firerouter` anywhere (its mix can serve GPT primaries), or a GPT
 * compound like `firerouter/gpt-...` as the /model default or pinned to any
 * tier slot (saved or flagged). Pinned non-GPT compounds stay clean. Mirrors
 * `needsOpenaiKey` in `SlotMapping.lean`.
 * @param {Record<string, string>} mapping resolved Claude slot mapping
 * @param {string|null} defaultModel the top-level /model default `on` writes
 *   (`--model`, a kept saved pick, or the implicit firerouter default)
 */
export function claudeMappingNeedsOpenaiKey(mapping, defaultModel = null) {
  return [defaultModel, ...Object.values(mapping)]
    .some((modelId) => isFirerouterModel(modelId ?? "")
      || firerouterRequiresOpenaiKey(modelId ?? ""));
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
