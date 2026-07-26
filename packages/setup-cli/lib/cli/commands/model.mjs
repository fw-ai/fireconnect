import process from "node:process";

import { runModelListCommand } from "../../fireworks/model-list.mjs";
import { resolveFireworksApiKeyValue } from "../../keys/api-key.mjs";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../../keys/key-type.mjs";

export async function runGlobalModelListCommand(ctx) {
  const apiKey = await resolveFireworksApiKeyValue({
    apiKey: ctx.apiKey,
    home: ctx.home || process.env.HOME || "",
  });
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  await runModelListCommand({ options: ctx, apiKey });
}
