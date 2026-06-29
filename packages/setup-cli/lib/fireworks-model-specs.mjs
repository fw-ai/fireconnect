import { stripClaudeCodeContextSuffix } from "./claude-code-context.mjs";

/** @see https://docs.fireworks.ai/serverless/pricing */
export const FIREWORKS_PRICING_DOCS_URL = "https://docs.fireworks.ai/serverless/pricing";

/** Standard serverless model metadata keyed by short ID. */
export const FIREWORKS_MODEL_SPECS = {
  "deepseek-v4-pro": {
    label: "DeepSeek V4 Pro",
    pricing: { input: 1.74, cachedInput: 0.145, output: 3.48 },
    vscode: { maxInputTokens: 1_048_576, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-flash": {
    label: "DeepSeek V4 Flash",
    pricing: { input: 0.14, cachedInput: 0.028, output: 0.28 },
    vscode: { maxInputTokens: 1_048_576, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "glm-5p2": {
    label: "GLM 5.2",
    pricing: { input: 1.40, cachedInput: 0.26, output: 4.40 },
    vscode: { maxInputTokens: 1_048_576, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p1": {
    label: "GLM 5.1",
    pricing: { input: 1.40, cachedInput: 0.26, output: 4.40 },
    vscode: { maxInputTokens: 202_752, maxOutputTokens: 25_344, vision: false, toolCalling: true },
  },
  "glm-5p1-fast": {
    label: "GLM 5.1 Fast",
    pricing: { input: 2.80, cachedInput: 0.52, output: 8.80, tier: "fast" },
    vscode: { maxInputTokens: 202_752, maxOutputTokens: 25_344, vision: false, toolCalling: true },
  },
  "glm-5p2-fast": {
    label: "GLM 5.2 Fast",
    pricing: { input: 2.10, cachedInput: 0.21, output: 6.60, tier: "fast" },
    vscode: { maxInputTokens: 1_048_576, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "kimi-k2p7-code": {
    label: "Kimi K2.7 Code",
    pricing: { input: 0.95, cachedInput: 0.19, output: 4.00 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "kimi-k2p7-code-fast": {
    label: "Kimi K2.7 Code Fast",
    pricing: { input: 1.90, cachedInput: 0.38, output: 8.00, tier: "fast" },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "kimi-k2p6": {
    label: "Kimi K2.6",
    pricing: { input: 0.95, cachedInput: 0.16, output: 4.00 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "kimi-k2p6-fast": {
    label: "Kimi K2.6 Fast",
    pricing: { input: 2.00, cachedInput: 0.30, output: 8.00, tier: "fast" },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "kimi-k2p5": {
    label: "Kimi K2.5",
    pricing: { input: 0.60, cachedInput: 0.10, output: 3.00 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "minimax-m2p5": {
    label: "MiniMax 2.5",
    pricing: { input: 0.30, cachedInput: 0.03, output: 1.20 },
    vscode: { maxInputTokens: 196_608, maxOutputTokens: 24_576, vision: false, toolCalling: true },
  },
  "minimax-m2p7": {
    label: "MiniMax 2.7",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    vscode: { maxInputTokens: 196_608, maxOutputTokens: 24_576, vision: false, toolCalling: true },
  },
  "minimax-m3": {
    label: "MiniMax M3",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    vscode: { maxInputTokens: 512_000, maxOutputTokens: 64_000, vision: true, toolCalling: true },
  },
  "qwen3p7-plus": {
    label: "Qwen 3.7 Plus",
    pricing: { input: 0.40, cachedInput: 0.08, output: 1.60 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
    api: { contextLength: 262_144, supportsImageInput: true },
  },
  "qwen3p6-plus": {
    label: "Qwen 3.6 Plus",
    pricing: { input: 0.50, cachedInput: 0.10, output: 3.00 },
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "gpt-oss-120b": {
    label: "GPT-OSS 120B",
    pricing: { input: 0.15, cachedInput: 0.015, output: 0.60 },
    vscode: { maxInputTokens: 131_072, maxOutputTokens: 16_384, vision: false, toolCalling: true },
  },
  "gpt-oss-20b": {
    label: "GPT-OSS 20B",
    pricing: { input: 0.07, cachedInput: 0.035, output: 0.30 },
    vscode: { maxInputTokens: 131_072, maxOutputTokens: 16_384, vision: false, toolCalling: false },
  },
  "nemotron-3-ultra-nvfp4": {
    label: "NVIDIA Nemotron 3 Ultra NVFP4",
    vscode: { maxInputTokens: 262_144, maxOutputTokens: 32_768, vision: false, toolCalling: true },
  },
};

export const ROUTER_SPEC_ALIASES = {
  "glm-latest": "glm-5p2",
  "glm-fast-latest": "glm-5p2-fast",
  "kimi-latest": "kimi-k2p6",
  "kimi-fast-latest": "kimi-k2p6-fast",
  "kimi-k2p6-turbo": "kimi-k2p6-fast",
};

export const DEFAULT_VSCODE_MODEL_METADATA = {
  vision: false,
  toolCalling: true,
};

export function specShortIdFromModelRef(modelRef) {
  if (!modelRef) {
    return "";
  }
  const stripped = stripClaudeCodeContextSuffix(modelRef);
  return stripped.split("/").at(-1) ?? stripped;
}

export function resolveSpecSlug(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  return ROUTER_SPEC_ALIASES[shortId] ?? shortId;
}

export function lookupModelSpec(modelRef) {
  return FIREWORKS_MODEL_SPECS[resolveSpecSlug(modelRef)] ?? null;
}

export function lookupVscodeModelMetadata(modelRef) {
  return lookupModelSpec(modelRef)?.vscode ?? DEFAULT_VSCODE_MODEL_METADATA;
}

export const MODEL_API_OVERRIDES = Object.fromEntries(
  Object.entries(FIREWORKS_MODEL_SPECS)
    .filter(([, spec]) => spec.api)
    .map(([slug, spec]) => [`accounts/fireworks/models/${slug}`, spec.api]),
);
