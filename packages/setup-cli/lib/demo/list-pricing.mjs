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
 * Verified 2026-07-06 against https://openai.com/api/pricing/.
 * GPT-5.5 / 5.6 / 6-Astra short tiers + the 272K long-context tier verified
 * against the same card via firerouter/litellm.yaml (developers.openai.com
 * pricing, 2026-08-02; Astra 2026-09-03): above 272K input tokens the full
 * request bills at ~2x input/cache and 1.5x output. OpenAI prompt-cache reads
 * bill at 0.1x input and cache writes at 1.25x input on these models (single
 * automatic cache — no 5m/1h TTL split, so both write fields carry one rate).
 * Older rows without explicit cache fields keep the legacy 0.5x cached-input
 * fallback. */
const OPENAI_LONG_CONTEXT_INPUT_TOKENS = 272_000;

const OPENAI_LIST_RATES = {
  // GPT-6 Astra (OpenAI 2026-09-03). Short-context rates below; the `long`
  // tier applies to the FULL request once input exceeds 272K tokens.
  // Aliases (gpt-6 / gpt6 / astra, per firerouter/litellm.yaml) live in
  // OPENAI_ALIASES so there is one rate row to keep correct.
  "gpt-6-astra": {
    input: 10, cacheRead: 1.0, cacheWrite5m: 12.5, cacheWrite1h: 12.5, output: 50,
    label: "GPT-6 Astra",
    long: { input: 20, cacheRead: 2.0, cacheWrite5m: 25, cacheWrite1h: 25, output: 75 },
  },
  // GPT-5.6 family (sol / terra / luna trade price for quality). Same 272K
  // long-context tiering as Astra.
  "gpt-5.6-sol": {
    input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 6.25, output: 30,
    label: "GPT-5.6 Sol",
    long: { input: 10, cacheRead: 1.0, cacheWrite5m: 12.5, cacheWrite1h: 12.5, output: 45 },
  },
  "gpt-5.6-terra": {
    input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5, output: 12,
    label: "GPT-5.6 Terra",
    long: { input: 4, cacheRead: 0.4, cacheWrite5m: 5.0, cacheWrite1h: 5.0, output: 18 },
  },
  "gpt-5.6-luna": {
    input: 0.2, cacheRead: 0.02, cacheWrite5m: 0.25, cacheWrite1h: 0.25, output: 1.2,
    label: "GPT-5.6 Luna",
    long: { input: 0.4, cacheRead: 0.04, cacheWrite5m: 0.5, cacheWrite1h: 0.5, output: 1.8 },
  },
  // Current flagships.
  "gpt-5.5": {
    input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 6.25, output: 30,
    label: "GPT-5.5",
    long: { input: 10, cacheRead: 1.0, cacheWrite5m: 12.5, cacheWrite1h: 12.5, output: 45 },
  },
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

/** Short ids that name a table row without being one (gpt-6 / gpt6 / astra per firerouter/litellm.yaml). */
const OPENAI_ALIASES = {
  "gpt-6": "gpt-6-astra",
  gpt6: "gpt-6-astra",
  astra: "gpt-6-astra",
};

/**
 * Resolve an id to its rate-table key, or null when it names no known row.
 * Exact id first, then the last `/`-separated segment (provider prefixes like
 * `openai/gpt-6-astra` and router paths like `firerouter/astra` carry the
 * model id last), then explicit aliases. Each candidate is also tried without
 * Claude Code's `[1m]` context tag and without an Anthropic snapshot date
 * (`-YYYYMMDD`), both of which real transcript ids carry. Deliberately NOT
 * substring matching: `gpt-5.6` must not inherit `gpt-5` rates and `o3-mini`
 * must not inherit `o3` — an unknown id stays unpriced (or
 * estimated-reference upstream) rather than borrowing a shorter key's dollars.
 * @param {string} modelId
 * @param {Record<string, any>} table
 * @param {Record<string, string>} [aliases]
 * @returns {string | null}
 */
function strictTableKey(modelId, table, aliases = {}) {
  const id = String(modelId ?? "").toLowerCase().trim();
  const candidates = [id];
  const untagged = id.replace(/\[1m\]$/i, "");
  if (untagged !== id) {
    candidates.push(untagged);
  }
  // Anthropic snapshot dates are exactly YYYYMMDD with a real month/day, so
  // `claude-sonnet-5-20250901` resolves to its base row while an id that
  // merely ends in digits (e.g. a future `claude-opus-9`) never strips down
  // to a shorter key's rates.
  const undated = untagged.replace(/-(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/, "");
  if (undated !== untagged) {
    candidates.push(undated);
  }
  for (const candidate of candidates) {
    if (table[candidate]) {
      return candidate;
    }
    const slug = candidate.split("/").pop() ?? candidate;
    if (table[slug]) {
      return slug;
    }
    const aliased = aliases[slug] ?? aliases[candidate];
    if (aliased && table[aliased]) {
      return aliased;
    }
  }
  return null;
}

/**
 * Whether an id resolves to a real OpenAI list-price row (not the estimated
 * fallback). Single home for OpenAI id matching so the Claude cost engine and
 * the status line classify ids the same way.
 * @param {string} modelId
 * @returns {boolean}
 */
export function isOpenAiPricedModelId(modelId) {
  return strictTableKey(modelId, OPENAI_LIST_RATES, OPENAI_ALIASES) !== null;
}

/**
 * Look up list pricing for a provider + model id. Shared by incumbent detection
 * (harness-swap mode) and the Claude cost engine, so both derive cost the
 * same way. `provider` is "anthropic" | "openai"; anything else returns the
 * not-per-token subscription shape.
 *
 * OpenAI tiers GPT-5.5 / 5.6 / 6-Astra by input length: pass `inputTokens` and
 * requests at or above 272K input resolve to the long-context tier (2x
 * input/cache, 1.5x output, applied to the full request). Omitted (or below
 * threshold) resolves to the short tier, so pre-run estimates without a token
 * count keep the previous behavior.
 *
 * @param {{ provider: string, modelId: string, speed?: string, inputTokens?: number | null }} args
 * @returns {{ inputPerMillion: number, outputPerMillion: number, cachedInputPerMillion: number, tier: string, contextTier: string, source: string, label: string, estimated: boolean }}
 */
export function providerListPricing({ provider, modelId, speed = "standard", inputTokens = null }) {
  if (provider === "anthropic") {
    const key = strictTableKey(modelId, ANTHROPIC_LIST_RATES);
    const rate = key ? ANTHROPIC_LIST_RATES[key] : null;
    if (rate) {
      const selected = speed === "fast" && rate.fast
        ? { ...rate, ...rate.fast }
        : rate;
      return toRateShape(selected, ANTHROPIC_PRICING_URL, selected.cacheRead, false);
    }
    return toRateShape(DEFAULT_ANTHROPIC_RATE, ANTHROPIC_PRICING_URL, 0.2, true);
  }
  if (provider === "openai") {
    const key = strictTableKey(modelId, OPENAI_LIST_RATES, OPENAI_ALIASES);
    const rate = key ? OPENAI_LIST_RATES[key] : null;
    if (rate) {
      const useLong = rate.long
        && Number.isFinite(inputTokens)
        && inputTokens >= OPENAI_LONG_CONTEXT_INPUT_TOKENS;
      const selected = useLong ? { ...rate, ...rate.long } : rate;
      return toRateShape(
        selected,
        OPENAI_PRICING_URL,
        selected.cacheRead ?? selected.input * 0.5,
        false,
        useLong ? "long" : "standard",
      );
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

function toRateShape(rate, source, cachedInput, estimated, contextTier = "standard") {
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
    // OpenAI long-context tier ("long") vs every other lookup ("standard").
    contextTier,
    source,
    label: rate.label,
    estimated,
  };
}
