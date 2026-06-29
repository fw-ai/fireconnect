import process from "node:process";

// Fireworks AI models are available as first-party models inside Microsoft
// Foundry (formerly Azure AI Foundry). Foundry exposes an OpenAI-compatible
// inference API, so harnesses that speak OpenAI (OpenCode) can route through a
// Foundry project endpoint using an Azure API key instead of the Fireworks
// gateway. See: https://docs.fireworks.ai/ecosystem/integrations/azure-foundry

// Default Foundry deployment name for the GLM model published by Fireworks.
// Foundry model ids are the *deployment* name chosen at deploy time, which
// defaults to the catalog model name without the `fireworks-ai/` publisher
// prefix (e.g. `FW-GLM-5.1`, `FW-MiniMax-M2.5`). Override with --main to match
// whatever you named your deployment.
export const DEFAULT_AZURE_MODEL = "FW-GLM-5.1";

// npm adapter OpenCode loads for any OpenAI-compatible provider.
export const AZURE_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

// Display name shown by the harness for the Azure-backed provider.
export const AZURE_PROVIDER_LABEL = "Fireworks on Microsoft Foundry";

// Environment variable / reference used when the Azure key is provided via the
// environment rather than written literally into a config file.
export const AZURE_API_KEY_ENV = "AZURE_API_KEY";
export const AZURE_API_KEY_ENV_REF = `{env:${AZURE_API_KEY_ENV}}`;

export const MISSING_AZURE_BASE_URL_MESSAGE =
  "No Azure endpoint found. Pass --base-url with your Microsoft Foundry project endpoint "
  + "(e.g. https://<resource>.services.ai.azure.com).";

export const MISSING_AZURE_API_KEY_MESSAGE =
  `No Azure API key found. Export ${AZURE_API_KEY_ENV} or pass --api-key with your Foundry key.`;

/**
 * Heuristic: does this URL look like a Microsoft Foundry / Azure AI endpoint?
 * @param {string} url
 */
export function isAzureBaseUrl(url) {
  return typeof url === "string" && /\.azure\.com(?::\d+)?(\/|$)/i.test(url.trim());
}

/**
 * Normalize a Foundry endpoint to its OpenAI-compatible base URL.
 *
 * Foundry's OpenAI-compatible API (`/chat/completions`, which the
 * `@ai-sdk/openai-compatible` adapter appends to the base) always lives at the
 * **resource root** — `https://<resource>.services.ai.azure.com/openai/v1` —
 * never under the project path. So for any Azure host we reduce the URL to its
 * origin and append `/openai/v1`, which means all of these resolve correctly:
 *
 *   - bare resource root            (`.../`)
 *   - the portal "project endpoint" (`.../api/projects/<name>`)
 *   - the Foundry Models route      (`.../models`)
 *   - an already-correct base       (`.../openai/v1`)
 *
 * For non-Azure hosts (custom gateways / APIM proxies) we stay conservative:
 * preserve the supplied path and only ensure an `/openai/v1` suffix.
 *
 * @param {string} endpoint
 * @returns {string}
 */
export function normalizeAzureBaseUrl(endpoint) {
  const raw = String(endpoint ?? "").trim();
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }

  if (parsed && isAzureBaseUrl(raw)) {
    return `${parsed.origin}/openai/v1`;
  }

  let url = raw.replace(/\/+$/, "");
  if (/\/openai\/v\d+$/i.test(url)) {
    return url;
  }
  url = url.replace(/\/models$/i, "").replace(/\/openai$/i, "");
  return `${url}/openai/v1`;
}

/**
 * Resolve the Azure API key and how it should be stored for `<harness> on`.
 *
 * Resolution order:
 *   1. explicit `--api-key` (stored literally)
 *   2. existing stored key on a previous `on` (reused as-is)
 *   3. the key configured via `fireconnect configure` (stored literally)
 *   4. `AZURE_API_KEY` environment variable (stored as the {env:...} reference)
 *
 * @param {{
 *   apiKey?: string,
 *   apiKeyFromFlag?: boolean,
 *   configuredApiKey?: string,
 *   getExistingKey?: () => Promise<string>,
 * }} args
 * @returns {Promise<{ apiKey: string, apiKeyFromFlag: boolean, reusedExistingKey: boolean }>}
 */
export async function resolveAzureOnApiKey({
  apiKey = "",
  apiKeyFromFlag = false,
  configuredApiKey = "",
  getExistingKey,
} = {}) {
  if (apiKeyFromFlag && apiKey.trim()) {
    return { apiKey: apiKey.trim(), apiKeyFromFlag: true, reusedExistingKey: false };
  }

  if (getExistingKey) {
    const existing = (await getExistingKey()) ?? "";
    if (existing) {
      return {
        apiKey: existing,
        apiKeyFromFlag: existing !== AZURE_API_KEY_ENV_REF,
        reusedExistingKey: true,
      };
    }
  }

  if (configuredApiKey && configuredApiKey !== AZURE_API_KEY_ENV_REF) {
    return { apiKey: configuredApiKey.trim(), apiKeyFromFlag: true, reusedExistingKey: false };
  }

  if (process.env[AZURE_API_KEY_ENV]?.trim()) {
    return { apiKey: AZURE_API_KEY_ENV_REF, apiKeyFromFlag: false, reusedExistingKey: false };
  }

  throw new Error(MISSING_AZURE_API_KEY_MESSAGE);
}

/**
 * Resolve the {env:AZURE_API_KEY} reference to the real environment value.
 * @param {string} storedKey
 */
export function effectiveAzureApiKey(storedKey) {
  if (!storedKey) {
    return "";
  }
  if (storedKey === AZURE_API_KEY_ENV_REF) {
    return process.env[AZURE_API_KEY_ENV]?.trim() ?? "";
  }
  return storedKey;
}
