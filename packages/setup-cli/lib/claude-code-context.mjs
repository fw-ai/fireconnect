export const CLAUDE_CODE_1M_CONTEXT_MODELS = new Set([
  "deepseek-v4-pro",
  "glm-5p2",
  "glm-latest",
]);

const CLAUDE_CODE_1M_SUFFIX = "[1m]";

export function stripClaudeCodeContextSuffix(modelId) {
  if (typeof modelId !== "string") {
    return modelId;
  }
  return modelId.replace(/\[1m\]$/i, "");
}

function modelShortId(modelId) {
  const stripped = stripClaudeCodeContextSuffix(modelId);
  if (!stripped) {
    return "";
  }
  return stripped.split("/").at(-1) ?? stripped;
}

function needsClaudeCode1mContext(modelId) {
  return CLAUDE_CODE_1M_CONTEXT_MODELS.has(modelShortId(modelId));
}

export function claudeCodeModelId(modelId) {
  if (!modelId || !needsClaudeCode1mContext(modelId)) {
    return modelId;
  }
  return `${stripClaudeCodeContextSuffix(modelId)}${CLAUDE_CODE_1M_SUFFIX}`;
}

export function applyClaudeCodeContextPolicy(env, mapping) {
  const next = { ...env };
  if (needsClaudeCode1mContext(mapping.main)) {
    delete next.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  } else {
    next.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
  }
  return next;
}
