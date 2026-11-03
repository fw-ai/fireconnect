import process from "node:process";

import { verifyFireworksApiKey } from "../keys/verify-api-key.mjs";
import { fireworksGatewayFetchSignal } from "./gateway-fetch.mjs";
import { FIREWORKS_GATEWAY_URL } from "./models.mjs";

// Plan tiers whose only Fireworks model is the `auto` mix.
const AUTO_ONLY_PLAN_TIERS = new Set(["PRO", "TEAMS"]);

/**
 * Whether the account's Nexus plan limits its coding catalog to the `auto`
 * mix: a Pro or Teams plan in any state, as the gateway gates it. Enterprise
 * and accounts without a plan are not limited. Never throws; a lookup that
 * could not get an answer (network, timeout, 429, 5xx) answers null, so callers
 * can tell it from an account without a plan. A rejected key or plan request
 * answers false: the gateway enforces the plan at inference.
 * `NEXUS_PLAN_CATALOG_FILTER=0` turns the check off.
 * @param {string} apiKey
 * @param {{ timeoutMs?: number }} [options] bounds the whole lookup; 0 keeps the gateway default.
 * @returns {Promise<boolean | null>}
 */
export async function planLimitsCatalogToAuto(apiKey, { timeoutMs = 0 } = {}) {
  if (process.env.NEXUS_PLAN_CATALOG_FILTER === "0") {
    return false;
  }
  // Specs stay offline: they describe the account's plan tier, or
  // UNAVAILABLE for a failed lookup, instead.
  if (process.env.NEXUS_TEST === "1") {
    const tier = process.env.NEXUS_TEST_PLAN_TIER ?? "";
    return tier === "UNAVAILABLE" ? null : AUTO_ONLY_PLAN_TIERS.has(tier);
  }
  try {
    const gatewayUrl = process.env.NEXUS_GATEWAY_URL?.trim() || FIREWORKS_GATEWAY_URL;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const verified = await verifyFireworksApiKey(apiKey, { gatewayUrl, timeoutMs });
    const accountId = String(verified?.accountId ?? "").trim().replace(/^accounts\//, "");
    if (!verified?.ok || !accountId) {
      return verified?.ok || isDefiniteRefusal(verified?.status) ? false : null;
    }
    const remainingTimeoutMs = deadline > 0 ? deadline - Date.now() : 0;
    if (deadline > 0 && remainingTimeoutMs <= 0) {
      return null;
    }
    const response = await fetch(`${gatewayUrl}/v1/accounts/${encodeURIComponent(accountId)}/nexusPlans`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: deadline > 0 ? AbortSignal.timeout(remainingTimeoutMs) : fireworksGatewayFetchSignal(),
    });
    if (!response.ok) {
      return isDefiniteRefusal(response.status) ? false : null;
    }
    const { nexusPlans } = await response.json();
    return AUTO_ONLY_PLAN_TIERS.has(currentPlan(Array.isArray(nexusPlans) ? nexusPlans : [])?.tier);
  } catch {
    return null;
  }
}

/** A 4xx other than 429: the gateway answered, and retrying won't change it. */
function isDefiniteRefusal(status) {
  return status >= 400 && status < 500 && status !== 429;
}

/** The plan in force: one that has not ended, else the newest ended one (the list is newest first). */
function currentPlan(plans) {
  return plans.find((plan) => plan?.state !== "ENDED") ?? plans[0];
}
