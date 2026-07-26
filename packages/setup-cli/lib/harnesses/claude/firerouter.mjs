import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  replaceFireworksKeyInCustomHeaders,
} from "../../firerouter/core.mjs";

export {
  CLAUDE_FIREROUTER_ENV_KEYS,
  firerouterStatusFromEnv,
} from "../../firerouter/core.mjs";

/**
 * Re-point the Fireworks key baked into Claude's custom headers at the key
 * that was just stored. Works for direct and slot-level FireRouter mappings.
 */
export async function refreshFirerouterClaudeKey({ settingsPath, fireworksKey }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const current = env.ANTHROPIC_CUSTOM_HEADERS;
  const next = replaceFireworksKeyInCustomHeaders(current, fireworksKey);
  if (next === current) {
    return false;
  }
  await writeJson(
    settingsPath,
    { ...settings, env: { ...env, ANTHROPIC_CUSTOM_HEADERS: next } },
    { mode: 0o600 },
  );
  return true;
}
