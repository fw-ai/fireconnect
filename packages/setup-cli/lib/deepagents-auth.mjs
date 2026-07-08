import process from "node:process";
import {
  DEEPAGENTS_API_KEY_ENV,
  DEEPAGENTS_PROVIDER_TABLE,
} from "./deepagents-constants.mjs";

/** @typedef {"literal" | "env-reference"} DeepagentsAuthMode */

/**
 * @param {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }} doc
 * @returns {DeepagentsAuthMode}
 */
export function deepagentsAuthMode(doc) {
  const provider = doc.tables[DEEPAGENTS_PROVIDER_TABLE] ?? {};
  return provider.api_key_env === DEEPAGENTS_API_KEY_ENV ? "env-reference" : "literal";
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
  if (mode === "literal") {
    return routingApiKey;
  }
  return routingApiKey === DEEPAGENTS_API_KEY_ENV ? envApiKey : routingApiKey;
}

/**
 * @param {{
 *   apiKey: string,
 *   effectiveKey?: string,
 *   envApiKey?: string,
 * }} input
 */
export function resolveDeepagentsOnAuth({
  apiKey,
  effectiveKey = "",
  envApiKey = process.env.FIREWORKS_API_KEY ?? "",
}) {
  const mode = "env-reference";
  const effectiveApiKey = effectiveKey.trim()
    || resolveDeepagentsEffectiveApiKey({
      routingApiKey: apiKey,
      mode,
      envApiKey: envApiKey.trim(),
    });

  return {
    routingApiKey: apiKey,
    mode,
    effectiveApiKey,
  };
}

/**
 * Resolve the Fireworks API key for FireConnect-managed env-reference routing.
 *
 * @param {{
 *   mode: DeepagentsAuthMode,
 *   envApiKey?: string,
 * }} input
 */
export function resolveDeepagentsApiKey({
  mode,
  envApiKey = process.env.FIREWORKS_API_KEY ?? "",
}) {
  if (mode === "env-reference") {
    return envApiKey.trim();
  }
  return "";
}
