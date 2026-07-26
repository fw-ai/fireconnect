import process from "node:process";
import {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_PROVIDER_TABLE,
} from "./constants.mjs";

/** @typedef {"literal" | "env-reference" | "missing"} DeepagentsAuthMode */

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 * @returns {DeepagentsAuthMode}
 */
export function deepagentsAuthMode(doc) {
  const provider = doc.tables[DEEPAGENTS_PROVIDER_TABLE] ?? {};
  if (provider.api_key_env === DEEPAGENTS_API_KEY_ENV) {
    return "env-reference";
  }
  if (typeof provider.api_key === "string" && provider.api_key.trim()) {
    return "literal";
  }
  return "missing";
}

/**
 * @param {{
 *   routingApiKey: string,
 *   mode: DeepagentsAuthMode,
 *   envApiKey?: string,
 * }} input
 */
export function resolveDeepagentsEffectiveApiKey({
  routingApiKey,
  mode,
  envApiKey = process.env.FIREWORKS_API_KEY ?? "",
}) {
  switch (mode) {
    case "literal":
      return routingApiKey;
    case "env-reference":
      return routingApiKey === DEEPAGENTS_API_KEY_ENV ? envApiKey : routingApiKey;
    case "missing":
      return "";
    default: {
      const _exhaustive = mode;
      return _exhaustive;
    }
  }
}

/**
 * @param {{
 *   mode: DeepagentsAuthMode,
 *   envApiKey?: string,
 *   routingApiKey?: string,
 * }} input
 */
export function resolveDeepagentsApiKey({
  mode,
  routingApiKey = "",
  envApiKey = process.env.FIREWORKS_API_KEY ?? "",
}) {
  if (mode === "env-reference") {
    return envApiKey.trim();
  }
  if (mode === "missing") {
    return "";
  }
  return routingApiKey.trim();
}
