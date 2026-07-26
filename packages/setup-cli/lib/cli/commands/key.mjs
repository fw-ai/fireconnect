import process from "node:process";
import { exportFireworksApiKey } from "../../keys/api-key.mjs";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  readGlobalConfig,
  resolveStoredAnthropicApiKey,
} from "../../config/global-config.mjs";

async function exportAnthropicApiKey(home, { storedOnly = false } = {}) {
  if (!storedOnly && process.env.ANTHROPIC_API_KEY?.trim()) {
    return process.env.ANTHROPIC_API_KEY.trim();
  }
  const config = await readGlobalConfig(home);
  if (storedOnly && config.anthropicApiKey === ANTHROPIC_API_KEY_ENV_REF) {
    throw new Error("No stored Anthropic API key found.");
  }
  const key = resolveStoredAnthropicApiKey(config.anthropicApiKey);
  if (!key?.trim()) {
    throw new Error("No Anthropic API key found.");
  }
  return key;
}

/**
 * Internal key resolver — NOT a user-facing command. `fireconnect key export`
 * is the entrypoint the Claude apiKeyHelper and the codex/opencode/pi shell
 * hooks invoke at runtime to print the resolved Fireworks key. User-facing key
 * management lives in `login` / `logout` / `status`.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {"export"} subcommand
 */
export async function runKeyCommand(ctx, subcommand) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  if (subcommand === "export") {
    const key = ctx.anthropic
      ? await exportAnthropicApiKey(home, { storedOnly: ctx.storedOnly })
      : await exportFireworksApiKey(home, { storedOnly: ctx.storedOnly });
    process.stdout.write(key);
    return;
  }

  throw new Error(`Unknown key subcommand: ${subcommand}`);
}
