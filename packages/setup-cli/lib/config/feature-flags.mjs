import { Buffer } from "node:buffer";

import { grpcWebCall, pbDecode, pbString, pbStringAt } from "../auth/grpc-web.mjs";
import { GATEWAY_GRPC_WEB_URL } from "../keys/mint-api-key.mjs";
import { FIREWORKS_GATEWAY_URL } from "../fireworks/models.mjs";

/**
 * @typedef {Object} FeatureFlag
 * @property {string} name
 * @property {string} value
 */

/**
 * @typedef {Object} FeatureFlagLookupResult
 * @property {boolean} enabled
 * @property {boolean} unavailable  True when the control plane could not be queried.
 * @property {string} reason
 */

/**
 * @typedef {Object} FeatureFlagListResult
 * @property {boolean} ok
 * @property {FeatureFlag[]} flags
 * @property {string} reason
 */

const listFailed = (reason) => ({ ok: false, flags: [], reason });

/**
 * @param {string} accountId
 * @param {"grpc" | "rest"} style
 */
function normalizeAccountParent(accountId, style) {
  const trimmed = accountId.trim();
  if (style === "grpc") {
    return trimmed.startsWith("accounts/") ? trimmed : `accounts/${trimmed}`;
  }
  return trimmed.startsWith("accounts/") ? trimmed.slice("accounts/".length) : trimmed;
}

/**
 * @param {string | undefined | null} value
 */
export function isFeatureFlagValueActive(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized !== "" && normalized !== "false" && normalized !== "0";
}

/**
 * @param {FeatureFlag[]} flags
 * @param {string} flagId
 * @returns {FeatureFlag | null}
 */
export function findFeatureFlag(flags, flagId) {
  const suffix = `/featureFlags/${flagId}`;
  for (const flag of flags) {
    const name = flag.name ?? "";
    if (name.endsWith(suffix)) {
      return flag;
    }
  }
  return null;
}

/**
 * @param {Buffer} message
 * @returns {FeatureFlag[]}
 */
export function decodeFeatureFlagsMessage(message) {
  const fields = pbDecode(message);
  const entries = fields.get(1) ?? [];
  return entries
    .filter((entry) => Buffer.isBuffer(entry))
    .map((entry) => {
      const decoded = pbDecode(entry);
      return {
        name: pbStringAt(decoded, 1),
        value: pbStringAt(decoded, 2),
      };
    });
}

/**
 * @param {FeatureFlagListResult} listed
 * @param {string} flagId
 * @returns {FeatureFlagLookupResult | null}
 */
function lookupFromListed(listed, flagId) {
  if (!listed.ok) {
    return null;
  }
  const flag = findFeatureFlag(listed.flags, flagId);
  return {
    enabled: flag ? isFeatureFlagValueActive(flag.value) : false,
    unavailable: false,
    reason: "",
  };
}

/**
 * List feature flags for an account via gRPC-web (same surface as browser sign-in).
 * @param {string} accountId
 * @param {string} apiKey
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<FeatureFlagListResult>}
 */
export async function listFeatureFlags(accountId, apiKey, { baseUrl = GATEWAY_GRPC_WEB_URL } = {}) {
  const parent = normalizeAccountParent(accountId, "grpc");
  const request = pbString(1, parent);
  let response;
  try {
    response = await grpcWebCall(baseUrl, "ListFeatureFlags", request, { apiKey });
  } catch (error) {
    return listFailed(error instanceof Error ? error.message : "network error");
  }
  if (response.status !== 0 || !response.message) {
    return listFailed(response.detail || `control plane status ${response.status}`);
  }
  try {
    return { ok: true, flags: decodeFeatureFlagsMessage(response.message), reason: "" };
  } catch (error) {
    return listFailed(error instanceof Error ? error.message : "invalid feature flag response");
  }
}

/**
 * REST fallback for when api.fireworks.ai exposes ListFeatureFlags publicly.
 * @param {string} accountId
 * @param {string} apiKey
 * @param {{ apiBaseUrl?: string }} [options]
 * @returns {Promise<FeatureFlagListResult>}
 */
export async function listFeatureFlagsRest(accountId, apiKey, { apiBaseUrl = FIREWORKS_GATEWAY_URL } = {}) {
  const parent = normalizeAccountParent(accountId, "rest");
  let response;
  try {
    response = await fetch(`${apiBaseUrl}/v1/accounts/${parent}/featureFlags`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    return listFailed(error instanceof Error ? error.message : "network error");
  }
  if (response.status === 404) {
    return listFailed("not found");
  }
  if (!response.ok) {
    return listFailed(`HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return listFailed("invalid JSON");
  }
  const rawFlags = payload.featureFlags ?? payload.feature_flags ?? [];
  if (!Array.isArray(rawFlags)) {
    return listFailed("unexpected response shape");
  }
  const flags = rawFlags
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      name: String(entry.name ?? ""),
      value: String(entry.value ?? ""),
    }));
  return { ok: true, flags, reason: "" };
}

/**
 * @param {string} accountId
 * @param {string} apiKey
 * @param {string} flagId
 * @param {{ grpcBaseUrl?: string, apiBaseUrl?: string }} [options]
 * @returns {Promise<FeatureFlagLookupResult>}
 */
export async function isAccountFeatureFlagEnabled(
  accountId,
  apiKey,
  flagId,
  { grpcBaseUrl = GATEWAY_GRPC_WEB_URL, apiBaseUrl = FIREWORKS_GATEWAY_URL } = {},
) {
  const grpcListed = await listFeatureFlags(accountId, apiKey, { baseUrl: grpcBaseUrl });
  const grpcResult = lookupFromListed(grpcListed, flagId);
  if (grpcResult) {
    return grpcResult;
  }

  const restListed = await listFeatureFlagsRest(accountId, apiKey, { apiBaseUrl });
  const restResult = lookupFromListed(restListed, flagId);
  if (restResult) {
    return restResult;
  }

  return {
    enabled: false,
    unavailable: true,
    reason: grpcListed.reason || restListed.reason || "feature flag lookup failed",
  };
}
