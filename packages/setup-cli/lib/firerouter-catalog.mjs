import process from "node:process";
import { FIREROUTER_BASE_URL, normalizeFirerouterUrl } from "./firerouter-core.mjs";

/**
 * FireRouter model discovery — harness-independent.
 *
 * FireRouter publicly advertises its opencode bootstrap (default model + full
 * per-provider model catalog) at `{baseUrl}/.well-known/opencode.json` (no auth).
 * Both the OpenCode and VS Code FireRouter harnesses read from here so the model
 * set stays current with the deployment instead of being hardcoded.
 *
 * Everything here always resolves (never throws) and falls back to bundled
 * defaults, so `on` works offline / on a first run.
 */

// Bare default model when none can be derived from the flag, env override, or
// the advertised config. Prefer resolveFirerouterDefaultModel() — the deployment
// is the source of truth.
export const FALLBACK_FIREROUTER_MAIN_MODEL = "claude-opus-4-8";

// De-cluttered Claude set VS Code router mode seeds when the catalog fetch is
// unavailable (offline first run). The live set is the source of truth.
export const FALLBACK_FIREROUTER_CLAUDE_MODELS = [
  { id: "claude-opus-4-8" },
  { id: "claude-sonnet-5" },
  { id: "claude-haiku-4-5" },
];

// Operator/CI overrides so models can be pinned without a network call. Take
// precedence over the well-known fetch.
export const FIREROUTER_MAIN_MODEL_ENV = "FIRECONNECT_ROUTER_MAIN_MODEL";
export const FIREROUTER_MODELS_ENV = "FIRECONNECT_ROUTER_MODELS";

const WELL_KNOWN_OPENCODE_PATH = "/.well-known/opencode.json";
const WELL_KNOWN_TIMEOUT_MS = 5000;

/**
 * Fetch and parse `{baseUrl}/.well-known/opencode.json`. Returns the parsed
 * config object, or `null` on any failure (network, non-2xx, bad JSON). Never
 * throws.
 * @param {string} baseUrl FireRouter root (no /v1 suffix)
 * @returns {Promise<object | null>}
 */
async function _fetchFirerouterWellKnown(baseUrl) {
  const root = normalizeFirerouterUrl(baseUrl || FIREROUTER_BASE_URL);
  try {
    const res = await fetch(`${root}${WELL_KNOWN_OPENCODE_PATH}`, {
      signal: AbortSignal.timeout(WELL_KNOWN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Strip a leading `<provider>/` from an advertised model id. */
function bareModelId(modelId) {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

/**
 * Resolve the default Anthropic model for FireRouter mode. The deployment is the
 * source of truth. Precedence:
 *   FIRECONNECT_ROUTER_MAIN_MODEL env > well-known fetch > bundled fallback.
 * Only Claude-shaped server defaults are honored (this retargets the Anthropic
 * provider, so a gpt-5.x deployment default wouldn't apply); anything else falls
 * back. Always resolves — never throws — so `on` works offline.
 * @param {string} baseUrl FireRouter root (no /v1 suffix)
 * @returns {Promise<string>} bare model id (no provider prefix)
 */
export async function resolveFirerouterDefaultModel(baseUrl) {
  const override = process.env[FIREROUTER_MAIN_MODEL_ENV]?.trim();
  if (override) return override;
  const config = await _fetchFirerouterWellKnown(baseUrl);
  const model = typeof config?.model === "string" ? bareModelId(config.model) : "";
  if (model && /^claude/i.test(model)) return model;
  return FALLBACK_FIREROUTER_MAIN_MODEL;
}

/**
 * Collapse near-duplicate Claude model descriptors: `[1m]` context variants and
 * dated snapshots (e.g. `claude-haiku-4-5-20251001`) are folded into their plain
 * alias when one is present. A model offered ONLY as a variant is kept (never
 * dropped entirely). First-seen order is preserved.
 * @param {Array<{id: string}>} descriptors
 * @returns {Array<{id: string}>}
 */
export function dedupeClaudeModels(descriptors) {
  const canonical = (id) => id.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
  /** @type {Map<string, {id: string}>} */
  const byKey = new Map();
  for (const d of descriptors ?? []) {
    if (!d?.id) continue;
    const key = canonical(d.id);
    const existing = byKey.get(key);
    // Prefer the plain alias (id === canonical key); otherwise keep the first seen.
    if (!existing || (existing.id !== key && d.id === key)) {
      byKey.set(key, d);
    }
  }
  return [...byKey.values()];
}

/**
 * Keep only the newest model in each Claude family so the picker isn't cluttered
 * with superseded minor versions — e.g. drop `claude-opus-4-7` when
 * `claude-opus-4-8` is present. The family is the non-numeric words after
 * `claude-` (`opus`, `sonnet`, `haiku`, …); the version is the trailing numeric
 * segments, compared left-to-right (so `5` beats `4-6`). `[1m]` and dated-snapshot
 * suffixes are ignored when deriving both. First-seen order of the surviving
 * models is preserved.
 * @param {Array<{id: string}>} descriptors
 * @returns {Array<{id: string}>}
 */
export function keepLatestClaudePerFamily(descriptors) {
  const bare = (id) => id.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
  const familyOf = (id) => {
    const words = [];
    for (const tok of bare(id).split("-").slice(1)) {
      if (/^\d+$/.test(tok)) break;
      words.push(tok);
    }
    return words.join("-");
  };
  const versionOf = (id) => bare(id).split("-").filter((t) => /^\d+$/.test(t)).map(Number);
  const isNewer = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d > 0;
    }
    return false;
  };
  /** @type {Map<string, {descriptor: object, version: number[]}>} */
  const best = new Map();
  const order = [];
  for (const d of descriptors ?? []) {
    if (!d?.id) continue;
    const family = familyOf(d.id);
    const version = versionOf(d.id);
    const current = best.get(family);
    if (!current) {
      best.set(family, { descriptor: d, version });
      order.push(family);
    } else if (isNewer(version, current.version)) {
      best.set(family, { descriptor: d, version });
    }
  }
  return order.map((family) => best.get(family).descriptor);
}

/**
 * Resolve the Anthropic (Messages-API) model set FireRouter advertises, for
 * harnesses that must enumerate models themselves (e.g. VS Code Chat). Precedence:
 *   FIRECONNECT_ROUTER_MODELS env > well-known fetch > bundled fallback.
 * Reads `provider.firerouter.models` (the Anthropic-key-authed provider) and keeps
 * only Claude-shaped ids — the Messages endpoint is Anthropic-format, so non-Claude
 * models (gpt, oss) don't apply — collapses near-duplicate variants, then keeps
 * only the newest model per family to declutter the picker. Never throws.
 * @param {string} baseUrl FireRouter root (no /v1 suffix)
 * @returns {Promise<Array<{id: string, name?: string, contextLimit?: number, outputLimit?: number}>>}
 */
export async function resolveFirerouterClaudeModels(baseUrl) {
  const override = process.env[FIREROUTER_MODELS_ENV]?.trim();
  if (override) {
    // Operator-pinned: use verbatim (respect intent, no de-dup / family reduction).
    return override
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id }));
  }

  const config = await _fetchFirerouterWellKnown(baseUrl);
  const models = config?.provider?.firerouter?.models;
  if (models && typeof models === "object") {
    const descriptors = Object.entries(models)
      .filter(([id]) => /^claude/i.test(id))
      .map(([id, meta]) => ({
        id,
        name: typeof meta?.name === "string" ? meta.name : undefined,
        contextLimit: Number.isInteger(meta?.limit?.context) ? meta.limit.context : undefined,
        outputLimit: Number.isInteger(meta?.limit?.output) ? meta.limit.output : undefined,
      }));
    const curated = keepLatestClaudePerFamily(dedupeClaudeModels(descriptors));
    if (curated.length > 0) return curated;
  }
  return FALLBACK_FIREROUTER_CLAUDE_MODELS;
}
