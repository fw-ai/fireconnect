import process from "node:process";
import { exportFireworksApiKey } from "../api-key.mjs";

/**
 * Internal key resolver — NOT a user-facing command. `fireconnect key export`
 * is the entrypoint the Claude apiKeyHelper and the codex/opencode/pi shell
 * hooks invoke at runtime to print the resolved Fireworks key. User-facing key
 * management lives in `login` / `logout` / `status`.
 *
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 * @param {"export"} subcommand
 */
export async function runKeyCommand(ctx, subcommand) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  if (subcommand === "export") {
    const key = await exportFireworksApiKey(home, { storedOnly: ctx.storedOnly });
    process.stdout.write(key);
    return;
  }

  throw new Error(`Unknown key subcommand: ${subcommand}`);
}
