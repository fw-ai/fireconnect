import {
  FIREWORKS_BASE_URL,
  applyModelMapping,
  defaultModelIds,
  detectApiKeyType,
  disableFireworksProvider,
  enableFireworksProvider,
  mappingFromEnv,
  providerStatusFromEnv,
  readJsonIfExists,
  resolveModelMapping,
} from "../fireconnect-core.mjs";
import {
  disableFirerouterClaude,
  enableFirerouterClaude,
} from "../claude-firerouter.mjs";
import { isFireworksKey, resolveFireworksApiKey } from "../fireworks-models.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runClaudeModelSelect } from "../model-select.mjs";
import { printClaudeModelActivationHint } from "../claude-hints.mjs";
import {
  attachPricing,
  CLAUDE_CODE_PRICING_DISCLAIMER,
  formatPricingLine,
  lookupFireworksPricing,
} from "../fireworks-pricing.mjs";
import { defineHarness } from "../harness-types.mjs";
import {
  claudePathsFor,
  ensureHomeForHarness,
  modelOverridesFrom,
} from "../harness-context.mjs";
import { HARNESS } from "../harness.mjs";
import { isHarnessEnabled, harnessModeFromConfig, readGlobalConfig, setHarnessEnabled } from "../global-config.mjs";
import { resolveHarnessOnAnthropicKey } from "../firerouter-core.mjs";

/**
 * Fireworks key from active Claude Code settings when Fireconnect is on.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function claudeResolveKey(ctx) {
  const { settingsPath } = claudePathsFor(ctx);
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  if (isFireworksKey(env.ANTHROPIC_API_KEY)) {
    return env.ANTHROPIC_API_KEY.trim();
  }
  if (isFireworksKey(env.ANTHROPIC_AUTH_TOKEN)) {
    return env.ANTHROPIC_AUTH_TOKEN.trim();
  }
  return "";
}

/**
 * Flag > env > settings (when on) > global config.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
function claudeApiKey(ctx) {
  return resolveFireworksApiKey({
    apiKey: ctx.apiKey,
    resolveKey: () => claudeResolveKey(ctx),
    home: ctx.home,
  });
}

/**
 * When Fireconnect is on, model commands use the active settings key.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 * @param {Record<string, string>} env
 */
async function claudeActiveApiKey(ctx, env) {
  if (isFireworksKey(env.ANTHROPIC_API_KEY)) {
    return env.ANTHROPIC_API_KEY.trim();
  }
  if (isFireworksKey(env.ANTHROPIC_AUTH_TOKEN)) {
    return env.ANTHROPIC_AUTH_TOKEN.trim();
  }
  return claudeApiKey(ctx);
}

export default defineHarness({
  id: HARNESS.CLAUDE,
  label: "Claude Code",
  resolveKey: claudeResolveKey,

  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const globalConfig = await readGlobalConfig(ctx.home);

    if (ctx.router) {
      const fireworksKey = await claudeApiKey(ctx);
      const settings = await readJsonIfExists(settingsPath);
      const settingsEnv = settings.env ?? {};
      const { anthropicKey, enterpriseAuth, source } = await resolveHarnessOnAnthropicKey({
        anthropicKey: ctx.anthropicKey,
        anthropicKeyFromFlag: ctx.anthropicKeyFromFlag,
        home: ctx.home,
        harness: HARNESS.CLAUDE,
        getExistingHarnessKey: async () => settingsEnv.ANTHROPIC_AUTH_TOKEN
          || settingsEnv.ANTHROPIC_API_KEY
          || "",
      });
      await enableFirerouterClaude({
        settingsPath,
        dataDir,
        baseUrl: ctx.baseUrl,
        fireworksKey,
        anthropicKey,
        home: ctx.home,
      });
      await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, true, { mode: "router" });
      console.log("FireRouter provider enabled for Claude Code.");
      console.log("Pick opus/sonnet/haiku in Claude Code; routing happens on the server.");
      if (enterpriseAuth) {
        console.log("Using existing Anthropic enterprise credentials (no separate API key written).");
      } else if (source === "prompt") {
        console.log("Anthropic API key saved to ~/.fireconnect/config.json.");
      }
      console.log("Restart Claude Code for full effect.");
      return;
    }

    const token = await claudeApiKey(ctx);
    const keyType = detectApiKeyType(token);
    await enableFireworksProvider({
      settingsPath,
      dataDir,
      apiKey: token,
      baseUrl: ctx.baseUrl || FIREWORKS_BASE_URL,
      mapping: resolveModelMapping(modelOverridesFrom(ctx), keyType),
      keyType,
      routerBaseUrl: globalConfig.routerBaseUrl,
    });
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, true, { mode: "direct" });
    console.log("Fireworks provider enabled.");
    printClaudeModelActivationHint();
    if (keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-latest for all aliases.");
    } else {
      console.log("Browse models: fireconnect claude model list");
      console.log("Pick a model:  fireconnect claude model select");
    }
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const wasEnabled = await isHarnessEnabled(ctx.home, HARNESS.CLAUDE);
    const globalConfig = await readGlobalConfig(ctx.home);
    const settings = await readJsonIfExists(settingsPath);
    const env = settings.env ?? {};
    const routerMode = harnessModeFromConfig(globalConfig, HARNESS.CLAUDE) === "router";
    if (routerMode) {
      await disableFirerouterClaude({
        settingsPath,
        dataDir,
        wasEnabled,
        routerBaseUrl: globalConfig.routerBaseUrl,
      });
    } else {
      await disableFireworksProvider({ settingsPath, dataDir, wasEnabled });
    }
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, false);
    const label = routerMode ? "FireRouter" : "Fireworks";
    console.log(`${label} provider disabled. Restart Claude Code for full effect.`);
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath } = claudePathsFor(ctx);
    const globalConfig = await readGlobalConfig(ctx.home);
    const settings = await readJsonIfExists(settingsPath);
    const env = settings.env ?? {};
    const routerOptions = { routerBaseUrl: globalConfig.routerBaseUrl };
    const routerMode = harnessModeFromConfig(globalConfig, HARNESS.CLAUDE) === "router";
    const token = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
    const keyType = detectApiKeyType(token);
    const payload = {
      harness: HARNESS.CLAUDE,
      provider: routerMode ? "firerouter" : providerStatusFromEnv(env, routerOptions),
      mode: routerMode ? "router" : "direct",
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      hasAuthToken: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
      keyType,
      defaults: defaultModelIds(keyType),
      current: mappingFromEnv(env),
      pricing: Object.fromEntries(
        Object.entries(mappingFromEnv(env))
          .filter(([, modelId]) => modelId)
          .map(([slot, modelId]) => [slot, attachPricing(modelId)]),
      ),
      pricingNote: CLAUDE_CODE_PRICING_DISCLAIMER,
    };

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Harness: ${HARNESS.CLAUDE}`);
    console.log(`Provider: ${payload.provider}`);
    if (payload.mode === "router") {
      console.log("Mode: FireRouter (server-side routing)");
    }
    console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
    console.log(`Auth token present: ${payload.hasAuthToken ? "yes" : "no"}`);
    if (keyType === "firepass") {
      console.log("Key type: Fire Pass (default: glm-latest)");
    }
    console.log("");

    if (keyType !== "firepass" && payload.mode !== "router") {
      console.log("Default mapping:");
      console.log(`  main     -> ${payload.defaults.main}`);
      console.log(`  opus     -> ${payload.defaults.opus}`);
      console.log(`  sonnet   -> ${payload.defaults.sonnet}`);
      console.log(`  haiku    -> ${payload.defaults.haiku}`);
      console.log(`  subagent -> ${payload.defaults.subagent}`);
      console.log("");
    }

    if (payload.mode === "router") {
      console.log("Current mapping: (server-side — use Claude Code /model)");
    } else {
      console.log("Current mapping:");
      for (const [slot, modelId] of Object.entries(payload.current)) {
        const label = modelId ?? "(unset)";
        const pricing = lookupFireworksPricing(modelId);
        const pricingText = pricing ? `  [${formatPricingLine(pricing)}]` : "";
        console.log(`  ${slot.padEnd(8)} -> ${label}${pricingText}`);
      }
    }

    if (payload.provider === "fireworks") {
      console.log("");
      console.log(payload.pricingNote);
    }
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
    const { settingsPath } = claudePathsFor(ctx);
    const globalConfig = await readGlobalConfig(ctx.home);
    const settings = await readJsonIfExists(settingsPath);
    const env = settings.env ?? {};
    if (harnessModeFromConfig(globalConfig, HARNESS.CLAUDE) === "router") {
      throw new Error("model reset does not apply in --router mode; pick models in Claude Code.");
    }
    const keyType = detectApiKeyType(await claudeActiveApiKey(ctx, env));
    await applyModelMapping({ settingsPath, mapping: resolveModelMapping({}, keyType) });
    console.log("Reset Claude Code model aliases to defaults.");
    printClaudeModelActivationHint();
  },

  async modelSelect(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath } = claudePathsFor(ctx);
    const globalConfig = await readGlobalConfig(ctx.home);
    const settings = await readJsonIfExists(settingsPath);
    const env = settings.env ?? {};
    if (harnessModeFromConfig(globalConfig, HARNESS.CLAUDE) === "router") {
      throw new Error("model select does not apply in --router mode; pick models in Claude Code.");
    }
    const apiKey = await claudeActiveApiKey(ctx, env);
    await runClaudeModelSelect({
      options: ctx,
      settingsPath,
      apiKey,
    });
  },
});
