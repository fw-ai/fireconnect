import process from "node:process";
import { dispatchHarnessCommand } from "../../harness/types.mjs";
import { getHarness } from "../../harness/registry.mjs";
import { persistGlobalAnthropicApiKey } from "../../config/global-config.mjs";
import { FILE_CONFIG_HARNESS_SET, HARNESS } from "../../harness/id.mjs";
import { isFirerouterModel } from "../../fireworks/model-id.mjs";
import { isAnthropicShapedKey } from "../../firerouter/core.mjs";
import { supportsAnthropicApiKeyFlag, supportsRoutingPreference } from "../../firerouter/flag.mjs";
import {
  assertFireworksKeyUsable,
  assertFireworksKeyShape,
  assertNoFireworksEnvForStorage,
  canPersistApiKeyToKeychain,
  persistApiKeyFromFlag,
  persistApiKeyToKeychain,
} from "../../keys/api-key.mjs";

const IDE_HARNESSES = new Set([HARNESS.CURSOR, HARNESS.VSCODE]);

/**
 * Fail on parsed flags the selected harness/command cannot use. The parser is
 * intentionally shared, but silently ignoring a valid-looking option is worse
 * than an immediate command-specific recovery message.
 * @param {{ harnessId: string, verb: string, noun?: string }} route
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
function validateHarnessOptions(route, ctx) {
  const { harnessId, verb, noun = "" } = route;
  const isOn = verb === "on" && !noun;
  const onboardingMode = ctx.onboardingMode ?? "auto";
  const claudeAliases = [ctx.opus, ctx.sonnet, ctx.haiku, ctx.fable, ctx.subagent];
  const claudeModels = [ctx.main, ...claudeAliases];
  const firerouterRequested = harnessId === HARNESS.CLAUDE
    ? claudeModels.some((modelId) => isFirerouterModel(modelId))
    : isFirerouterModel(ctx.main);

  if (ctx.provider && !ctx.azure) {
    throw new Error(
      "--provider is configure-only. For a one-off harness switch, use --azure; "
        + "to change the default, run: fireconnect configure --provider <fireworks|azure>",
    );
  }
  if (ctx.azure && harnessId === HARNESS.CLAUDE) {
    throw new Error("Claude does not support Azure mode; omit --azure to use the Fireworks gateway.");
  }
  if (ctx.baseUrlFromFlag && harnessId !== HARNESS.CLAUDE && !ctx.azure) {
    throw new Error("--base-url on this harness requires --azure.");
  }
  if (ctx.force && !IDE_HARNESSES.has(harnessId)) {
    throw new Error("--force is only supported for Cursor and VS Code.");
  }
  if (onboardingMode !== "auto" && !(harnessId === HARNESS.CLAUDE && isOn)) {
    const flag = onboardingMode === "prompt" ? "--interactive" : "--non-interactive";
    throw new Error(`${flag} applies only to \`fireconnect claude on\`.`);
  }
  if (claudeAliases.some(Boolean) && !(harnessId === HARNESS.CLAUDE && isOn)) {
    throw new Error("--opus/--sonnet/--haiku/--fable/--subagent apply only to `fireconnect claude on`.");
  }
  if (ctx.main && !isOn) {
    throw new Error("--model applies only to `<harness> on`.");
  }
  if (ctx.search) {
    throw new Error("--search applies only to `fireconnect model list`.");
  }
  // `--session` is shared by `claude usage` (report) and `claude live` (resume +
  // meter that session in the split); the report-only flags stay usage-only.
  const sessionAllowed = harnessId === HARNESS.CLAUDE && !noun
    && (verb === "usage" || verb === "live");
  if (ctx.session && !sessionAllowed) {
    throw new Error("--session applies only to `fireconnect claude usage` or `fireconnect claude live`.");
  }
  const hasUsageOption = Boolean(ctx.days || ctx.lastN || ctx.verbose || ctx.plain);
  if (hasUsageOption && !(harnessId === HARNESS.CLAUDE && verb === "usage" && !noun)) {
    throw new Error("--days/--last-n/--verbose/--plain apply only to `fireconnect claude usage`.");
  }
  if (verb === "live" && harnessId !== HARNESS.CLAUDE) {
    throw new Error("`fireconnect <harness> live` is supported only for Claude Code.");
  }
  const jsonSupported = verb === "status"
    || verb === "usage";
  if (ctx.json && !jsonSupported) {
    throw new Error("--json is supported by status and Claude usage.");
  }

  if (ctx.settingsPath && harnessId !== HARNESS.CLAUDE && harnessId !== HARNESS.PI) {
    throw new Error("--settings-path is supported only by Claude and Pi.");
  }
  if (ctx.configPath && !FILE_CONFIG_HARNESS_SET.has(harnessId)) {
    throw new Error("--config-path is supported only by OpenCode, Codex, Pi, and DeepSeek Harness.");
  }
  if (ctx.dbPath && harnessId !== HARNESS.CURSOR) {
    throw new Error("--db-path is supported only by Cursor.");
  }
  if (ctx.vscodePath && harnessId !== HARNESS.VSCODE) {
    throw new Error("--vscode-path is supported only by VS Code.");
  }
  if (ctx.anthropic || ctx.storedOnly || ctx.withToken || ctx.revoke || ctx.paste || ctx.account) {
    throw new Error("This option belongs to a global login/logout/key command, not a harness command.");
  }

  if (ctx.routingPreference !== null) {
    if (!isOn || (harnessId !== HARNESS.CLAUDE && !firerouterRequested)) {
      throw new Error(
        harnessId === HARNESS.CLAUDE
          ? "--routing-preference requires a Claude slot set to firerouter."
          : "--routing-preference requires `<harness> on --model firerouter`.",
      );
    }
    if (!supportsRoutingPreference(getHarness(harnessId).firerouter)) {
      throw new Error("--routing-preference is not supported by this harness.");
    }
  }
  if (ctx.anthropicKeyFromFlag) {
    const validClaudeOn = harnessId === HARNESS.CLAUDE && isOn;
    if (!validClaudeOn && (!isOn || !firerouterRequested)) {
      throw new Error(
        harnessId === HARNESS.CLAUDE
          ? "--anthropic-api-key applies only to `fireconnect claude on`."
          : "--anthropic-api-key requires `<harness> on --model firerouter`.",
      );
    }
    if (!supportsAnthropicApiKeyFlag(getHarness(harnessId).firerouter)) {
      throw new Error("--anthropic-api-key is not supported by this harness.");
    }
  }
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
function persistAnthropicKeyFromFlag(ctx, home, harnessId) {
  if (!ctx.anthropicKeyFromFlag || !ctx.anthropicKey?.trim()) {
    return;
  }
  if (!isAnthropicShapedKey(ctx.anthropicKey)) {
    throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
  }
  return persistGlobalAnthropicApiKey(home, ctx.anthropicKey);
}

export async function finalizeClaudeOnOutcome(
  outcome,
  {
    persistFireworksKey,
    persistAnthropicKey,
  } = {},
) {
  if (outcome?.cancelled) {
    process.exitCode = 1;
    return false;
  }
  await persistFireworksKey?.();
  await persistAnthropicKey?.();
  return true;
}

/**
 * @param {{ harnessId: string, verb: string, noun?: string }} route
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runHarnessCommand(route, ctx) {
  const adapter = getHarness(route.harnessId);
  const validationCtx = route.verb === "on" && !route.noun && adapter.resolveOnContext
    ? await adapter.resolveOnContext(ctx)
    : ctx;
  try {
    validateHarnessOptions(route, validationCtx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.includes("Run: fireconnect")
        ? message
        : `${message} Run: fireconnect ${route.harnessId} help`,
    );
  }
  const home = ctx.home || process.env.HOME || "";
  let deferredClaudeApiKey = "";
  if (route.verb === "on" && home) {
    const azureMode = ctx.azure === true || ctx.provider === "azure";
    if (!azureMode && ctx.apiKeyFromFlag && ctx.apiKey?.trim()) {
      assertNoFireworksEnvForStorage();
      // Validate `--api-key` the same way `login` does — shape check then strict
      // verify — BEFORE persisting or enabling anything, so a typo or dead key
      // fails fast with a clear message instead of being baked into a harness
      // config and surfacing as a 401 in-tool later. Throws on failure.
      await assertFireworksKeyUsable(ctx.apiKey.trim());
      // Through the keychain path so baked-key sync runs in exactly one
      // place (inside persistApiKeyToKeychain). Adapters that persist the
      // flag again (claude direct, cursor) hit the idempotent no-op path —
      // no duplicate stores, no duplicate notes.
      if (route.harnessId === HARNESS.CLAUDE) {
        deferredClaudeApiKey = ctx.apiKey;
      } else {
        await persistApiKeyFromFlag(home, ctx.apiKey);
      }
    } else if (!azureMode && process.env.FIREWORKS_API_KEY?.trim()) {
      const envKey = assertFireworksKeyShape(process.env.FIREWORKS_API_KEY);
      if (FILE_CONFIG_HARNESS_SET.has(route.harnessId) && await canPersistApiKeyToKeychain(home)) {
        await persistApiKeyToKeychain(home, envKey);
      }
    }
    if (route.harnessId !== HARNESS.CLAUDE) {
      await persistAnthropicKeyFromFlag(ctx, home, route.harnessId);
    }
  }

  const outcome = await dispatchHarnessCommand(adapter, route, ctx);
  if (
    route.verb === "on"
    && route.harnessId === HARNESS.CLAUDE
    && home
  ) {
    await finalizeClaudeOnOutcome(outcome, {
      persistFireworksKey: deferredClaudeApiKey
        ? () => persistApiKeyFromFlag(home, deferredClaudeApiKey)
        : undefined,
      persistAnthropicKey: () => persistAnthropicKeyFromFlag(ctx, home, route.harnessId),
    });
  }
}
