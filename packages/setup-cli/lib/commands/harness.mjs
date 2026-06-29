import process from "node:process";
import { dispatchHarnessCommand } from "../harness-types.mjs";
import { getHarness } from "../harness-registry.mjs";
import { persistGlobalApiKey, persistGlobalAnthropicApiKey } from "../global-config.mjs";
import { isAnthropicShapedKey } from "../firerouter-core.mjs";

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
function persistAnthropicKeyFromFlag(ctx, home) {
  if (!ctx.anthropicKeyFromFlag || !ctx.anthropicKey?.trim()) {
    return;
  }
  if (!isAnthropicShapedKey(ctx.anthropicKey)) {
    throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
  }
  return persistGlobalAnthropicApiKey(home, ctx.anthropicKey);
}

/**
 * @param {{ harnessId: string, verb: string, noun?: string }} route
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runHarnessCommand(route, ctx) {
  const home = ctx.home || process.env.HOME || "";
  if (route.verb === "on" && home) {
    const azureMode = ctx.azure === true || ctx.provider === "azure";
    if (!azureMode && ctx.apiKeyFromFlag && ctx.apiKey?.trim()) {
      await persistGlobalApiKey(home, ctx.apiKey);
    }
    await persistAnthropicKeyFromFlag(ctx, home);
  }

  const adapter = getHarness(route.harnessId);
  await dispatchHarnessCommand(adapter, route, ctx);
}
