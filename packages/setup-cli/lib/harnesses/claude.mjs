import {
  FIREWORKS_BASE_URL,
  applyModelMapping,
  defaultModelIds,
  detectApiKeyType,
  disableFireworksProvider,
  enableFireworksProvider,
  mappingFromEnv,
  providerStatePath,
  providerStatusFromEnv,
  readJsonIfExists,
  resolveModelMapping,
} from "../fireconnect-core.mjs";
import { isFireworksKey, resolveFireworksApiKey } from "../fireworks-models.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runClaudeModelSelect } from "../model-select.mjs";
import { printClaudeModelRoutingHint } from "../claude-hints.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  claudePathsFor,
  ensureHomeForHarness,
  modelOverridesFrom,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";
import { isHarnessEnabled, setHarnessEnabled } from "../global-config.mjs";

/**
 * Harness-local Fireworks key for Claude Code: the key stored in the harness's
 * own settings/state. Returns "" when none is present.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function claudeResolveKey(ctx) {
  const { settingsPath, dataDir } = claudePathsFor(ctx);
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const env = settings.env ?? {};
  if (isFireworksKey(env.ANTHROPIC_API_KEY)) {
    return env.ANTHROPIC_API_KEY.trim();
  }
  if (isFireworksKey(env.ANTHROPIC_AUTH_TOKEN)) {
    return env.ANTHROPIC_AUTH_TOKEN.trim();
  }
  if (isFireworksKey(state.fireworksApiKey)) {
    return state.fireworksApiKey.trim();
  }
  return "";
}

/**
 * Full resolution chain for Claude Code (flag > harness-local > global > env).
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
function claudeApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => claudeResolveKey(ctx),
    home: ctx.home,
  });
}

export default defineHarness({
  id: HARNESS.CLAUDE,
  label: "Claude Code",
  resolveKey: claudeResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const token = await claudeApiKey(ctx);
    const keyType = detectApiKeyType(token);
    await enableFireworksProvider({
      settingsPath,
      dataDir,
      apiKey: token,
      baseUrl: ctx.baseUrl || FIREWORKS_BASE_URL,
      mapping: resolveModelMapping(modelOverridesFrom(ctx), keyType),
      keyType,
    });
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, true);
    console.log("Fireworks provider enabled.");
    printClaudeModelRoutingHint();
    if (keyType === "firepass") {
      console.log("Fire Pass key detected: using kimi-k2p7-code-fast for all aliases.");
    } else {
      console.log("Browse models: fireconnect claude model list");
      console.log("Pick a model:  fireconnect claude model select");
    }
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.CLAUDE);
    await disableFireworksProvider({ settingsPath, dataDir, wasEnabled });
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, false);
    console.log("Fireworks provider disabled. Restart Claude Code for full effect.");
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const env = settings.env ?? {};
    const token = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey || "";
    const keyType = detectApiKeyType(token);
    const payload = {
      harness: HARNESS.CLAUDE,
      provider: providerStatusFromEnv(env),
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      hasAuthToken: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
      keyType,
      defaults: defaultModelIds(keyType),
      current: mappingFromEnv(env),
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Harness: ${HARNESS.CLAUDE}`);
    console.log(`Provider: ${payload.provider}`);
    console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
    console.log(`Auth token present: ${payload.hasAuthToken ? "yes" : "no"}`);
    if (keyType === "firepass") {
      console.log("Key type: Fire Pass (kimi-k2p7-code-fast only)");
    }
    console.log("");

    if (keyType !== "firepass") {
      console.log("Default mapping:");
      console.log(`  main     -> ${payload.defaults.main}`);
      console.log(`  opus     -> ${payload.defaults.opus}`);
      console.log(`  sonnet   -> ${payload.defaults.sonnet}`);
      console.log(`  haiku    -> ${payload.defaults.haiku}`);
      console.log(`  subagent -> ${payload.defaults.subagent}`);
      console.log("");
    }

    console.log("Current mapping:");
    console.log(`  main     -> ${payload.current.main ?? "(unset)"}`);
    console.log(`  opus     -> ${payload.current.opus ?? "(unset)"}`);
    console.log(`  sonnet   -> ${payload.current.sonnet ?? "(unset)"}`);
    console.log(`  haiku    -> ${payload.current.haiku ?? "(unset)"}`);
    console.log(`  subagent -> ${payload.current.subagent ?? "(unset)"}`);
  },

  async modelList(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const apiKey = await claudeApiKey(ctx);
    await runModelListCommand({
      options: ctx,
      harness: HARNESS.CLAUDE,
      apiKey,
    });
  },

  async modelReset(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const env = settings.env ?? {};
    const token = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey || "";
    const keyType = detectApiKeyType(token);
    await applyModelMapping({ settingsPath, mapping: resolveModelMapping({}, keyType) });
    console.log("Reset Claude Code model aliases to defaults.");
    printClaudeModelRoutingHint();
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath } = claudePathsFor(ctx);
    const apiKey = await claudeApiKey(ctx);
    await runClaudeModelSelect({
      options: ctx,
      settingsPath,
      apiKey,
    });
  },
});
