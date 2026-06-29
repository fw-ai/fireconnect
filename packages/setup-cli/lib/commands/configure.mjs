import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import process from "node:process";
import { parseHarnessIdList } from "../harness.mjs";
import { readSecret } from "../read-secret.mjs";
import { listHarnesses } from "../harness-registry.mjs";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  MISSING_AZURE_BASE_URL_MESSAGE,
  normalizeAzureBaseUrl,
} from "../azure-core.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  readGlobalConfig,
  writeGlobalConfig,
  buildHarnessMapForConfigure,
} from "../global-config.mjs";
import { isAnthropicShapedKey } from "../firerouter-core.mjs";
/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runConfigureCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  let harnessIds = [];
  let apiKey = ctx.apiKey?.trim() ?? "";
  let apiKeyStored = "";
  let keyProvided = Boolean(apiKey);
  let anthropicApiKey = ctx.anthropicKey?.trim() ?? "";
  let anthropicApiKeyStored = "";
  let anthropicKeyProvided = ctx.anthropicKeyFromFlag && Boolean(anthropicApiKey);
  let existingConfig = null;
  const provider = ctx.provider?.trim() ?? "";

  if (ctx.harnesses) {
    harnessIds = parseHarnessIdList(ctx.harnesses);
  }

  if (!ctx.harnesses && input.isTTY && output.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      const adapters = listHarnesses();
      console.log("Which harnesses do you use? (comma-separated numbers, e.g. 1,2)");
      adapters.forEach((adapter, index) => {
        console.log(`  ${index + 1}) ${adapter.id} — ${adapter.label}`);
      });
      const harnessAnswer = (await rl.question("\nHarnesses: ")).trim();
      const indices = harnessAnswer.split(",").map((part) => Number.parseInt(part.trim(), 10));
      harnessIds = indices
        .filter((index) => Number.isInteger(index) && index >= 1 && index <= adapters.length)
        .map((index) => adapters[index - 1].id);

      if (harnessIds.length === 0) {
        throw new Error("Select at least one harness");
      }
    } finally {
      rl.close();
    }

    if (!apiKey) {
      apiKey = await readSecret("Fireworks API key (or Enter to skip): ", { allowEmpty: true });
      keyProvided = Boolean(apiKey);
    }
  } else if (harnessIds.length === 0) {
    const valid = listHarnesses().map((a) => a.id).join(",");
    throw new Error(`Pass --harnesses ${valid} or run configure in an interactive terminal`);
  }

  if (provider && provider !== "azure" && provider !== "fireworks") {
    throw new Error("--provider must be one of: fireworks, azure");
  }

  if (provider === "azure") {
    keyProvided = false;
  }

  if (keyProvided) {
    apiKeyStored = apiKey;
  } else {
    existingConfig = await readGlobalConfig(home);
    apiKeyStored = existingConfig.apiKey;
  }

  if (anthropicKeyProvided) {
    if (!isAnthropicShapedKey(anthropicApiKey)) {
      throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
    }
    anthropicApiKeyStored = anthropicApiKey;
  } else {
    if (!existingConfig) {
      existingConfig = await readGlobalConfig(home);
    }
    anthropicApiKeyStored = existingConfig.anthropicApiKey;
  }

  if (!existingConfig) {
    existingConfig = await readGlobalConfig(home);
  }

  let providerStored = existingConfig.provider;
  let azureStored = existingConfig.azure;
  if (provider === "azure") {
    const baseUrl = normalizeAzureBaseUrl(ctx.baseUrlFromFlag ? ctx.baseUrl : existingConfig.azure.baseUrl);
    if (!baseUrl) {
      throw new Error(MISSING_AZURE_BASE_URL_MESSAGE);
    }
    let azureApiKey = ctx.apiKeyFromFlag ? ctx.apiKey.trim() : existingConfig.azure.apiKey;
    if (!azureApiKey && process.env[AZURE_API_KEY_ENV]?.trim()) {
      azureApiKey = AZURE_API_KEY_ENV_REF;
    }
    providerStored = "azure";
    azureStored = { baseUrl, apiKey: azureApiKey };
  } else if (provider === "fireworks") {
    providerStored = "fireworks";
  }

  await writeGlobalConfig(home, {
    apiKey: apiKeyStored,
    anthropicApiKey: anthropicApiKeyStored,
    provider: providerStored,
    azure: azureStored,
    harnesses: buildHarnessMapForConfigure(harnessIds, existingConfig.harnesses),
  });

  console.log("Saved FireConnect config to ~/.fireconnect/config.json");
  console.log(`Harnesses: ${harnessIds.join(", ")}`);
  if (keyProvided) {
    console.log("Stored Fireworks API key in global config.");
  } else if (!apiKeyStored) {
    console.log("No API key in config — export FIREWORKS_API_KEY or pass --api-key to `fireconnect <harness> on`.");
  } else if (apiKeyStored === FIREWORKS_API_KEY_ENV_REF) {
    console.log("Kept existing env-referenced API key ({env:FIREWORKS_API_KEY}).");
  } else {
    console.log("Kept existing API key in global config.");
  }
  if (anthropicKeyProvided) {
    console.log("Stored Anthropic API key in global config.");
  } else if (anthropicApiKeyStored) {
    console.log("Kept existing Anthropic API key in global config.");
  }
  if (providerStored === "azure") {
    console.log("Configured Fireworks on Microsoft Foundry provider.");
  }
  console.log("");
  console.log("Enable a harness with: fireconnect <harness> on");
}
