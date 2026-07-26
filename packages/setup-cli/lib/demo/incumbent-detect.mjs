/**
 * Incumbent auto-detection for `fireconnect demo` (§3 of the brief).
 *
 * Reuses the existing harness adapters / core modules to read what the developer
 * actually uses today — without modifying any config. The first harness in probe
 * order that is NOT currently routing through Fireworks is the incumbent.
 *
 * Honesty rules:
 *  - If a harness is fireconnect-on (Fireworks/FireRouter), it is skipped — it
 *    IS Fireworks, not an incumbent.
 *  - The race drives the REAL `claude -p` tool routed to Anthropic direct, so
 *    the only incumbents that can be raced live are Anthropic ones (Claude Code
 *    via keychain, or Pi with a stored key). `callMode` marks whether a key path
 *    was resolved; the demo uses it to decide whether to race, prompt for an
 *    ephemeral key, or exit — it NEVER fabricates a comparison. Non-Anthropic
 *    harnesses (Codex, Cursor, …) are detected for labeling but can't be raced
 *    head-to-head by this `claude -p`-based demo.
 *  - Pricing uses the provider's published list price. Embedded rates are a
 *    reference table with a verify URL; unknown models fall back to a default
 *    and set pricingEstimated=true.
 */

import process from "node:process";
import path from "node:path";
import {
  providerStatusFromEnv,
  userSettingsPath,
} from "../harnesses/claude/core.mjs";
import { stripClaudeCodeContextSuffix } from "../harnesses/claude/code-context.mjs";
import { isHarnessEnabled, readGlobalConfig, resolveStoredAnthropicApiKey } from "../config/global-config.mjs";
import { isAnthropicShapedKey } from "../firerouter/core.mjs";
import { HARNESS } from "../harness/id.mjs";
import { readJsonIfExists } from "../io/json.mjs";
import { isFireworksShapedKey } from "../keys/key-type.mjs";
import { opencodeConfigPath, opencodeCurrentModelId, opencodeProviderStatus, readRawIfExists } from "../harnesses/opencode/core.mjs";
import {
  codexConfigPath,
  codexProviderStatus,
  readCodexTomlIfExists,
} from "../harnesses/codex/core.mjs";
import { chatLanguageModelsPath, readChatLanguageModels } from "../harnesses/vscode/core.mjs";
import { cursorStateDbPath } from "../harnesses/cursor/core.mjs";
import { piSettingsPath } from "../harnesses/pi/core.mjs";
import { existsSync } from "node:fs";
import { prettyModelName } from "../fireworks/models.mjs";

const PROBE_ORDER = [
  HARNESS.CLAUDE,
  HARNESS.CODEX,
  HARNESS.CURSOR,
  HARNESS.OPENCODE,
  HARNESS.VSCODE,
  HARNESS.PI,
];

/** @typedef {"anthropic" | "openai" | "cursor" | "unknown"} IncumbentKind */

/**
 * @typedef {Object} Incumbent
 * @property {string} harness        detected harness id (e.g. "claude")
 * @property {string} providerLabel  e.g. "Anthropic", "OpenAI", "Cursor"
 * @property {string} modelLabel     e.g. "Claude Sonnet 5", "GPT-4o"
 * @property {string} modelId        stable id for pricing lookup
 * @property {string} [cliModel]     `--model` value to pin the raced `claude -p` (anthropic only)
 * @property {IncumbentKind} kind    which streaming client to use
 * @property {"live" | "estimated"} callMode
 * @property {string} [apiKey]       resolved incumbent key (live only)
 * @property {string} [apiBaseUrl]   optional OpenAI-compatible base URL
 * @property {boolean} detected      true if a real harness was found
 * @property {boolean} pricingEstimated  true if the rate is a fallback
 * @property {string} note           human-readable caveat for the label
 */

/**
 * The first harness (in probe order) that is currently routed through Fireworks
 * via `fireconnect` — i.e. the user's primary tool IS the challenger, so there
 * is no real incumbent to race. Used by the demo to branch into an honest
 * "you're already on Fireworks" prompt instead of silently fabricating an
 * estimated race against a model the user isn't calling.
 *
 * Returns the harness id, or null if no harness is fireconnect-enabled.
 *
 * @param {{ home: string }} args
 * @returns {Promise<string | null>}
 */
export async function detectActiveFireworksHarness({ home }) {
  if (!home) {
    return null;
  }
  for (const harnessId of PROBE_ORDER) {
    const on = await isHarnessEnabled(home, harnessId).catch(() => false);
    if (on) {
      return harnessId;
    }
  }
  return null;
}

/**
 * @param {{ home: string, settingsPath?: string, cwd?: string }} args
 * @returns {Promise<Incumbent>}
 */
export async function detectIncumbent({ home, settingsPath = "", cwd = "" }) {
  for (const harnessId of PROBE_ORDER) {
    const incumbent = await probeHarness(harnessId, { home, settingsPath, cwd });
    if (incumbent) {
      return incumbent;
    }
  }
  // Nothing detected at all — labeled default, clearly estimated.
  return defaultAnthropicIncumbent("no local harness config found");
}

/**
 * @param {string} harnessId
 * @param {{ home: string, settingsPath?: string, cwd?: string }} args
 * @returns {Promise<Incumbent | null>}
 */
async function probeHarness(harnessId, { home, settingsPath, cwd }) {
  if (!home) {
    return null;
  }
  const on = await isHarnessEnabled(home, harnessId).catch(() => false);
  if (on) {
    // This harness is currently routing through Fireworks — not an incumbent.
    return null;
  }

  switch (harnessId) {
    case HARNESS.CLAUDE:
      return probeClaude({ home, settingsPath, cwd });
    case HARNESS.CODEX:
      return probeCodex({ home });
    case HARNESS.OPENCODE:
      return probeOpencode({ home });
    case HARNESS.VSCODE:
      return probeVscode({ home });
    case HARNESS.CURSOR:
      // Cursor uses Cursor's own hosted backend (subscription), not a user
      // API key we can race with. Only treat it as the incumbent if Cursor is
      // actually installed on this machine.
      return cursorIncumbent({ home });
    case HARNESS.PI:
      return piIncumbent({ home });
    default:
      return null;
  }
}

async function probeClaude({ home, settingsPath, cwd = "" }) {
  const settingsFile = userSettingsPath(home, settingsPath);
  if (!existsSync(settingsFile)) {
    return null; // no Claude Code settings — can't confirm it's the active harness
  }
  const settings = await readJsonIfExists(settingsFile);
  const env = settings.env ?? {};
  const status = providerStatusFromEnv(env);
  if (status === "fireworks" || status === "firerouter") {
    return null; // on Fireworks already
  }
  // Resolve the model Claude Code would actually run — mirroring its startup
  // precedence — so the race compares against the model the user picked via
  // `/model` (persisted as the top-level `model` field), not a hardcoded guess.
  const { modelId, cliModel } = await resolveConfiguredClaudeModel({ settings, cwd });
  const { apiKey } = await resolveAnthropicKey({ home, env });
  // The incumbent drives the REAL `claude -p` tool, which authenticates via
  // the keychain / ~/.claude credentials — an explicit Anthropic API key is
  // NOT required. So as long as Claude Code is the configured harness (settings
  // exist and it isn't routed to Fireworks), the side is live. An explicit key
  // (if present) is still carried so the demo can inject it into the per-process
  // --settings file for users who paste one instead of using OAuth.
  return {
    harness: HARNESS.CLAUDE,
    providerLabel: "Anthropic",
    modelLabel: prettyClaudeLabel(modelId),
    modelId,
    cliModel,
    kind: "anthropic",
    callMode: "live",
    apiKey,
    detected: true,
    pricingEstimated: false,
    note: "Claude Code",
  };
}

/**
 * Resolve the model Claude Code would use right now, mirroring its documented
 * startup precedence (https://code.claude.com/docs/en/model-config):
 *   1. `ANTHROPIC_MODEL` env — real process env, then a settings `env` block
 *      (project/local `.claude/settings.json` over the user file).
 *   2. the top-level `model` field — where the interactive `/model` picker
 *      persists its choice (Claude Code ≥ 2.1.153); project/local over user.
 *   3. account default — unknowable from disk, so we assume Opus (the default
 *      for Max / Team Premium / Enterprise / API tiers; Pro would be Sonnet).
 *
 * The raced `claude -p` is pinned with `--model cliModel`, so this resolution —
 * not the tmp cwd it runs in — decides the model. `cliModel` is the raw value
 * (a valid `--model` argument); `modelId` is the `[1m]`-stripped form used for
 * the label and pricing lookup.
 *
 * @param {{ settings: Record<string, any>, cwd?: string }} args
 * @returns {Promise<{ modelId: string, cliModel: string, source: string }>}
 */
async function resolveConfiguredClaudeModel({ settings, cwd = "" }) {
  const projectLocal = cwd ? await readJsonIfExists(path.join(cwd, ".claude", "settings.local.json")) : {};
  const project = cwd ? await readJsonIfExists(path.join(cwd, ".claude", "settings.json")) : {};

  const envModel = (o) => {
    const v = o?.env?.ANTHROPIC_MODEL;
    return typeof v === "string" ? v.trim() : "";
  };
  const fieldModel = (o) => (typeof o?.model === "string" ? o.model.trim() : "");

  const raw =
    (process.env.ANTHROPIC_MODEL || "").trim()
    || envModel(projectLocal) || envModel(project) || envModel(settings)
    || fieldModel(projectLocal) || fieldModel(project) || fieldModel(settings)
    || "";

  if (!raw) {
    return { modelId: "claude-opus", cliModel: "opus", source: "account-default" };
  }
  // `[1m]` is Claude Code's 1M-context tag; drop it for a clean `--model` arg
  // and pricing id (the 200k vs 1M distinction is irrelevant to a demo prompt).
  const cliModel = stripClaudeCodeContextSuffix(raw);
  return { modelId: cliModel, cliModel, source: "configured" };
}

async function probeCodex({ home }) {
  const configPath = codexConfigPath(home);
  const result = await readCodexTomlIfExists(configPath);
  if (!result?.existed) {
    return null; // codex not configured
  }
  const doc = result.doc;
  const status = codexProviderStatus(doc);
  if (status === "fireworks" || status === "azure") {
    return null; // on Fireworks/Foundry already
  }
  // Codex default = OpenAI via ChatGPT login; custom = OpenAI-compatible provider.
  const rootModel = typeof doc.root.model === "string" ? doc.root.model : "";
  const modelId = rootModel || "gpt-5";
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1";
  const callMode = openaiKey ? "live" : "estimated";
  return {
    harness: HARNESS.CODEX,
    providerLabel: "OpenAI",
    modelLabel: prettyModelName(modelId) || "GPT-5",
    modelId,
    kind: "openai",
    callMode,
    apiKey: openaiKey,
    apiBaseUrl: baseUrl,
    detected: true,
    pricingEstimated: false,
    note: callMode === "live"
      ? "Codex CLI"
      : "Codex CLI (no OPENAI_API_KEY found — estimated)",
  };
}

async function probeOpencode({ home }) {
  const configPath = opencodeConfigPath(home, "");
  const file = await readRawIfExists(configPath);
  if (!file?.existed || !file.raw.trim()) {
    return null; // no opencode config
  }
  let config;
  try {
    config = JSON.parse(file.raw);
  } catch {
    return null;
  }
  const status = opencodeProviderStatus(config);
  if (status === "fireworks" || status === "azure") {
    return null;
  }
  // opencode's default provider is OpenAI; model is config.model (without provider prefix).
  const fullModel = typeof config.model === "string" ? config.model : "";
  const modelId = fullModel.includes("/") ? fullModel.split("/").pop() : (fullModel || "gpt-4o");
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  // If the model id looks like a Claude model, use the Anthropic path.
  const isClaude = /claude|sonnet|opus|haiku/i.test(modelId);
  if (isClaude && anthropicKey) {
    return {
      harness: HARNESS.OPENCODE,
      providerLabel: "Anthropic",
      modelLabel: prettyClaudeLabel(modelId),
      modelId,
      kind: "anthropic",
      callMode: "live",
      apiKey: anthropicKey,
      detected: true,
      pricingEstimated: false,
      note: "OpenCode (Anthropic)",
    };
  }
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1";
  const callMode = openaiKey ? "live" : "estimated";
  return {
    harness: HARNESS.OPENCODE,
    providerLabel: "OpenAI",
    modelLabel: prettyModelName(modelId) || "GPT-4o",
    modelId,
    kind: "openai",
    callMode,
    apiKey: openaiKey,
    apiBaseUrl: baseUrl,
    detected: true,
    pricingEstimated: false,
    note: callMode === "live" ? "OpenCode" : "OpenCode (no OPENAI_API_KEY found — estimated)",
  };
}

async function probeVscode({ home }) {
  const vscodePath = chatLanguageModelsPath({ home });
  const arr = await readChatLanguageModels(vscodePath);
  if (!Array.isArray(arr) || arr.length === 0) {
    return null;
  }
  // Best-effort: pick the first non-Fireconnect provider as the incumbent.
  // Predicate is `p && …` (not `!p || …`) so a falsy entry isn't returned as
  // the "other" provider, and so a user-named "Fireworks" entry is skipped.
  const other = arr.find((p) => p && p.name !== "Fireworks" && !/fireworks/i.test(p?.id ?? ""));
  if (!other) {
    return null; // every configured provider is Fireworks — no incumbent to race
  }
  const modelId = (other?.models?.[0]?.id) || other?.models?.[0] || "gpt-4o";
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const callMode = openaiKey ? "live" : "estimated";
  return {
    harness: HARNESS.VSCODE,
    providerLabel: "OpenAI",
    modelLabel: prettyModelName(String(modelId)) || "GPT-4o",
    modelId: String(modelId),
    kind: "openai",
    callMode,
    apiKey: openaiKey,
    apiBaseUrl: process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1",
    detected: true,
    pricingEstimated: true,
    note: "VS Code Chat (model inferred — estimated)",
  };
}

function cursorIncumbent({ home }) {
  // Only claim Cursor as the incumbent if its state DB exists (Cursor is used).
  if (!existsSync(cursorStateDbPath({ home }))) {
    return null;
  }
  return {
    harness: HARNESS.CURSOR,
    providerLabel: "Cursor",
    modelLabel: "Cursor (hosted)",
    modelId: "cursor-hosted",
    kind: "cursor",
    callMode: "estimated",
    detected: true,
    pricingEstimated: true,
    note: "Cursor uses a hosted subscription backend — per-token cost not directly comparable (estimated)",
  };
}

async function piIncumbent({ home }) {
  // Only claim Pi if its settings file exists.
  if (!existsSync(piSettingsPath(home))) {
    return null;
  }
  const { anthropicApiKey } = await readGlobalConfig(home);
  const key = resolveStoredAnthropicApiKey(anthropicApiKey);
  const envKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const apiKey = key || envKey;
  const callMode = apiKey ? "live" : "estimated";
  return {
    harness: HARNESS.PI,
    providerLabel: "Anthropic",
    modelLabel: "Claude Sonnet 5",
    modelId: "claude-sonnet-5",
    kind: "anthropic",
    callMode,
    apiKey,
    detected: true,
    pricingEstimated: false,
    note: callMode === "live" ? "Pi" : "Pi (no Anthropic API key found — estimated)",
  };
}

function defaultAnthropicIncumbent(reason) {
  return {
    harness: HARNESS.CLAUDE,
    providerLabel: "Anthropic",
    modelLabel: "Claude Opus (default)",
    modelId: "claude-opus",
    cliModel: "opus",
    kind: "anthropic",
    callMode: "estimated",
    detected: false,
    pricingEstimated: true,
    note: `Anthropic · Claude Opus (default) — ${reason}`,
  };
}

/**
 * Resolve an Anthropic API key (sk-ant-...) for a live incumbent call.
 * Source order: harness settings env (non-fireworks) > global config > ANTHROPIC_API_KEY env.
 * Exported so the harness-swap branch can reuse the same precedence when Claude
 * is currently routed through Fireworks (detection skips it) but the user still
 * wants to race Claude vs Fireworks with an explicit key.
 * @param {{ home: string, env: Record<string, string> }} args
 */
export async function resolveAnthropicKey({ home, env }) {
  const envSetting = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  if (envSetting && !isFireworksShapedKey(envSetting) && isAnthropicShapedKey(envSetting)) {
    return { apiKey: envSetting.trim(), callMode: "live" };
  }
  const { anthropicApiKey } = await readGlobalConfig(home);
  const stored = resolveStoredAnthropicApiKey(anthropicApiKey);
  if (stored && isAnthropicShapedKey(stored)) {
    return { apiKey: stored, callMode: "live" };
  }
  const envVar = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (envVar && isAnthropicShapedKey(envVar)) {
    return { apiKey: envVar, callMode: "live" };
  }
  return { apiKey: "", callMode: "estimated" };
}

export function prettyClaudeLabel(modelId) {
  const id = String(modelId).toLowerCase();
  if (id.includes("opus")) return "Claude Opus";
  if (id.includes("haiku")) return "Claude Haiku";
  if (id.includes("sonnet")) return "Claude Sonnet";
  if (id.includes("claude")) return "Claude";
  return prettyModelName(modelId) || "Claude";
}

// ── reference list pricing ───────────────────────────────────────────────────

const ANTHROPIC_PRICING_URL = "https://www.anthropic.com/pricing";
const OPENAI_PRICING_URL = "https://openai.com/api/pricing/";

/** USD per 1M tokens, list price. Embedded reference — verify at the source URL.
 * Verified 2026-07-06 against https://www.anthropic.com/pricing. */
const ANTHROPIC_LIST_RATES = {
  // Current flagship (API tab). Sonnet 5 has introductory $2/$10 pricing through
  // Aug 31 2026, reverting to $3/$15 standard; we use the standard rate so the
  // demo doesn't underestimate incumbent cost after the promo ends.
  "claude-sonnet-5": { input: 3, output: 15, label: "Claude Sonnet 5" },
  "claude-sonnet": { input: 3, output: 15, label: "Claude Sonnet" },
  // Opus 4.5–4.8 are all $5/$25. The old $15/$75 was Opus 4.1 only.
  "claude-opus-4-8": { input: 5, output: 25, label: "Claude Opus 4.8" },
  "claude-opus-4-7": { input: 5, output: 25, label: "Claude Opus 4.7" },
  "claude-opus-4-6": { input: 5, output: 25, label: "Claude Opus 4.6" },
  "claude-opus-4-5": { input: 5, output: 25, label: "Claude Opus 4.5" },
  "claude-opus-4-1": { input: 15, output: 75, label: "Claude Opus 4.1" },
  "claude-opus-4": { input: 5, output: 25, label: "Claude Opus 4" },
  "claude-opus": { input: 5, output: 25, label: "Claude Opus" },
  "claude-haiku-4-5": { input: 1, output: 5, label: "Claude Haiku 4.5" },
  "claude-haiku": { input: 1, output: 5, label: "Claude Haiku" },
  // Fable 5 (next-gen long-running agents).
  "claude-fable-5": { input: 10, output: 50, label: "Claude Fable 5" },
  "claude-fable": { input: 10, output: 50, label: "Claude Fable" },
  // Bare `/model` aliases (settings.json `model` may be just "opus"/"sonnet"/"haiku").
  "opus": { input: 5, output: 25, label: "Claude Opus" },
  "sonnet": { input: 3, output: 15, label: "Claude Sonnet" },
  "haiku": { input: 1, output: 5, label: "Claude Haiku" },
  "fable": { input: 10, output: 50, label: "Claude Fable" },
};

/** USD per 1M tokens, list price. Embedded reference — verify at the source URL.
 * Verified 2026-07-06 against https://openai.com/api/pricing/. */
const OPENAI_LIST_RATES = {
  // Current flagships.
  "gpt-5.5": { input: 5, output: 30, label: "GPT-5.5" },
  "gpt-5.4": { input: 2.5, output: 15, label: "GPT-5.4" },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, label: "GPT-5.4 mini" },
  "gpt-5": { input: 1.25, output: 10, label: "GPT-5" },
  "gpt-4o": { input: 2.5, output: 10, label: "GPT-4o" },
  "gpt-4.1": { input: 2, output: 8, label: "GPT-4.1" },
  "gpt-4o-mini": { input: 0.15, output: 0.6, label: "GPT-4o mini" },
  "o3": { input: 2, output: 8, label: "o3" },
};

const DEFAULT_ANTHROPIC_RATE = { input: 3, output: 15, label: "Claude Sonnet (reference)" };
const DEFAULT_OPENAI_RATE = { input: 2.5, output: 10, label: "GPT-4o (reference)" };

/**
 * Pick the most-specific rate-table key that the model id contains. Substring
 * matching by insertion order would let a shorter key shadow a longer one
 * (e.g. `gpt-4o` matching `gpt-4o-mini` before `gpt-4o-mini` is tried), so we
 * sort candidates by descending length and take the first hit.
 * @param {string} id lowercased model id
 * @param {Record<string, any>} table
 * @returns {string | undefined}
 */
function longestMatchKey(id, table) {
  const keys = Object.keys(table).filter((k) => id.includes(k));
  if (keys.length === 0) return undefined;
  keys.sort((a, b) => b.length - a.length);
  return keys[0];
}

/**
 * Look up list pricing for a provider + model id. Shared by incumbent detection
 * (harness-swap mode), so it derives cost the
 * same way. `provider` is "anthropic" | "openai"; anything else returns the
 * not-per-token subscription shape.
 *
 * @param {{ provider: string, modelId: string }} args
 * @returns {{ inputPerMillion: number, outputPerMillion: number, cachedInputPerMillion: number, tier: string, source: string, label: string, estimated: boolean }}
 */
export function providerListPricing({ provider, modelId }) {
  if (provider === "anthropic") {
    const id = String(modelId).toLowerCase();
    const rate = ANTHROPIC_LIST_RATES[id] ?? ANTHROPIC_LIST_RATES[longestMatchKey(id, ANTHROPIC_LIST_RATES)];
    if (rate) {
      return toRateShape(rate, ANTHROPIC_PRICING_URL, rate.input * 0.1, false);
    }
    return toRateShape(DEFAULT_ANTHROPIC_RATE, ANTHROPIC_PRICING_URL, 0.3, true);
  }
  if (provider === "openai") {
    const id = String(modelId).toLowerCase();
    const rate = OPENAI_LIST_RATES[id] ?? OPENAI_LIST_RATES[longestMatchKey(id, OPENAI_LIST_RATES)];
    if (rate) {
      return toRateShape(rate, OPENAI_PRICING_URL, rate.input * 0.5, false);
    }
    return toRateShape(DEFAULT_OPENAI_RATE, OPENAI_PRICING_URL, 1.25, true);
  }
  // cursor / unknown: not per-token comparable.
  return {
    inputPerMillion: 0,
    outputPerMillion: 0,
    cachedInputPerMillion: 0,
    tier: "subscription",
    source: "",
    label: "subscription (not per-token)",
    estimated: true,
  };
}

/**
 * Look up incumbent list pricing for a detected model.
 * @param {Incumbent} incumbent
 * @returns {{ inputPerMillion: number, outputPerMillion: number, cachedInputPerMillion: number, tier: string, source: string, label: string, estimated: boolean }}
 */
export function incumbentPricing(incumbent) {
  return providerListPricing({ provider: incumbent.kind, modelId: incumbent.modelId });
}

function toRateShape(rate, source, cachedInput, estimated) {
  return {
    inputPerMillion: rate.input,
    outputPerMillion: rate.output,
    cachedInputPerMillion: cachedInput,
    tier: "list",
    source,
    label: rate.label,
    estimated,
  };
}
