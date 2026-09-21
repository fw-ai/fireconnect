import {
  isClaudeNativeModel,
  isClaudeNativeSlotAlias,
  isFirerouterModel,
  normalizeModelId,
} from "../../fireworks/model-id.mjs";

const SLOT_FLAG_NAMES = Object.freeze({
  opus: "--opus",
  sonnet: "--sonnet",
  haiku: "--haiku",
  fable: "--fable",
  subagent: "--subagent",
});

/** Tier slot flags are retired; only `--model` adds a Fireworks row to the picker. */
export function assertNoClaudeSlotFlags(ctx) {
  for (const [slot, flag] of Object.entries(SLOT_FLAG_NAMES)) {
    const value = ctx[slot]?.trim();
    if (value) {
      throw new Error(
        `${flag} is not supported. Anthropic tier slots stay on Claude Code defaults. `
          + "Use `--model <id>` to add a Fireworks model to the /model picker.",
      );
    }
  }
}

/**
 * @param {{ main?: string }} ctx
 * @returns {string | null} normalized model id, or null when unset / native
 */
export function claudeExtraPickerModelFromCtx(ctx) {
  const raw = ctx.main?.trim();
  if (!raw || isClaudeNativeSlotAlias(raw)) {
    return null;
  }
  const normalized = normalizeModelId(raw);
  if (isClaudeNativeModel(normalized)) {
    return null;
  }
  return normalized;
}

/** Bare `firerouter` via `--model firerouter` enables FireRouter routing headers. */
export function claudeBareFirerouterRequested(extraPickerModel) {
  return Boolean(extraPickerModel && isFirerouterModel(extraPickerModel));
}
