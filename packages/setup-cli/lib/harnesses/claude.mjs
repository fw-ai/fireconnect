import {
  FIREWORKS_BASE_URL,
  applyModelMapping,
  defaultModelIds,
  detectApiKeyType,
  disableFireworksProvider,
  enableFireworksProvider,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
  mappingFromEnv,
  providerStatePath,
  providerStatusFromEnv,
  readJsonIfExists,
  resolveModelMapping,
  writeJson,
} from "../fireconnect-core.mjs";
import {
  disableFirerouterClaude,
  enableFirerouterClaude,
  firerouterStatusFromEnv,
} from "../claude-firerouter.mjs";
import { isFireworksKey, resolveFireworksApiKey } from "../fireworks-models.mjs";
import { fireconnectKeyExportCommand, fireconnectDesktopGuardCommand } from "../cli-path.mjs";
import { withDesktopGuardHook, withoutDesktopGuardHook } from "../claude-desktop-guard.mjs";
import { runModelListCommand } from "../model-list.mjs";
import { runClaudeModelSelect } from "../model-select.mjs";
import {
  formatClaudeUsageReport,
  formatClaudeUsageReports,
  readClaudeUsage,
  readClaudeUsages,
} from "../claude-usage.mjs";
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
import { persistApiKeyFromFlag } from "../api-key.mjs";
import { detectSecretBackend } from "../secret-store.mjs";
import { assertBackendCanStore, keyStorageSummaryLine } from "../key-storage-report.mjs";

/**
 * Fireworks key from active Claude Code settings when Fireconnect is on.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function claudeResolveKey(ctx) {
  const { settingsPath, dataDir } = claudePathsFor(ctx);
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  if (settings.apiKeyHelper || state.authMode === "apiKeyHelper") {
    return "";
  }
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
 * Flag > env > settings (when on) > global config.
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
async function claudeApiKey(ctx) {
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

/**
 * Tear down the *other* provider mode before enabling a new one, so the
 * managed apiKeyHelper and stale env are restored from that mode's backup
 * and the new enable runs on a clean slate. No-op unless the current mode
 * is the opposite of `toMode`. Callers must have already validated the new
 * mode's prerequisites (anthropic/fireworks key) BEFORE calling this, so a
 * missing key throws without half-disabling the active mode.
 *
 * The current mode is read from global config, with a fallback to the env in
 * settings.json: a legacy/partial config can have Claude enabled with
 * Fireworks/FireRouter settings but no `mode` field, in which case
 * harnessModeFromConfig returns "". Inferring from the env keeps the pre-off
 * teardown working for those configs (restoring backups, stripping the
 * managed apiKeyHelper) instead of skipping it and leaving stale state.
 * @param {{ settingsPath: string, dataDir: string, home: string, routerBaseUrl?: string }} opts
 * @param {"router" | "direct"} toMode
 * @param {{ harnesses?: Record<string, { mode?: string }> }} globalConfig
 */
async function teardownOtherMode({ settingsPath, dataDir, home, routerBaseUrl = "" }, toMode, globalConfig) {
  let current = harnessModeFromConfig(globalConfig, HARNESS.CLAUDE);
  if (!current) {
    // Legacy/partial config (enabled with no mode field) — infer from the env.
    const settings = await readJsonIfExists(settingsPath);
    const env = settings.env ?? {};
    if (firerouterStatusFromEnv(env, { routerBaseUrl }) === "firerouter") {
      current = "router";
    } else if (providerStatusFromEnv(env, { routerBaseUrl }) === "fireworks") {
      current = "direct";
    }
  }
  if (current === toMode || current !== (toMode === "router" ? "direct" : "router")) {
    return;
  }
  if (toMode === "router") {
    await disableFireworksProvider({ settingsPath, dataDir, wasEnabled: true });
  } else {
    await disableFirerouterClaude({ settingsPath, dataDir, wasEnabled: true, routerBaseUrl, home });
  }
}

async function installDesktopGuardHook(settingsPath) {
  const settings = await readJsonIfExists(settingsPath);
  await writeJson(settingsPath, withDesktopGuardHook(settings, fireconnectDesktopGuardCommand()));
}

async function removeDesktopGuardHook(settingsPath) {
  const settings = await readJsonIfExists(settingsPath);
  const next = withoutDesktopGuardHook(settings);
  if (next !== settings) {
    await writeJson(settingsPath, next);
  }
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
      if (!fireworksKey?.trim()) {
        throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
      }
      const settings = await readJsonIfExists(settingsPath);
      const settingsEnv = settings.env ?? {};
      // Resolve router prerequisites (Anthropic key / OAuth) BEFORE tearing
      // down direct mode — if resolution throws, direct mode is left intact
      // instead of half-disabled with no backup to recover from.
      const { anthropicKey, enterpriseAuth, source } = await resolveHarnessOnAnthropicKey({
        anthropicKey: ctx.anthropicKey,
        anthropicKeyFromFlag: ctx.anthropicKeyFromFlag,
        home: ctx.home,
        harness: HARNESS.CLAUDE,
        getExistingHarnessKey: async () => settingsEnv.ANTHROPIC_AUTH_TOKEN
          || settingsEnv.ANTHROPIC_API_KEY
          || "",
      });
      // Prerequisites resolved — safe to tear down direct mode so the managed
      // apiKeyHelper is stripped and the user's pre-fireconnect settings are
      // restored from the direct backup. Router-enable then runs on a clean
      // slate and only has to manage the user's own helper.
      await teardownOtherMode({ settingsPath, dataDir, home: ctx.home }, "router", globalConfig);
      await enableFirerouterClaude({
        settingsPath,
        dataDir,
        baseUrl: ctx.baseUrl,
        fireworksKey,
        anthropicKey,
        home: ctx.home,
      });
      await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, true, { mode: "router" });
      await installDesktopGuardHook(settingsPath);
      console.log("FireRouter provider enabled for Claude Code.");
      console.log("Pick opus/sonnet/haiku in Claude Code; routing happens on the server.");
      console.warn(
        "Note: FireRouter mode writes your Fireworks API key in plaintext to ~/.claude/settings.json "
          + "(in ANTHROPIC_CUSTOM_HEADERS), because Claude Code sends it as a static header. "
          + "Prefer `fireconnect claude on` (direct mode) to keep the key in the OS keychain via apiKeyHelper.",
      );
      if (enterpriseAuth) {
        console.log("Using existing Anthropic enterprise credentials (no separate API key written).");
      } else if (source === "prompt") {
        console.log("Anthropic API key saved to ~/.fireconnect/config.json.");
      }
      console.log("Restart Claude Code for full effect.");
      return;
    }

    const flagKey = ctx.apiKey?.trim() ?? "";
    const harnessLocalKey = flagKey ? "" : (await claudeResolveKey(ctx));
    const keyToStore = flagKey || harnessLocalKey;
    if (keyToStore) {
      const backend = await detectSecretBackend(ctx.home);
      await assertBackendCanStore(backend, ctx.home);
      await persistApiKeyFromFlag(ctx.home, keyToStore, { backend });
      const { message } = await keyStorageSummaryLine(ctx.home);
      console.log(message);
    }
    const token = await claudeApiKey(ctx);
    if (!token?.trim()) {
      // Validate BEFORE tearing down router mode so a missing key doesn't
      // leave a half-disabled state with the firerouter backup gone.
      throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
    }
    const keyType = detectApiKeyType(token);
    const apiKeyHelperPath = `${fireconnectKeyExportCommand(ctx.home)}`;
    // Prerequisites resolved — safe to tear down router mode so the user's
    // pre-fireconnect settings (incl. their own apiKeyHelper, which router
    // mode kept) are restored before direct-enable runs. Symmetric to the
    // router-on path running direct-off.
    await teardownOtherMode(
      { settingsPath, dataDir, home: ctx.home, routerBaseUrl: globalConfig.routerBaseUrl },
      "direct",
      globalConfig,
    );
    await enableFireworksProvider({
      settingsPath,
      dataDir,
      effectiveApiKey: token,
      apiKeyHelperPath,
      baseUrl: ctx.baseUrl || FIREWORKS_BASE_URL,
      mapping: resolveModelMapping(modelOverridesFrom(ctx), keyType),
      keyType,
      routerBaseUrl: globalConfig.routerBaseUrl,
    });
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, true, { mode: "direct" });
    await installDesktopGuardHook(settingsPath);
    console.log("Fireworks provider enabled.");
    printClaudeModelActivationHint();
    if (keyType === "firepass") {
      console.log("Fire Pass key detected: using glm-fast-latest for all aliases.");
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
        home: ctx.home,
      });
    } else {
      await disableFireworksProvider({ settingsPath, dataDir, wasEnabled });
    }
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, false);
    await removeDesktopGuardHook(settingsPath);
    const label = routerMode ? "FireRouter" : "Fireworks";
    console.log(`${label} provider disabled. Restart Claude Code for full effect.`);
    console.log(
      "If you have Claude Code sessions already running (including inside Claude Desktop), "
        + "fully quit and restart them — env vars are captured at process start and this change "
        + "will not reach them otherwise.",
    );
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const globalConfig = await readGlobalConfig(ctx.home);
    const settings = await readJsonIfExists(settingsPath);
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const env = settings.env ?? {};
    const routerOptions = { routerBaseUrl: globalConfig.routerBaseUrl };
    const routerMode = harnessModeFromConfig(globalConfig, HARNESS.CLAUDE) === "router";
    const usesHelper = Boolean(settings.apiKeyHelper) || state.authMode === "apiKeyHelper";
    const token = usesHelper
      ? ""
      : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey || "";
    const keyType = token ? detectApiKeyType(token) : "fireworks";
    const payload = {
      harness: HARNESS.CLAUDE,
      provider: routerMode ? "firerouter" : providerStatusFromEnv(env, routerOptions),
      mode: routerMode ? "router" : "direct",
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      hasAuthToken: usesHelper || Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
      authMode: usesHelper ? "apiKeyHelper" : "env",
      defaults: defaultModelIds(keyType),
      current: mappingFromEnv(env),
      pricing: Object.fromEntries(
        Object.entries(mappingFromEnv(env))
          .filter(([, modelId]) => modelId)
          .map(([slot, modelId]) => [slot, attachPricing(modelId)]),
      ),
      pricingNote: CLAUDE_CODE_PRICING_DISCLAIMER,
    };
    payload.keyType = keyType;

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
    if (usesHelper) {
      const backend = await detectSecretBackend(ctx.home);
      const where = backend.backend === "file"
        ? `file-backed at ${backend.location ?? "encrypted file"}`
        : backend.backend === "keychain"
          ? `keychain-backed (${backend.label})`
          : "secret-store-backed";
      console.log(`Auth mode: apiKeyHelper (${where})`);
    }
    if (keyType === "firepass") {
      console.log("Key type: Fire Pass (default: glm-fast-latest)");
    }
    console.log("");

    if (keyType !== "firepass" && payload.mode !== "router") {
      console.log("Default mapping:");
      console.log(`  main     -> ${payload.defaults.main}`);
      console.log(`  opus     -> ${payload.defaults.opus}`);
      console.log(`  sonnet   -> ${payload.defaults.sonnet}`);
      console.log(`  haiku    -> ${payload.defaults.haiku}`);
      console.log(`  fable    -> ${payload.defaults.fable}`);
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

  async usage(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    if (ctx.lastN) {
      const reportGroup = await readClaudeUsages({ home: ctx.home, session: ctx.session ?? "", lastN: ctx.lastN });
      if (ctx.json) {
        console.log(JSON.stringify(reportGroup, null, 2));
        return;
      }
      console.log(formatClaudeUsageReports(reportGroup, { verbose: ctx.verbose }));
      return;
    }

    const report = await readClaudeUsage({ home: ctx.home, session: ctx.session ?? "" });
    if (ctx.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatClaudeUsageReport(report, { verbose: ctx.verbose }));
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
    const globalConfig = await readGlobalConfig(ctx.home);
    const settings = await readJsonIfExists(settingsPath);
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const env = settings.env ?? {};
    if (harnessModeFromConfig(globalConfig, HARNESS.CLAUDE) === "router") {
      throw new Error("model reset does not apply in --router mode; pick models in Claude Code.");
    }
    const usesHelper = Boolean(settings.apiKeyHelper) || state.authMode === "apiKeyHelper";
    const token = usesHelper
      ? (await claudeApiKey(ctx))
      : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey || "";
    const keyType = detectApiKeyType(token || "fw_placeholder");
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
