import { FIREWORKS_BASE_URL } from "./fireconnect-core.mjs";
import { stdin as input } from "node:process";
import {
  isAnthropicShapedKey,
  readOpencodeAnthropicAuth,
  resolveEnterpriseAnthropicAuth,
} from "./anthropic-enterprise.mjs";
import {
  ANTHROPIC_API_KEY_ENV_REF,
  persistGlobalAnthropicApiKey,
  readGlobalConfig,
  resolveStoredAnthropicApiKey,
} from "./global-config.mjs";
import { readLineVisible, readSecret } from "./read-secret.mjs";
import { HARNESS } from "./harness.mjs";

export const FIREROUTER_BASE_URL = "https://router.fireworks.ai";
const FIREROUTER_HOST = new URL(FIREROUTER_BASE_URL).hostname;
export const ANTHROPIC_API_KEY_CONFIG_FIELD = "anthropicApiKey";
export const FIREROUTER_FIREWORKS_HEADER = "X-FireRouter-Fireworks-Key";
// Last-resort model when a harness cannot derive one from an explicit choice,
// an environment override, or FireRouter's advertised configuration.
export const FALLBACK_FIREROUTER_MAIN_MODEL = "claude-opus-4-8";

export const CLAUDE_FIREROUTER_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
];

/**
 * Infer active router wiring from Claude settings (for status display).
 * @param {Record<string, string>} env
 * @param {{ routerBaseUrl?: string }} [options]
 */
export function firerouterStatusFromEnv(env, { routerBaseUrl = "" } = {}) {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (!baseUrl || baseUrl === FIREWORKS_BASE_URL) {
    return "other";
  }
  const normalized = normalizeFirerouterUrl(baseUrl);
  if (isFirerouterBaseUrl(normalized)) {
    return "firerouter";
  }
  const stored = routerBaseUrl.trim();
  if (stored && normalized === normalizeFirerouterUrl(stored)) {
    return "firerouter";
  }
  return "other";
}

function isFirerouterOwnedEnvEntry(key, value, env, options = {}) {
  if (key === "ANTHROPIC_CUSTOM_HEADERS") {
    return isFirerouterCustomHeaders(value);
  }
  if (firerouterStatusFromEnv(env, options) !== "firerouter") {
    return false;
  }
  return CLAUDE_FIREROUTER_ENV_KEYS.includes(key);
}

/**
 * @param {Record<string, string>} env
 * @param {{ routerBaseUrl?: string }} [options]
 */
export function stripFirerouterOwnedEnv(env, options = {}) {
  const nextEnv = { ...env };
  let changed = false;
  for (const key of CLAUDE_FIREROUTER_ENV_KEYS) {
    if (!Object.hasOwn(nextEnv, key)) {
      continue;
    }
    if (isFirerouterOwnedEnvEntry(key, nextEnv[key], env, options)) {
      delete nextEnv[key];
      changed = true;
    }
  }
  return { env: nextEnv, changed };
}

export function isFirerouterCustomHeaders(value) {
  return typeof value === "string" && value.includes(FIREROUTER_FIREWORKS_HEADER);
}

/**
 * Ensure a FireRouter URL has an https:// scheme.
 * @param {string} url
 */
export function normalizeFirerouterUrl(url) {
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed) {
    return FIREROUTER_BASE_URL;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/**
 * @param {string | undefined | null} url
 */
export function isFirerouterBaseUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  try {
    const host = new URL(normalizeFirerouterUrl(url)).hostname;
    return host === FIREROUTER_HOST;
  } catch {
    return url.includes(FIREROUTER_HOST);
  }
}

/**
 * Pick the FireRouter base URL. Flag wins, then global config, then prod default.
 * @param {string} [baseUrl]
 * @param {string} [storedRouterBaseUrl]
 */
export function resolveFirerouterBaseUrl(baseUrl = "", storedRouterBaseUrl = "") {
  const trimmed = baseUrl.trim();
  if (trimmed && trimmed !== FIREWORKS_BASE_URL) {
    return normalizeFirerouterUrl(trimmed);
  }
  const stored = storedRouterBaseUrl.trim();
  if (stored) {
    return normalizeFirerouterUrl(stored);
  }
  return FIREROUTER_BASE_URL;
}

/**
 * Claude Code reads proxy auth from ANTHROPIC_CUSTOM_HEADERS.
 * @param {{ fireworksKey: string }} keys
 */
export function buildClaudeCustomHeaders({ fireworksKey }) {
  return `X-FireRouter-Fireworks-Key: ${fireworksKey}`;
}

/**
 * OpenCode / Codex / Pi provider blocks use structured HTTP headers.
 * @param {{ fireworksKey: string, anthropicKey?: string }} keys
 */
export function buildFirerouterHttpHeaders({ fireworksKey, anthropicKey = "" }) {
  /** @type {Record<string, string>} */
  const headers = {
    "X-FireRouter-Fireworks-Key": fireworksKey,
  };
  if (anthropicKey) {
    headers["x-api-key"] = anthropicKey;
  }
  return headers;
}

export { isAnthropicShapedKey } from "./anthropic-enterprise.mjs";

/**
 * @param {{
 *   apiKey?: string,
 *   settingsEnv?: Record<string, string>,
 *   home?: string,
 * }} input
 */
export async function resolveAnthropicKey({
  apiKey = "",
  settingsEnv = {},
  home = "",
} = {}) {
  const fromFlag = apiKey?.trim() ?? "";
  if (fromFlag && isAnthropicShapedKey(fromFlag)) {
    return fromFlag;
  }
  if (home) {
    const config = await readGlobalConfig(home);
    const fromGlobal = resolveStoredAnthropicApiKey(config.anthropicApiKey);
    if (fromGlobal && isAnthropicShapedKey(fromGlobal)) {
      return fromGlobal;
    }
  }
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (fromEnv && isAnthropicShapedKey(fromEnv)) {
    return fromEnv;
  }
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const value = settingsEnv[key]?.trim() ?? "";
    if (value && isAnthropicShapedKey(value)) {
      return value;
    }
  }
  return "";
}

export const MISSING_ANTHROPIC_KEY_MESSAGE =
  "No Anthropic API key found for FireRouter. Pass --anthropic-api-key, set ANTHROPIC_API_KEY, or run in an interactive terminal to enter one.";

/**
 * @param {{
 *   anthropicKey?: string,
 *   anthropicKeyFromFlag?: boolean,
 *   reusedExistingKey?: boolean,
 *   source?: string,
 *   enterpriseAuth?: boolean,
 *   runtimeAuth?: boolean,
 * }} fields
 */
function anthropicKeyResult({
  anthropicKey = "",
  anthropicKeyFromFlag = false,
  reusedExistingKey = false,
  source = "",
  enterpriseAuth = false,
  runtimeAuth = false,
}) {
  return {
    anthropicKey,
    anthropicKeyFromFlag,
    reusedExistingKey,
    source,
    enterpriseAuth,
    runtimeAuth,
  };
}

/**
 * Resolve Anthropic credentials for router `on`.
 * Precedence: flag > harness-local > global > env > harness-specific fallbacks.
 * OpenCode may read auth.json API keys; Claude may use .credentials.json enterprise auth.
 * Otherwise prompt interactively and persist to global config.
 *
 * @param {{
 *   anthropicKey?: string,
 *   anthropicKeyFromFlag?: boolean,
 *   home?: string,
 *   harness?: string,
 *   harnessEnvRef?: string,
 *   getExistingHarnessKey?: () => Promise<string>,
 * }} args
 */
export async function resolveHarnessOnAnthropicKey({
  anthropicKey = "",
  anthropicKeyFromFlag = false,
  home = "",
  harness = "",
  harnessEnvRef = ANTHROPIC_API_KEY_ENV_REF,
  getExistingHarnessKey,
}) {
  const resolved = await _resolveStoredAnthropicKey({
    anthropicKey,
    anthropicKeyFromFlag,
    home,
    harnessEnvRef,
    getExistingHarnessKey,
  });
  if (resolved) {
    return resolved;
  }

  if (home && harness) {
    if (harness === HARNESS.OPENCODE) {
      const opencode = await readOpencodeAnthropicAuth(home);
      if (opencode.kind !== "none") {
        return anthropicKeyResult({
          source: "opencode-auth",
          runtimeAuth: true,
        });
      }
      // Deliberately do NOT fall back to Claude Code's enterprise OAuth in the
      // macOS keychain for OpenCode: that's a different app's login. Require an
      // explicit Anthropic key (flag/global/env) or an interactive prompt.
    } else {
      const enterprise = await resolveEnterpriseAnthropicAuth(home, harness);
      if (enterprise.enterpriseAuth) {
        return anthropicKeyResult({
          source: enterprise.source || "enterprise-auth",
          enterpriseAuth: true,
        });
      }
    }
  }

  if (input.isTTY && home) {
    return promptForAnthropicAuth({ home, harness });
  }

  throw new Error(MISSING_ANTHROPIC_KEY_MESSAGE);
}

/**
 * Prompt once for an Anthropic API key, validate its shape, and persist it to
 * global config. Returns the resolved result, or null when the entry was blank
 * or malformed (a reason is printed so the caller can re-ask).
 * @param {{ home: string }} args
 */
async function readAnthropicApiKeyOnce({ home }) {
  const prompted = await readSecret("Anthropic API key (sk-ant-...): ", { allowEmpty: true });
  if (!prompted) {
    console.log("No key entered — try again, or press Ctrl+C to cancel.");
    return null;
  }
  if (!isAnthropicShapedKey(prompted)) {
    console.log("That doesn't look like an Anthropic API key (should start with sk-ant-). Try again.");
    return null;
  }
  await persistGlobalAnthropicApiKey(home, prompted);
  return anthropicKeyResult({
    anthropicKey: prompted,
    anthropicKeyFromFlag: true,
    source: "prompt",
  });
}

/**
 * No stored key or enterprise auth was found. Offer a choice instead of
 * jumping straight to an API-key prompt, and don't crash the whole command
 * on a blank/mistyped answer — re-ask instead.
 *
 * OpenCode is deliberately excluded from the "already logged in elsewhere"
 * option: it must not borrow Claude Code's keychain/enterprise login (a
 * different app's credential), so it is prompted for an explicit key only.
 * @param {{ home: string, harness: string }} args
 */
async function promptForAnthropicAuth({ home, harness }) {
  if (harness === HARNESS.OPENCODE) {
    console.log("No Anthropic API key found for FireRouter (ANTHROPIC_API_KEY is not set).");
    console.log("Enter an Anthropic API key to route OpenCode through FireRouter.");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await readAnthropicApiKeyOnce({ home });
      if (result) return result;
    }
    throw new Error(MISSING_ANTHROPIC_KEY_MESSAGE);
  }

  console.log("No stored Anthropic key or Claude Enterprise login was found.");
  console.log("  1) I'm already logged into Claude Code elsewhere (Enterprise/Pro/Team) — retry detection");
  console.log("  2) Enter an Anthropic API key");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const choice = (await readLineVisible("Choice (1/2): ")).trim();

    if (choice === "1") {
      const enterprise = await resolveEnterpriseAnthropicAuth(home, harness);
      if (enterprise.enterpriseAuth) {
        return anthropicKeyResult({
          source: enterprise.source || "enterprise-auth",
          enterpriseAuth: true,
        });
      }
      console.log(
        "No Claude Enterprise login was found. Run `claude` and log in first, then retry "
          + "`fireconnect claude on --router` — or enter an API key now.",
      );
      continue;
    }

    if (choice === "2" || choice === "") {
      const result = await readAnthropicApiKeyOnce({ home });
      if (result) return result;
      continue;
    }

    console.log('Please enter "1" or "2".');
  }

  throw new Error(MISSING_ANTHROPIC_KEY_MESSAGE);
}

async function _resolveStoredAnthropicKey({
  anthropicKey,
  anthropicKeyFromFlag,
  home,
  harnessEnvRef,
  getExistingHarnessKey,
}) {
  if (anthropicKeyFromFlag && anthropicKey?.trim()) {
    if (!isAnthropicShapedKey(anthropicKey)) {
      throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
    }
    return anthropicKeyResult({
      anthropicKey: anthropicKey.trim(),
      anthropicKeyFromFlag: true,
      source: "flag",
    });
  }

  if (getExistingHarnessKey) {
    const existing = (await getExistingHarnessKey())?.trim() ?? "";
    if (existing && existing !== harnessEnvRef && isAnthropicShapedKey(existing)) {
      return anthropicKeyResult({
        anthropicKey: existing,
        anthropicKeyFromFlag: true,
        reusedExistingKey: true,
        source: "harness-local",
      });
    }
    if (existing === harnessEnvRef) {
      const fromEnv = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
      if (fromEnv && isAnthropicShapedKey(fromEnv)) {
        return anthropicKeyResult({
          anthropicKey: fromEnv,
          reusedExistingKey: true,
          source: "harness-env-ref",
        });
      }
    }
  }

  if (home) {
    const stored = (await readGlobalConfig(home)).anthropicApiKey;
    if (stored && stored !== ANTHROPIC_API_KEY_ENV_REF) {
      const key = resolveStoredAnthropicApiKey(stored);
      if (key && isAnthropicShapedKey(key)) {
        return anthropicKeyResult({
          anthropicKey: key,
          anthropicKeyFromFlag: true,
          source: "global-literal",
        });
      }
    }
    if (stored === ANTHROPIC_API_KEY_ENV_REF) {
      const key = resolveStoredAnthropicApiKey(stored);
      if (key && isAnthropicShapedKey(key)) {
        return anthropicKeyResult({
          anthropicKey: key,
          source: "global-env-ref",
        });
      }
    }
  }

  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (fromEnv && isAnthropicShapedKey(fromEnv)) {
    return anthropicKeyResult({
      anthropicKey: fromEnv,
      source: "env",
    });
  }

  return null;
}
