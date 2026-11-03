import { AUTO_MODEL_ID, resolveLiveRouterBaseModelId } from "./model-specs.mjs";

/**
 * Shared reasoning-effort ladders for Fireworks models, consumed by every
 * harness that advertises effort tiers (Codex `supported_reasoning_levels`,
 * Copilot desktop `supported_reasoning_efforts`). Harness-specific
 * presentation (catalog entry shapes, JSON columns) stays in each harness.
 */

export const REASONING_DESCRIPTIONS = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  max: "Extra high reasoning depth for complex problems",
};

/** Every reasoning-effort level Fireworks models accept, in picker order. */
export const ALL_REASONING_EFFORTS = Object.freeze(Object.keys(REASONING_DESCRIPTIONS));

function reasoningLevel(effort) {
  return { effort, description: REASONING_DESCRIPTIONS[effort] };
}

/** Standard ladder: every reasoning model offers at least these three tiers. */
const STANDARD_LEVELS = [reasoningLevel("low"), reasoningLevel("medium"), reasoningLevel("high")];
/** Ladder for models that also expose the deepest tier. */
const MAX_LEVELS = [...STANDARD_LEVELS, reasoningLevel("max")];
/**
 * Ladder for the `auto` mix, which honors every effort through `max`. `xhigh`
 * is Auto-only (FireRouter routes it between `high` and `max`), so it stays
 * out of the shared descriptions and {@link ALL_REASONING_EFFORTS}.
 */
const AUTO_LEVELS = [
  ...STANDARD_LEVELS,
  { effort: "xhigh", description: "Even greater reasoning depth for harder problems" },
  reasoningLevel("max"),
];

/*
 * Per-model reasoning tiers offered in harness effort pickers.
 *
 * A picker only renders a selectable Effort row when a model advertises more than
 * one tier, so every entry exposes the full low/medium/high ladder (the Fireworks
 * API accepts these values for reasoning models) and adds `max` only where the
 * docs confirm it (GLM 5.3 incl. Flash and DeepSeek V4.1 Flash). Some models
 * may treat the lower tiers as a no-op; the tier is still selectable rather
 * than absent.
 *
 * Nexus never sets a default effort: the table carries ladders only, and
 * each harness applies its own default.
 */
export const MODEL_REASONING = {
  [AUTO_MODEL_ID]: {
    levels: AUTO_LEVELS,
  },
  "accounts/fireworks/models/glm-5p3": {
    levels: MAX_LEVELS,
  },
  "accounts/fireworks/models/glm-5p3-fast": {
    levels: MAX_LEVELS,
  },
  "accounts/fireworks/models/glm-5p3-flash": {
    levels: MAX_LEVELS,
  },
  // DeepSeek V4.1 Flash replaces both V4 Flash and V4 Pro on serverless.
  "accounts/fireworks/models/deepseek-v4p1-flash": {
    levels: MAX_LEVELS,
  },
  "accounts/fireworks/models/minimax-m3p1-flash": {
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/muse-spark-open": {
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/minimax-m2p7": {
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/minimax-m3": {
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/gpt-oss-120b": {
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/nemotron-3-ultra-nvfp4": {
    levels: STANDARD_LEVELS,
  },
  "accounts/fireworks/models/qwen3p7-plus": {
    levels: STANDARD_LEVELS,
  },
  // Kimi K3 / K3 Fast (current Kimi generation; supersedes kimi-k2p6 / kimi-k2p7-code).
  "accounts/fireworks/models/kimi-k3": {
    levels: STANDARD_LEVELS,
  },
};

const DEFAULT_REASONING = {
  levels: STANDARD_LEVELS,
};

/**
 * Resolve the reasoning config for a model. Tries the exact full ref, then the
 * ref's live base model from the warmed serverless catalog mapping (so routers
 * and tier/regional variants such as `glm-5p3-fast` or `glm-5p3-flash-us`
 * inherit their family's ladder from the catalog instead of string parsing),
 * then — because the live catalog returns versioned slugs (e.g.
 * `deepseek-v4p1-flash-1017`) while {@link MODEL_REASONING} is keyed by the
 * unversioned base ref — a trailing pure-numeric version
 * suffix and retries. Falls back to {@link DEFAULT_REASONING}.
 * @param {string} modelRef full model ref, e.g. `accounts/fireworks/models/glm-5p3`
 * @returns {{ levels: object[] }}
 */
function modelReasoningEntry(modelRef) {
  const candidates = [modelRef];
  const baseModelId = resolveLiveRouterBaseModelId(modelRef);
  if (baseModelId) {
    candidates.push(baseModelId);
  }
  for (const candidate of candidates) {
    if (MODEL_REASONING[candidate]) {
      return MODEL_REASONING[candidate];
    }
    const baseRef = candidate.replace(/-\d+$/, "");
    if (baseRef !== candidate && MODEL_REASONING[baseRef]) {
      return MODEL_REASONING[baseRef];
    }
  }
  return undefined;
}

/**
 * Whether {@link MODEL_REASONING} lists this model (exact ref, live router
 * base, or version-stripped base), without the {@link DEFAULT_REASONING}
 * fallback {@link reasoningConfigFor} applies to every other model.
 * @param {string} modelRef full model ref
 * @returns {boolean}
 */
export function hasModelReasoningLevels(modelRef) {
  return modelReasoningEntry(modelRef) !== undefined;
}

export function reasoningConfigFor(modelRef) {
  return modelReasoningEntry(modelRef) ?? DEFAULT_REASONING;
}

/**
 * Effort names for a model, in picker order — the shape harnesses without a
 * level-descriptions column want (e.g. Copilot desktop
 * `supported_reasoning_efforts`).
 * @param {string} modelRef full model ref
 * @returns {string[]}
 */
export function reasoningEffortNamesFor(modelRef) {
  return reasoningConfigFor(modelRef).levels.map((level) => level.effort);
}
