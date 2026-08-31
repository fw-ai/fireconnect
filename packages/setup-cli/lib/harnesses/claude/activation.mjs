import { readGlobalConfig } from "../../config/global-config.mjs";
import { claudePathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { readJsonIfExists } from "../../io/json.mjs";
import {
  claudeFireconnectIntent,
  providerBackupPath,
  providerStatePath,
} from "./core.mjs";
import {
  claudeModelOverridesFrom,
  CLAUDE_FIREWORKS_PINNED_DEFAULTS,
  FIRST_CONNECT_AUTOMATIC_OPUS_MODEL,
  FIRST_CONNECT_AUTOMATIC_SONNET_MODEL,
  hasClaudeModelOverrides,
  mergeClaudeModelMappings,
  migrateLegacyClaudeModelMapping,
  normalizeClaudeProfiles,
  resolveClaudeModelMapping,
  savedClaudeModelMapping,
} from "./model-profile.mjs";
import {
  isClaudeNativeModel,
  isClaudeNativeSlotAlias,
  isFirerouterModelPattern,
} from "../../fireworks/model-id.mjs";
export async function readClaudeActivationSnapshot(ctx) {
  const paths = claudePathsFor(ctx);
  const [settings, backup, state, globalConfig] = await Promise.all([
    readJsonIfExists(paths.settingsPath),
    readJsonIfExists(providerBackupPath(paths.dataDir)),
    readJsonIfExists(providerStatePath(paths.dataDir)),
    readGlobalConfig(ctx.home),
  ]);
  const intent = claudeFireconnectIntent(settings, { backup, state });
  return {
    ...paths,
    settings,
    backup,
    state,
    intent,
    profiles: normalizeClaudeProfiles(
      globalConfig.harnesses[HARNESS.CLAUDE]?.profiles,
    ),
  };
}

export function resolveClaudeActivationPlan({
  ctx,
  keyType,
  snapshot,
  activeKeyType,
  automaticFirerouter = false,
}) {
  const saved = savedClaudeModelMapping(snapshot.profiles, keyType);
  const active = snapshot.intent && activeKeyType === keyType
    ? snapshot.intent.mapping
    : {};
  const firstSetup = !snapshot.intent && Object.keys(saved).length === 0;
  const overrides = claudeModelOverridesFrom(ctx);
  const explicitOverrides = hasClaudeModelOverrides(ctx);
  // FireRouter is Opus-tier (it routes hard tasks to Claude Opus 5), so on first
  // setup with firerouter auth it takes the Opus slot and GLM moves to Sonnet.
  const automatic = firstSetup && automaticFirerouter && !explicitOverrides
    ? {
      opus: FIRST_CONNECT_AUTOMATIC_OPUS_MODEL,
      sonnet: FIRST_CONNECT_AUTOMATIC_SONNET_MODEL,
    }
    : {};
  // Migrate legacy pinned slugs baked into an existing install (saved profile
  // and/or live settings) to their -latest router aliases before merging. Only
  // persisted state is migrated; explicit per-run CLI overrides (`overrides`)
  // are merged afterward so a deliberate `--haiku deepseek-v4-flash` is honored.
  const migratedSaved = migrateLegacyClaudeModelMapping(saved).mapping;
  const migratedActive = migrateLegacyClaudeModelMapping(active).mapping;
  const merged = resolveClaudeModelMapping(
    mergeClaudeModelMappings(migratedSaved, migratedActive, automatic, overrides),
    keyType,
  );
  return {
    firstSetup,
    explicitOverrides,
    mapping: applyFirerouterSonnetDefault(merged, overrides, {
      saved: migratedSaved,
      active: migratedActive,
    }),
  };
}

/** When Opus is FireRouter, pin Sonnet to GLM unless the user chose Sonnet explicitly. */
function applyFirerouterSonnetDefault(mapping, overrides = {}, { saved = {}, active = {} } = {}) {
  if (!isFirerouterModelPattern(mapping.opus)) {
    return mapping;
  }
  if (overrides.sonnet?.trim()) {
    return mapping;
  }

  const baselineSonnet = CLAUDE_FIREWORKS_PINNED_DEFAULTS.sonnet;
  const activeSonnet = active.sonnet?.trim();
  if (activeSonnet) {
    if (isClaudeNativeModel(activeSonnet) || isClaudeNativeSlotAlias(activeSonnet)) {
      return mapping;
    }
    if (activeSonnet !== baselineSonnet) {
      return mapping;
    }
    // Live settings already pair FireRouter Opus with baseline Sonnet — keep it.
    if (isFirerouterModelPattern(active.opus)) {
      return mapping;
    }
  }

  const savedSonnet = saved.sonnet?.trim();
  if (savedSonnet && savedSonnet !== baselineSonnet) {
    return mapping;
  }

  const mergedSonnet = mapping.sonnet?.trim();
  if (mergedSonnet && mergedSonnet !== baselineSonnet) {
    return mapping;
  }

  return { ...mapping, sonnet: FIRST_CONNECT_AUTOMATIC_SONNET_MODEL };
}

export function canOnboardingSelectFirerouter({
  shouldRunOnboarding,
  keyType,
  hasFirerouterAuth,
}) {
  return shouldRunOnboarding
    && keyType === "fireworks"
    && hasFirerouterAuth;
}
