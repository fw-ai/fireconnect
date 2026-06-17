import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import process from "node:process";
import { parseHarnessIdList } from "../harness.mjs";
import { listHarnesses } from "../harness-registry.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  readGlobalConfig,
  writeGlobalConfig,
  buildHarnessMapForConfigure,
} from "../global-config.mjs";
/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runConfigureCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  let harnessIds = [];
  let apiKey = ctx.apiKey;
  let apiKeyStored = FIREWORKS_API_KEY_ENV_REF;
  let keyStorageChosen = false;
  let existingConfig = null;

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

      if (!apiKey && process.env.FIREWORKS_API_KEY) {
        apiKey = process.env.FIREWORKS_API_KEY;
      }
      if (!apiKey) {
        const keyAnswer = (await rl.question("Fireworks API key (or Enter to skip): ")).trim();
        apiKey = keyAnswer;
      }

      if (apiKey) {
        const modeAnswer = (await rl.question("Store API key as env reference? [Y/n] ")).trim().toLowerCase();
        apiKeyStored = modeAnswer === "n" || modeAnswer === "no" ? apiKey : FIREWORKS_API_KEY_ENV_REF;
        keyStorageChosen = true;
      }
    } finally {
      rl.close();
    }
  } else if (harnessIds.length === 0) {
    throw new Error("Pass --harnesses claude,opencode or run configure in an interactive terminal");
  }

  if (apiKey) {
    if (ctx.apiKeyMode === "literal") {
      apiKeyStored = apiKey;
    } else if (ctx.apiKeyMode === "env") {
      apiKeyStored = FIREWORKS_API_KEY_ENV_REF;
    } else if (
      !keyStorageChosen
      && apiKeyStored === FIREWORKS_API_KEY_ENV_REF
      && apiKey !== process.env.FIREWORKS_API_KEY
    ) {
      apiKeyStored = apiKey;
    } else if (!keyStorageChosen && !ctx.apiKeyMode && apiKey !== FIREWORKS_API_KEY_ENV_REF) {
      apiKeyStored = apiKeyFromFlagOrLiteral(ctx, apiKey);
    }
  } else {
    existingConfig = await readGlobalConfig(home);
    apiKeyStored = existingConfig.apiKey;
  }

  if (!existingConfig) {
    existingConfig = await readGlobalConfig(home);
  }

  await writeGlobalConfig(home, {
    apiKey: apiKeyStored,
    harnesses: buildHarnessMapForConfigure(harnessIds, existingConfig.harnesses),
  });

  console.log("FireConnect configuration saved to ~/.fireconnect/config.json");
  console.log(`Registered harnesses: ${harnessIds.join(", ")}`);
  if (apiKeyStored === FIREWORKS_API_KEY_ENV_REF) {
    console.log("API key: {env:FIREWORKS_API_KEY}");
  } else if (apiKeyStored) {
    console.log("API key: stored in config (literal)");
  }
  console.log("");
  console.log("Enable a harness with: fireconnect <harness> on");
}

function apiKeyFromFlagOrLiteral(ctx, apiKey) {
  if (ctx.apiKeyFromFlag) {
    return apiKey;
  }
  if (apiKey === process.env.FIREWORKS_API_KEY) {
    return FIREWORKS_API_KEY_ENV_REF;
  }
  return apiKey;
}
