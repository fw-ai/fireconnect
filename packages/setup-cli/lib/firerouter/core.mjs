import {
  isFirerouterModel,
} from "../fireworks/model-id.mjs";
import { stdin as input } from "node:process";
import {
  persistGlobalAnthropicApiKey,
  readGlobalConfig,
  resolveStoredAnthropicApiKey,
} from "../config/global-config.mjs";
import { readSecret } from "../ui/read-secret.mjs";
import {
  FIRECONNECT_TELEMETRY_HEADER_NAMES,
  stripFireconnectTelemetryHeaderLines,
} from "../telemetry/request-headers.mjs";

export const FIREROUTER_FIREWORKS_HEADER = "X-Fireworks-Api-Key";
export const FIREROUTER_TAGLINE =
  "Picks a model for each request based on the task.";
export const LEGACY_FIREROUTER_FIREWORKS_HEADER = "X-FireRouter-Fireworks-Key";
// Outbound routing preference FireRouter reads to trade capability vs cost
// (1 = max intelligence … 5 = max savings). Set via `--routing-preference`;
// omitted entirely when unset so FireRouter applies its own default. Re-running
// `on` without the flag clears a previously written value.
export const ROUTING_PREFERENCE_HEADER = "x-routing-preference";
export const ROUTING_PREFERENCE_MIN = 1;
export const ROUTING_PREFERENCE_MAX = 5;
// Named levels accepted on the CLI, mapped to the numeric value sent on the wire.
export const ROUTING_PREFERENCE_LEVELS = Object.freeze({
  "max-intelligence": 1,
  "more-intelligence": 2,
  "balanced": 3,
  "more-savings": 4,
  "max-savings": 5,
});
export const ROUTING_PREFERENCE_LEVEL_NAMES = Object.keys(ROUTING_PREFERENCE_LEVELS).join(", ");

/**
 * Coerce a routing-preference value to its numeric wire value in [1,5], or null
 * when unset/unrecognized. Accepts the named levels (case-insensitive) and the
 * numeric aliases 1-5 (as number or string), so the CLI parser and the header
 * builders share one guard.
 * @param {number|string|null|undefined} value
 * @returns {number|null}
 */
export function normalizeRoutingPreference(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const named = ROUTING_PREFERENCE_LEVELS[value.trim().toLowerCase()];
    if (named !== undefined) {
      return named;
    }
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < ROUTING_PREFERENCE_MIN || n > ROUTING_PREFERENCE_MAX) {
    return null;
  }
  return n;
}

/**
 * Named routing level for harness `on` output, or null when unset/invalid.
 * @param {number|string|null|undefined} routingPreference
 * @returns {string|null}
 */
export function routingPreferenceLevelName(routingPreference) {
  const preference = normalizeRoutingPreference(routingPreference);
  if (preference === null) {
    return null;
  }
  return Object.keys(ROUTING_PREFERENCE_LEVELS).find(
    (level) => ROUTING_PREFERENCE_LEVELS[level] === preference,
  ) ?? null;
}

/**
 * Named level with numeric alias, e.g. `balanced (3)`.
 * @param {number|string|null|undefined} routingPreference
 * @param {{ defaultLevel?: string }} [options]
 * @returns {string}
 */
export function routingPreferenceLevelLabel(routingPreference, { defaultLevel = "balanced" } = {}) {
  const levelName = routingPreferenceLevelName(routingPreference) ?? defaultLevel;
  return `${levelName} (${ROUTING_PREFERENCE_LEVELS[levelName]})`;
}

/**
 * Comma-separated routing levels for user-facing hints.
 * @param {{ excludeLevel?: string }} [options]
 * @returns {string}
 */
export function routingPreferenceOptionsList({ excludeLevel } = {}) {
  return Object.entries(ROUTING_PREFERENCE_LEVELS)
    .filter(([name]) => name !== excludeLevel)
    .map(([name, num]) => `${name} (${num})`)
    .join(", ");
}

export const CLAUDE_FIREROUTER_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
];

/** Claude model-mapping env keys that can independently use FireRouter. */
export const CLAUDE_FIREROUTER_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/**
 * Whether any Claude model slot routes through FireRouter. A stale custom
 * header alone is deliberately not enough.
 * @param {Record<string, string>} env
 */
export function firerouterStatusFromEnv(env) {
  const slotValues = CLAUDE_FIREROUTER_MODEL_ENV_KEYS.map((key) => env[key]);
  return slotValues.some((modelId) => isFirerouterModel(modelId))
    ? "firerouter"
    : "other";
}

function isFirerouterOwnedEnvEntry(key, value, env) {
  // ANTHROPIC_CUSTOM_HEADERS is handled line-by-line in stripFirerouterOwnedEnv
  // (it can mix FireConnect-managed lines with user-added ones), never wholesale.
  // When any slot uses FireRouter, the complete mapping was written by
  // FireConnect and is rebuilt together. Outside that state a user's own model
  // mapping is never stripped by this helper.
  if (CLAUDE_FIREROUTER_MODEL_ENV_KEYS.includes(key)) {
    return isFirerouterModel(value) || firerouterStatusFromEnv(env) === "firerouter";
  }
  if (firerouterStatusFromEnv(env) !== "firerouter") {
    return false;
  }
  return CLAUDE_FIREROUTER_ENV_KEYS.includes(key);
}

/**
 * @param {Record<string, string>} env
 */
export function stripFirerouterOwnedEnv(env) {
  const nextEnv = { ...env };
  let changed = false;
  for (const key of [...CLAUDE_FIREROUTER_ENV_KEYS, ...CLAUDE_FIREROUTER_MODEL_ENV_KEYS]) {
    if (!Object.hasOwn(nextEnv, key)) {
      continue;
    }
    // ANTHROPIC_CUSTOM_HEADERS can hold user-added lines next to FireConnect's
    // managed auth/routing headers (direct mode writes X-Fireworks-Api-Key here
    // too). Strip only our lines so re-running `on` — or tearing down — keeps the
    // user's own custom headers instead of dropping the whole field.
    if (key === "ANTHROPIC_CUSTOM_HEADERS") {
      if (!hasManagedCustomHeaderLine(nextEnv[key])) {
        continue;
      }
      const remaining = stripManagedCustomHeaderLines(nextEnv[key]);
      if (remaining) {
        nextEnv[key] = remaining;
      } else {
        delete nextEnv[key];
      }
      changed = true;
      continue;
    }
    if (isFirerouterOwnedEnvEntry(key, nextEnv[key], env)) {
      delete nextEnv[key];
      changed = true;
    }
  }
  return { env: nextEnv, changed };
}

/**
 * Extract the Fireworks key value from an ANTHROPIC_CUSTOM_HEADERS string
 * (matches X-Fireworks-Api-Key or the legacy header name). Returns "" when
 * absent. Used to resolve the harness-local key now that Claude direct mode
 * authenticates via the custom header rather than apiKeyHelper.
 * @param {unknown} value
 * @returns {string}
 */
/**
 * Extract the first matching header line's value from an ANTHROPIC_CUSTOM_HEADERS
 * string (case-insensitive on the header name). Returns "" when absent.
 * @param {unknown} value
 * @param {string[]} headerNames
 * @returns {string}
 */
export function customHeaderValue(value, headerNames) {
  if (typeof value !== "string") {
    return "";
  }
  const wanted = headerNames.map((name) => name.toLowerCase());
  for (const line of value.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (wanted.includes(name)) {
      return line.slice(colon + 1).trim();
    }
  }
  return "";
}

export function fireworksKeyFromCustomHeaders(value) {
  return customHeaderValue(value, [
    FIREROUTER_FIREWORKS_HEADER,
    LEGACY_FIREROUTER_FIREWORKS_HEADER,
  ]);
}

/**
 * Extract the Anthropic BYOK key from an ANTHROPIC_CUSTOM_HEADERS string. In
 * FireRouter mode the pass-through key lives ONLY in the `x-anthropic-api-key`
 * header line (never a separate env var), so re-`on` must read it back from here
 * or it would be silently dropped.
 * @param {unknown} value
 * @returns {string}
 */
export function anthropicKeyFromCustomHeaders(value) {
  return customHeaderValue(value, [ANTHROPIC_BYOK_HEADER]);
}

/**
 * Build a `settingsEnv`-shaped object (with an ANTHROPIC_CUSTOM_HEADERS string)
 * from a harness's stored provider headers, so a repeat `on` can recover the
 * Anthropic BYOK key that lives only in those headers via
 * resolveFirerouterByokKeys. Returns `{}` when the BYOK header is absent.
 * @param {Record<string, string>} [headers]
 * @returns {Record<string, string>}
 */
export function byokEnvFromHeaders(headers = {}) {
  const anthropic = headers?.[ANTHROPIC_BYOK_HEADER];
  return anthropic
    ? { ANTHROPIC_CUSTOM_HEADERS: `${ANTHROPIC_BYOK_HEADER}: ${anthropic}` }
    : {};
}

/**
 * Set (or replace) the Fireworks key line in an ANTHROPIC_CUSTOM_HEADERS value
 * while preserving every OTHER line the user may have added. Used by direct mode,
 * which authenticates via the X-Fireworks-Api-Key header — re-running `on` must
 * not clobber unrelated custom-header lines. Returns just the Fireworks line when
 * there is nothing else to keep.
 * @param {unknown} value  current ANTHROPIC_CUSTOM_HEADERS
 * @param {string} fireworksKey
 * @returns {string}
 */
export function setFireworksKeyInCustomHeaders(value, fireworksKey) {
  const key = fireworksKey?.trim();
  const others = stripFireworksKeyFromCustomHeaders(value);
  const fireworksLine = key ? `${FIREROUTER_FIREWORKS_HEADER}: ${key}` : "";
  return [fireworksLine, others].filter(Boolean).join("\n");
}

/**
 * Remove any Fireworks-key line(s) (current or legacy name) from an
 * ANTHROPIC_CUSTOM_HEADERS value, preserving all other lines. Returns "" when
 * nothing remains, so callers can drop the key entirely on teardown.
 * @param {unknown} value
 * @returns {string}
 */
export function stripFireworksKeyFromCustomHeaders(value) {
  if (typeof value !== "string") {
    return "";
  }
  const names = [
    FIREROUTER_FIREWORKS_HEADER.toLowerCase(),
    LEGACY_FIREROUTER_FIREWORKS_HEADER.toLowerCase(),
  ];
  return value
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const colon = line.indexOf(":");
      const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
      return !names.includes(name);
    })
    .join("\n");
}

// BYOK header FireRouter reads to pass a request through to real Anthropic
// models using the user's own Anthropic key. Sent as a custom header (not
// ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN) so it can't collide with the
// X-Fireworks-Api-Key that authenticates the gateway.
export const ANTHROPIC_BYOK_HEADER = "x-anthropic-api-key";
/** Request-body field FireRouter reads on the VS Code Chat wire (firerouter model). */
export const ANTHROPIC_BYOK_BODY_FIELD = "anthropic_api_key";

/** Every ANTHROPIC_CUSTOM_HEADERS line FireConnect writes (auth + routing). */
const MANAGED_CUSTOM_HEADER_NAMES = [
  FIREROUTER_FIREWORKS_HEADER,
  LEGACY_FIREROUTER_FIREWORKS_HEADER,
  ANTHROPIC_BYOK_HEADER,
  ROUTING_PREFERENCE_HEADER,
  ...FIRECONNECT_TELEMETRY_HEADER_NAMES,
].map((name) => name.toLowerCase());

/** @param {unknown} value @returns {boolean} */
export function hasManagedCustomHeaderLine(value) {
  if (typeof value !== "string") {
    return false;
  }
  return stripFireconnectTelemetryHeaderLines(value) !== value
    || value.split("\n").some((line) => {
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
    return MANAGED_CUSTOM_HEADER_NAMES.includes(name);
  });
}

/**
 * Remove every FireConnect-managed header line (Fireworks key — current or
 * legacy — plus BYOK and routing-preference headers) from an
 * ANTHROPIC_CUSTOM_HEADERS value, preserving all user-added lines. Returns ""
 * when nothing remains, so callers can drop the key entirely on teardown.
 * @param {unknown} value
 * @returns {string}
 */
export function stripManagedCustomHeaderLines(value) {
  if (typeof value !== "string") {
    return "";
  }
  const withoutRouting = value
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const colon = line.indexOf(":");
      const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
      return !MANAGED_CUSTOM_HEADER_NAMES.includes(name);
    })
    .join("\n");
  return stripFireconnectTelemetryHeaderLines(withoutRouting);
}

/**
 * Claude Code reads proxy auth from ANTHROPIC_CUSTOM_HEADERS, which accepts
 * multiple `Name: Value` lines separated by newlines. The Fireworks key
 * authenticates the gateway via X-Fireworks-Api-Key (which wins over any
 * x-api-key / Authorization a user's ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 * would otherwise inject); an optional Anthropic key rides along as a BYOK
 * header so FireRouter can pass hard requests through to real Anthropic models.
 * @param {{ fireworksKey: string, anthropicKey?: string, routingPreference?: number|string|null, telemetryHeaders?: Record<string,string> }} keys
 */
export function buildClaudeCustomHeaders({
  fireworksKey,
  anthropicKey = "",
  routingPreference = null,
  telemetryHeaders = {},
}) {
  const lines = [`${FIREROUTER_FIREWORKS_HEADER}: ${fireworksKey}`];
  if (anthropicKey?.trim()) {
    lines.push(`${ANTHROPIC_BYOK_HEADER}: ${anthropicKey.trim()}`);
  }
  const preference = normalizeRoutingPreference(routingPreference);
  if (preference !== null) {
    lines.push(`${ROUTING_PREFERENCE_HEADER}: ${preference}`);
  }
  for (const [name, value] of Object.entries(telemetryHeaders)) {
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * BYOK header for OpenAI-wire harnesses' provider config (OpenCode/Codex/Pi/
 * VS Code): the user's Anthropic key, so FireRouter can pass hard requests
 * through to real Anthropic models. Empty when no key is present.
 * @param {{ anthropicKey?: string }} keys
 * @returns {Record<string, string>}
 */
export function firerouterByokHeaders({ anthropicKey = "" } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (anthropicKey?.trim()) {
    headers[ANTHROPIC_BYOK_HEADER] = anthropicKey.trim();
  }
  return headers;
}

/**
 * Swap the Fireworks key inside an ANTHROPIC_CUSTOM_HEADERS value while
 * preserving every other line (routing preference, user-added headers). A
 * legacy-named Fireworks header is rewritten under the current name, so the
 * swap also heals settings written before the header rename. Returns the
 * input unchanged (same reference) when it isn't FireRouter-shaped or there
 * is no key to swap in — callers use identity to mean "nothing to write".
 * @param {unknown} value  current ANTHROPIC_CUSTOM_HEADERS
 * @param {string} fireworksKey
 */
export function replaceFireworksKeyInCustomHeaders(value, fireworksKey) {
  if (typeof value !== "string" || !fireworksKey?.trim()) {
    return value;
  }
  const fireworksHeaderNames = [
    FIREROUTER_FIREWORKS_HEADER.toLowerCase(),
    LEGACY_FIREROUTER_FIREWORKS_HEADER.toLowerCase(),
  ];
  let found = false;
  const lines = value.split("\n").map((line) => {
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
    if (!fireworksHeaderNames.includes(name)) {
      return line;
    }
    found = true;
    return `${FIREROUTER_FIREWORKS_HEADER}: ${fireworksKey.trim()}`;
  });
  return found ? lines.join("\n") : value;
}

/** Anthropic API keys start with `sk-ant-`. */
export function isAnthropicShapedKey(key) {
  return typeof key === "string" && key.trim().startsWith("sk-ant-");
}

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
  // FireRouter mode keeps the pass-through key only in the custom-header line,
  // so re-`on` must read it back from there to avoid dropping it.
  const fromHeader = anthropicKeyFromCustomHeaders(settingsEnv.ANTHROPIC_CUSTOM_HEADERS);
  if (fromHeader && isAnthropicShapedKey(fromHeader)) {
    return fromHeader;
  }
  return "";
}

/**
 * Resolve the Anthropic BYOK key FireRouter forwards. If one is already
 * available (flag/global/env/settings), it's used as-is. When none is available,
 * the optional `resolveWorkspaceByok` seam is consulted first — if the workspace
 * provisions the key server-side (`enable-workspace-byok`), FireRouter works
 * with no user key and we never prompt. Otherwise prompts once (interactive
 * only; declining is fine — FireRouter still routes Fireworks models).
 *
 * @param {{
 *   anthropicFlag?: string,
 *   settingsEnv?: Record<string, string>,
 *   home?: string,
 *   resolveWorkspaceByok?: () => Promise<boolean>,
 *   explicit?: boolean,
 *   allowPromptSkip?: boolean,
 * }} input
 * @returns {Promise<{
 *   anthropicKey: string,
 *   workspaceByokLookup: import("../config/feature-flags.mjs").FeatureFlagLookupResult|null,
 * }>}
 */
export async function resolveFirerouterByokKeys({
  anthropicFlag = "",
  settingsEnv = {},
  home = "",
  resolveWorkspaceByok,
  explicit = false,
  allowPromptSkip = true,
} = {}) {
  let anthropicKey = await resolveAnthropicKey({ apiKey: anthropicFlag, settingsEnv, home });
  let workspaceByokLookup = null;
  if (!anthropicKey) {
    const rawLookup = resolveWorkspaceByok ? await resolveWorkspaceByok() : false;
    workspaceByokLookup = typeof rawLookup === "boolean"
      ? { enabled: rawLookup, unavailable: false, reason: "" }
      : rawLookup;
    if (!workspaceByokLookup.enabled) {
      anthropicKey = await promptOptionalAnthropicKey({
        home,
        explicit,
        allowSkip: allowPromptSkip,
      });
    }
  }
  return { anthropicKey, workspaceByokLookup };
}

/**
 * Optional interactive prompt for an Anthropic BYOK key in FireRouter mode.
 * Returns "" (never throws) on a non-TTY, an empty/declined entry, or a
 * malformed key — FireRouter still routes Fireworks models without it. A valid
 * key is persisted to global config so future runs pick it up.
 * @param {{ home?: string, explicit?: boolean, allowSkip?: boolean }} args
 * @returns {Promise<string>}
 */
export function anthropicKeyPromptCopy({ explicit = false, allowSkip = true } = {}) {
  if (!allowSkip) {
    return {
      intro: "FireRouter requires an Anthropic API key when Claude isn't signed in.",
      prompt: "Anthropic API key (required, sk-ant-...): ",
      invalid: "That doesn't look like an Anthropic API key (should start with sk-ant-).",
    };
  }
  return {
    intro: explicit
      ? "FireRouter routes hard requests to Anthropic models. Paste your Anthropic API key to enable that."
      : "Optional: add your Anthropic API key so FireRouter can route hard requests to Anthropic models.",
    prompt: explicit
      ? "Anthropic API key (sk-ant-..., Enter to skip): "
      : "Anthropic API key (sk-ant-..., or press Enter to skip): ",
    invalid: "That doesn't look like an Anthropic API key (should start with sk-ant-). Skipping.",
  };
}

export function evaluateAnthropicKeyPrompt(value, { allowSkip = true } = {}) {
  const key = String(value ?? "").trim();
  if (isAnthropicShapedKey(key)) {
    return { key, retry: false };
  }
  return {
    key: "",
    retry: !allowSkip,
  };
}

export async function promptOptionalAnthropicKey({
  home = "",
  explicit = false,
  allowSkip = true,
} = {}) {
  if (!input.isTTY) {
    return "";
  }
  const copy = anthropicKeyPromptCopy({ explicit, allowSkip });
  console.log(copy.intro);
  while (true) {
    const prompted = await readSecret(
      copy.prompt,
      { allowEmpty: true },
    );
    const result = evaluateAnthropicKeyPrompt(prompted, { allowSkip });
    if (result.key) {
      if (home) {
        await persistGlobalAnthropicApiKey(home, result.key);
      }
      return result.key;
    }
    if (!prompted && !allowSkip) {
      console.log("Anthropic API key is required. Press Ctrl-C to cancel.");
    } else if (prompted) {
      console.log(copy.invalid);
    }
    if (!result.retry) {
      return "";
    }
  }
}
