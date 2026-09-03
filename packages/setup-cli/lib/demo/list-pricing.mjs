/**
 * Reference list pricing for non-Fireworks providers (USD per 1M tokens).
 *
 * Deliberately dependency-free. These tables were part of incumbent-detect.mjs,
 * which imports every harness's config reader (Codex TOML, Cursor SQLite, VS
 * Code, OpenCode, Pi) — so anything wanting a rate lookup pulled that whole
 * graph in, including optional npm packages. The Claude cost engine and the
 * status line only need the table, so it lives here on its own; incumbent
 * detection re-exports it for its existing callers.
 */

const ANTHROPIC_PRICING_URL = "https://www.anthropic.com/pricing";
const OPENAI_PRICING_URL = "https://openai.com/api/pricing/";

/** USD per 1M tokens, list price. Embedded reference — verify at the source URL.
 * Verified 2026-08-30 against https://platform.claude.com/docs/en/about-claude/pricing
 * and https://platform.claude.com/docs/en/build-with-claude/fast-mode.
 * cacheWrite1h / cacheWrite5m are prompt-cache WRITE rates (billed at a premium
 * over base input); cacheRead is the cache HIT/read rate (steep discount). */
const ANTHROPIC_LIST_RATES = {
  // Current flagship (API tab). Sonnet 5 is $2/$10; Anthropic made the launch
  // intro rate permanent on 2026-08-10 (the planned $3/$15 increase was canceled).
  "claude-sonnet-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10, label: "Claude Sonnet 5" },
  "claude-sonnet-4-6": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15, label: "Claude Sonnet 4.6" },
  "claude-sonnet-4-5": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15, label: "Claude Sonnet 4.5" },
  "claude-sonnet": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15, label: "Claude Sonnet" },
  // Opus 4.5–4.8 and Opus 5 are all $5/$25. The old $15/$75 was Opus 4.1 / 4 only.
  "claude-opus-5": {
    input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25, label: "Claude Opus 5",
    fast: { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  },
  "claude-opus-4-8": {
    input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25, label: "Claude Opus 4.8",
    fast: { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  },
  "claude-opus-4-7": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25, label: "Claude Opus 4.7" },
  "claude-opus-4-6": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25, label: "Claude Opus 4.6" },
  "claude-opus-4-5": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25, label: "Claude Opus 4.5" },
  "claude-opus-4-1": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75, label: "Claude Opus 4.1" },
  "claude-opus-4": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75, label: "Claude Opus 4" },
  "claude-opus": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25, label: "Claude Opus" },
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5, label: "Claude Haiku 4.5" },
  "claude-haiku-3-5": { input: 0.8, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08, output: 4, label: "Claude Haiku 3.5" },
  "claude-haiku": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5, label: "Claude Haiku" },
  // Fable 5 / 5.1 (next-gen long-running agents). 5.1 keeps $10/$50 but drops
  // cache-read to $0.25/Mtok (2026-09-01); legacy Fable 5 stays at $1.00/Mtok.
  "claude-fable-5-1": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50, label: "Claude Fable 5.1" },
  "claude-fable-5": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50, label: "Claude Fable 5" },
  "claude-fable": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50, label: "Claude Fable" },
  // Bare `/model` aliases (settings.json `model` may be just "opus"/"sonnet"/"haiku").
  "opus": {
    input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25, label: "Claude Opus",
    fast: { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  },
  "sonnet": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10, label: "Claude Sonnet" },
  "haiku": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5, label: "Claude Haiku" },
  "fable": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50, label: "Claude Fable 5.1" },
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

const DEFAULT_ANTHROPIC_RATE = { input: 2, output: 10, label: "Claude Sonnet (reference)" };
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
 * (harness-swap mode) and the Claude cost engine, so both derive cost the
 * same way. `provider` is "anthropic" | "openai"; anything else returns the
 * not-per-token subscription shape.
 *
 * @param {{ provider: string, modelId: string, speed?: string }} args
 * @returns {{ inputPerMillion: number, outputPerMillion: number, cachedInputPerMillion: number, tier: string, source: string, label: string, estimated: boolean }}
 */
export function providerListPricing({ provider, modelId, speed = "standard" }) {
  if (provider === "anthropic") {
    const id = String(modelId).toLowerCase();
    const rate = ANTHROPIC_LIST_RATES[id] ?? ANTHROPIC_LIST_RATES[longestMatchKey(id, ANTHROPIC_LIST_RATES)];
    if (rate) {
      const selected = speed === "fast" && rate.fast
        ? { ...rate, ...rate.fast }
        : rate;
      return toRateShape(selected, ANTHROPIC_PRICING_URL, selected.cacheRead, false);
    }
    return toRateShape(DEFAULT_ANTHROPIC_RATE, ANTHROPIC_PRICING_URL, 0.2, true);
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

function toRateShape(rate, source, cachedInput, estimated) {
  return {
    inputPerMillion: rate.input,
    outputPerMillion: rate.output,
    cachedInputPerMillion: cachedInput,
    // Anthropic prompt-cache rates (USD/Mtok). Writes are billed at a premium
    // over base input and differ by TTL; reads at a steep discount. Fireworks
    // rates don't carry these (serverless models don't bill cache writes), so
    // they default to 0 via the demo rate shape's ?? 0 fallbacks.
    cacheWrite1hPerMillion: rate.cacheWrite1h ?? 0,
    cacheWrite5mPerMillion: rate.cacheWrite5m ?? 0,
    cacheReadPerMillion: rate.cacheRead ?? cachedInput ?? 0,
    tier: "list",
    source,
    label: rate.label,
    estimated,
  };
}
