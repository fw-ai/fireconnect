import {
  fireworksModelSlug,
  isGatewayAnthropicSlot,
  isFirerouterGatewayPattern,
} from "../../fireworks/model-id.mjs";
import { lookupFireworksModelLimits } from "../../fireworks/model-specs.mjs";
import { loadServerlessCatalog } from "../../fireworks/models.mjs";

export const CLAUDE_CODE_1M_CONTEXT_THRESHOLD = 1_000_000;

const CLAUDE_CODE_1M_SUFFIX = "[1m]";

export function stripClaudeCodeContextSuffix(modelId) {
  if (typeof modelId !== "string") {
    return modelId;
  }
  return modelId.replace(/\[1m\]$/i, "");
}

export function modelQualifiesForClaudeCode1mContext(modelId) {
  if (!modelId) {
    return false;
  }
  if (isGatewayAnthropicSlot(modelId)) {
    return true;
  }
  if (isFirerouterGatewayPattern(modelId)) {
    return true;
  }
  const slug = fireworksModelSlug(modelId);
  if (!slug) {
    return false;
  }
  const { contextWindow } = lookupFireworksModelLimits(modelId);
  return contextWindow >= CLAUDE_CODE_1M_CONTEXT_THRESHOLD;
}

export function claudeCodeModelId(modelId) {
  if (!modelId || !modelQualifiesForClaudeCode1mContext(modelId)) {
    return modelId;
  }
  return `${stripClaudeCodeContextSuffix(modelId)}${CLAUDE_CODE_1M_SUFFIX}`;
}

export function applyClaudeCodeContextPolicy(env, mapping) {
  const next = { ...env };
  if (Object.values(mapping).some((modelId) => modelQualifiesForClaudeCode1mContext(modelId))) {
    delete next.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  } else {
    next.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
  }
  return next;
}

/**
 * Hydrate the serverless catalog cache before rewriting Claude Code settings so
 * 1M-context detection uses live context lengths (including router bases).
 * Best-effort: static spec fallbacks still apply when the network is down.
 * @param {{ apiKey?: string, keyType?: string }} opts
 */
export async function ensureCatalogForClaudeCodeContext({ apiKey = "", keyType = "" } = {}) {
  const trimmed = apiKey?.trim();
  if (!trimmed || keyType === "firepass") {
    return;
  }
  try {
    await loadServerlessCatalog({ apiKey: trimmed, keyType });
  } catch {
    /* lookupFireworksModelLimits falls back to cache + static specs */
  }
}
