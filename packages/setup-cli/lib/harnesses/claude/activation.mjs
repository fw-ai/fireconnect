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
  mergeClaudeModelMappings,
  migrateLegacyClaudeModelMapping,
  normalizeClaudeProfiles,
  resolveClaudeModelMapping,
  savedClaudeModelMapping,
} from "./model-profile.mjs";
import { normalizeModelId } from "../../fireworks/model-id.mjs";

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
}) {
  if (keyType === "firepass") {
    const saved = savedClaudeModelMapping(snapshot.profiles, keyType);
    const active = snapshot.intent && activeKeyType === keyType
      ? snapshot.intent.mapping
      : {};
    const mainOverride = ctx.main?.trim()
      ? { main: normalizeModelId(ctx.main) }
      : {};
    const migratedSaved = migrateLegacyClaudeModelMapping(saved).mapping;
    const migratedActive = migrateLegacyClaudeModelMapping(active).mapping;
    const mapping = resolveClaudeModelMapping(
      mergeClaudeModelMappings(migratedSaved, migratedActive, mainOverride),
      keyType,
    );
    return { mapping };
  }
  return { mapping: resolveClaudeModelMapping({}, keyType) };
}
