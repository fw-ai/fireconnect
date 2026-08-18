import process from "node:process";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  MISSING_AZURE_BASE_URL_MESSAGE,
  assertAzureApiKey,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import { isAnthropicShapedKey } from "../../firerouter/core.mjs";
import { accent } from "../../ui.mjs";
import { printNote, printSuccess } from "../messages.mjs";
/**
 * `fireconnect configure` sets the non-Fireworks-key globals: the provider
 * (Fireworks vs a Microsoft Azure AI Foundry endpoint) and the Anthropic key
 * for FireRouter mode.
 *
 * It does NOT set the Fireworks API key (use `fireconnect login`) and does NOT
 * register harnesses (enable one with `fireconnect <harness>`). In this
 * command `--api-key` is the *Azure* endpoint key and is only accepted with
 * `--provider azure`.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runConfigureCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  const provider = ctx.provider?.trim() ?? "";
  if (provider && provider !== "azure" && provider !== "fireworks") {
    throw new Error("--provider must be one of: fireworks, azure");
  }

  // `--api-key` here is the Azure endpoint key, not the Fireworks key.
  if (ctx.apiKeyFromFlag && provider !== "azure") {
    throw new Error(
      "configure doesn't set the Fireworks API key — run `fireconnect login` "
        + "(or `fireconnect login --with-token` for CI). In configure, --api-key is the "
        + "Azure endpoint key and requires --provider azure.",
    );
  }

  const anthropicKeyProvided = ctx.anthropicKeyFromFlag && Boolean(ctx.anthropicKey?.trim());

  if (!provider && !anthropicKeyProvided) {
    printNote("Nothing to configure.");
    console.log(`  Sign in / set your key:  ${accent("fireconnect login")}`);
    console.log(`  Choose a provider:       ${accent("fireconnect configure --provider azure --base-url <url> --api-key <azure-key>")}`);
    console.log(`  Set the Anthropic key:   ${accent("fireconnect configure --anthropic-api-key sk-ant-…")}`);
    console.log(`  Enable a harness:        ${accent("fireconnect <harness>")}`);
    return;
  }

  const existingConfig = await readGlobalConfig(home);

  // writeGlobalConfig merges — only pass what this run changes; apiKey and the
  // harness map are left untouched (login / `<harness> on` own those).
  /** @type {Parameters<typeof writeGlobalConfig>[1]} */
  const update = {};

  if (anthropicKeyProvided) {
    const anthropicApiKey = ctx.anthropicKey.trim();
    if (!isAnthropicShapedKey(anthropicApiKey)) {
      throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
    }
    update.anthropicApiKey = anthropicApiKey;
  }

  if (provider === "azure") {
    const baseUrl = normalizeAzureBaseUrl(ctx.baseUrlFromFlag ? ctx.baseUrl : existingConfig.azure.baseUrl);
    if (!baseUrl) {
      throw new Error(MISSING_AZURE_BASE_URL_MESSAGE);
    }
    let azureApiKey = ctx.apiKeyFromFlag ? ctx.apiKey.trim() : existingConfig.azure.apiKey;
    if (!azureApiKey && process.env[AZURE_API_KEY_ENV]?.trim()) {
      azureApiKey = AZURE_API_KEY_ENV_REF;
    }
    assertAzureApiKey(azureApiKey);
    update.provider = "azure";
    update.azure = { baseUrl, apiKey: azureApiKey };
  } else if (provider === "fireworks") {
    update.provider = "fireworks";
  }

  await writeGlobalConfig(home, update);

  printSuccess("Saved to ~/.fireconnect/config.json");
  if (update.anthropicApiKey) {
    printNote("Stored Anthropic API key in global config.");
  }
  if (update.provider === "azure") {
    printSuccess("Configured Fireworks on Microsoft Foundry provider.");
  } else if (update.provider === "fireworks") {
    printNote("Set provider to Fireworks (default).");
  }
}
