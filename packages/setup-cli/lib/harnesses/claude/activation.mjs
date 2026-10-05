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
import { CLAUDE_TIER_SLOTS, claudeSlotOverridesFromCtx } from "./connect.mjs";
import { normalizeModelId } from "../../fireworks/model-id.mjs";

/** Tier-slot slice of a mapping; `main` stays picker-managed on standard keys. */
function tierSlotsOf(mapping = {}) {
  return Object.fromEntries(
    CLAUDE_TIER_SLOTS
      .filter((slot) => typeof mapping[slot] === "string" && mapping[slot].trim())
      .map((slot) => [slot, mapping[slot]]),
  );
}

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
    // Tier flags merge here too so they are never silently dropped: a Fire Pass
    // router pin applies, while `native` / `firerouter` reach the Fire Pass
    // guards in `on` and fail loudly instead of exiting 0 unchanged.
    const mapping = resolveClaudeModelMapping(
      mergeClaudeModelMappings(
        migratedSaved,
        migratedActive,
        mainOverride,
        claudeSlotOverridesFromCtx(ctx),
      ),
      keyType,
    );
    return { mapping };
  }
  // Standard keys default every tier slot to native, but explicit `--opus` …
  // `--subagent` flags pin slots and re-`on` preserves pins saved by an
  // earlier `on` (saved profile, then live settings). Explicit flags win;
  // `native` unpins back to Claude defaults. `--model` stays picker-only.
  const saved = savedClaudeModelMapping(snapshot.profiles, keyType);
  const active = snapshot.intent && activeKeyType === keyType
    ? snapshot.intent.mapping
    : {};
  const overrides = claudeSlotOverridesFromCtx(ctx);
  const migratedSaved = migrateLegacyClaudeModelMapping(saved).mapping;
  const migratedActive = migrateLegacyClaudeModelMapping(active).mapping;
  return {
    mapping: resolveClaudeModelMapping(
      mergeClaudeModelMappings(
        tierSlotsOf(migratedSaved),
        tierSlotsOf(migratedActive),
        overrides,
      ),
      keyType,
    ),
  };
}
