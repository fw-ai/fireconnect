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
import { readSecret } from "./read-secret.mjs";
import { HARNESS } from "./harness.mjs";

export const FIREROUTER_BASE_URL = "https://router.fireworks.ai";
const FIREROUTER_HOST = new URL(FIREROUTER_BASE_URL).hostname;
export const ANTHROPIC_API_KEY_CONFIG_FIELD = "anthropicApiKey";
export const FIREROUTER_FIREWORKS_HEADER = "X-FireRouter-Fireworks-Key";

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
    }
    const enterprise = await resolveEnterpriseAnthropicAuth(home, harness);
    if (enterprise.enterpriseAuth) {
      return anthropicKeyResult({
        source: enterprise.source || "enterprise-auth",
        enterpriseAuth: true,
      });
    }
  }

  if (input.isTTY && home) {
    const prompted = await readSecret("Anthropic API key (sk-ant-...): ");
    if (!isAnthropicShapedKey(prompted)) {
      throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
    }
    await persistGlobalAnthropicApiKey(home, prompted);
    return anthropicKeyResult({
      anthropicKey: prompted,
      anthropicKeyFromFlag: true,
      source: "prompt",
    });
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
