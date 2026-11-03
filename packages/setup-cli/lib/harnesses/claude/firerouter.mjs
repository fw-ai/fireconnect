import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  replaceFireworksKeyInCustomHeaders,
  stripCustomHeaderLines,
} from "../../firerouter/core.mjs";
import { isFireworksShapedKey } from "../../keys/key-type.mjs";

export {
  CLAUDE_FIREROUTER_ENV_KEYS,
  firerouterStatusFromEnv,
} from "../../firerouter/core.mjs";

/**
 * Re-point the Fireworks key baked into Claude's config at the key that was
 * just stored: the custom-headers line for every managed install, and — for
 * ≤v0.9.x installs that baked the key into `ANTHROPIC_AUTH_TOKEN` or
 * `ANTHROPIC_API_KEY` — those env fields too. Claude Code prefers the env
 * credential over custom headers, so a stale `fw_` value there overrides the
 * refreshed header and 403s. Only `fw_`-shaped values are touched: a user's
 * own `sk-ant-` key or the non-secret `fireconnect` sentinel is left alone.
 * Works for direct and slot-level FireRouter mappings.
 */
export async function refreshFirerouterClaudeKey({ settingsPath, fireworksKey }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const next = { ...env };
  const headers = replaceFireworksKeyInCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS, fireworksKey);
  if (headers !== env.ANTHROPIC_CUSTOM_HEADERS) {
    next.ANTHROPIC_CUSTOM_HEADERS = headers;
  }
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (isFireworksShapedKey(next[key]) && next[key].trim() !== fireworksKey.trim()) {
      next[key] = fireworksKey.trim();
    }
  }
  if (Object.keys(next).every((k) => next[k] === env[k])) {
    return false;
  }
  await writeJson(settingsPath, { ...settings, env: next }, { mode: 0o600 });
  return true;
}

/**
 * Drop saved provider keys from Claude's custom headers, after `nexus
 * auto --unset anthropic-api-key` / `--unset openai-api-key`.
 * `ANTHROPIC_API_KEY` is left alone: it is
 * Claude Code's own sign-in, and may predate Nexus.
 * @param {{ settingsPath: string, headerNames: string[] }} opts
 * @returns {Promise<boolean>} whether settings.json changed
 */
export async function removeClaudeSavedProviderKeys({ settingsPath, headerNames }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const current = env.ANTHROPIC_CUSTOM_HEADERS;
  if (typeof current !== "string") {
    return false;
  }
  const next = stripCustomHeaderLines(current, headerNames);
  if (next === stripCustomHeaderLines(current, [])) {
    return false;
  }
  const { ANTHROPIC_CUSTOM_HEADERS: _dropped, ...rest } = env;
  await writeJson(
    settingsPath,
    { ...settings, env: next ? { ...rest, ANTHROPIC_CUSTOM_HEADERS: next } : rest },
    { mode: 0o600 },
  );
  return true;
}
