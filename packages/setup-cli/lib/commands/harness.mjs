import process, { stdin } from "node:process";
import { dispatchHarnessCommand } from "../harness-types.mjs";
import { getHarness } from "../harness-registry.mjs";
import { persistGlobalApiKey, persistGlobalAnthropicApiKey } from "../global-config.mjs";
import { isAnthropicShapedKey } from "../firerouter-core.mjs";
import { runInteractiveSignIn } from "./login.mjs";

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
  try {
    await dispatchHarnessCommand(adapter, route, ctx);
    printRevertHint(route);
  } catch (error) {
    if (!shouldOfferSignIn(route, ctx, error)) {
      throw error;
    }
    // First contact often isn't `fireconnect login` — it's `fireconnect
    // claude on` on a fresh machine. Run the sign-in here and finish what
    // was asked, instead of bouncing the user to a different command.
    const signedIn = await runInteractiveSignIn(home, {
      nextHint: false, // this command *is* the next step
    });
    if (!signedIn) {
      // The sign-in flow printed its own failure/recovery line.
      console.error(`${route.harnessId} was not changed. Once you're signed in, run  fireconnect ${route.harnessId} ${route.verb}`);
      process.exitCode = 1;
      return;
    }
    console.log("");
    await dispatchHarnessCommand(adapter, route, ctx);
    printRevertHint(route);
  }
}

/**
 * Reversibility that isn't announced doesn't reassure: `on` backs up what it
 * changes and `off` restores it, so say so at the moment of change.
 * @param {{ harnessId: string, verb: string }} route
 */
function printRevertHint(route) {
  if (route.verb === "on") {
    console.log(`Revert anytime with  fireconnect ${route.harnessId} off  — your previous settings were backed up.`);
  }
}

/**
 * The no-credentials on-ramp fires only where an interactive sign-in is both
 * possible (TTY) and what the error means (`on` failed for lack of a key —
 * both key-resolution messages share this prefix). Explicit --api-key and
 * Azure mode are the user answering the key question a different way.
 * @param {{ harnessId: string, verb: string }} route
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 * @param {unknown} error
 */
function shouldOfferSignIn(route, ctx, error) {
  return route.verb === "on"
    && stdin.isTTY
    && !ctx.apiKeyFromFlag
    && ctx.azure !== true
    && ctx.provider !== "azure"
    && /^No Fireworks API key found/.test(/** @type {Error} */ (error)?.message ?? "");
}
