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
  hasClaudeModelOverrides,
  mergeClaudeModelMappings,
  migrateLegacyClaudeModelMapping,
  normalizeClaudeProfiles,
  resolveClaudeModelMapping,
  savedClaudeModelMapping,
} from "./model-profile.mjs";
import { hasClaudeOAuthCredentials } from "./oauth.mjs";

export async function readClaudeActivationSnapshot(ctx) {
  const paths = claudePathsFor(ctx);
  const [settings, backup, state, globalConfig, hasClaudeOAuth] = await Promise.all([
    readJsonIfExists(paths.settingsPath),
    readJsonIfExists(providerBackupPath(paths.dataDir)),
    readJsonIfExists(providerStatePath(paths.dataDir)),
    readGlobalConfig(ctx.home),
    hasClaudeOAuthCredentials({ home: ctx.home, settingsPath: paths.settingsPath }),
  ]);
  const intent = claudeFireconnectIntent(settings, { backup, state });
  return {
    ...paths,
    settings,
    backup,
    state,
    hasClaudeOAuth,
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
  // setup with firerouter auth it takes the Opus slot. Every other slot keeps its
  // default; Fable already carries the vision model, so the vision slot stays
  // covered when Opus is the router.
  const automatic = firstSetup && automaticFirerouter && !explicitOverrides
    ? { opus: "firerouter" }
    : {};
  // Migrate legacy pinned slugs baked into an existing install (saved profile
  // and/or live settings) to their -latest router aliases before merging. Only
  // persisted state is migrated; explicit per-run CLI overrides (`overrides`)
  // are merged afterward so a deliberate `--haiku deepseek-v4-flash` is honored.
  const migratedSaved = migrateLegacyClaudeModelMapping(saved).mapping;
  const migratedActive = migrateLegacyClaudeModelMapping(active).mapping;
  return {
    firstSetup,
    explicitOverrides,
    mapping: resolveClaudeModelMapping(
      mergeClaudeModelMappings(migratedSaved, migratedActive, automatic, overrides),
      keyType,
    ),
  };
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
