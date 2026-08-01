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
  const automatic = firstSetup && automaticFirerouter && !explicitOverrides
    ? { main: "firerouter" }
    : {};
  return {
    firstSetup,
    explicitOverrides,
    mapping: resolveClaudeModelMapping(
      mergeClaudeModelMappings(saved, active, automatic, overrides),
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
