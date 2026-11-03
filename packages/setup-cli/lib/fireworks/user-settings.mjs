import process from "node:process";
import { FIREWORKS_GATEWAY_URL } from "./models.mjs";
import { fireworksGatewayFetchSignal } from "./gateway-fetch.mjs";
import { verifyFireworksApiKey } from "../keys/verify-api-key.mjs";

/**
 * The signed-in user's account-level preferences (`UserSettings`, one per
 * user at accounts/{a}/users/{u}/settings), read with their own API key.
 * Only `shareNexusAnalytics` is used here: the "share anonymous usage data"
 * answer, which is set on the web and read by the Nexus desktop app.
 *
 * Every function returns a result object and never throws. Failure messages
 * are fixed strings: server error text can carry the account or user ID, so
 * it is never echoed.
 */

/**
 * @typedef {"network"|"unsupported"|"forbidden"|"other"} SettingsFailureCode
 * @typedef {{ ok: true, shareNexusAnalytics: boolean|null } | { ok: false, code: SettingsFailureCode, message: string }} ShareNexusAnalyticsResult
 * @typedef {{ ok: true, userName: string } | { ok: false, code: SettingsFailureCode, message: string }} UserNameResult
 */

const MESSAGES = {
  network: "Couldn't reach Fireworks.",
  unsupported: "Fireworks doesn't support this setting yet.",
  forbidden: "Fireworks didn't allow reading this setting with your key.",
  other: "Fireworks returned an unexpected response.",
  noUser: "Couldn't find your Fireworks user for this key.",
};

const fail = (code, message = MESSAGES[code]) => ({ ok: false, code, message });

function gatewayBase(gatewayUrl = "") {
  return gatewayUrl || process.env.NEXUS_GATEWAY_URL?.trim() || FIREWORKS_GATEWAY_URL;
}

/**
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<{ response: Response } | { response: null }>}
 */
async function gatewayFetch(url, apiKey) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: fireworksGatewayFetchSignal(),
    });
    return { response };
  } catch {
    return { response: null };
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * A 400 that says the server doesn't know the field (or the settings
 * resource) yet.
 * @param {unknown} body
 */
function isUnknownFieldError(body) {
  const message = typeof body?.message === "string" ? body.message : "";
  return /share_?nexus_?analytics|unknown field|invalid field|no such field|not (?:a )?(?:valid|known) field/i
    .test(message);
}

/**
 * @param {Response} response
 * @returns {Promise<{ ok: false, code: SettingsFailureCode, message: string }>}
 */
async function httpFailure(response) {
  if (response.status === 401 || response.status === 403) {
    return fail("forbidden");
  }
  if (response.status === 400 && isUnknownFieldError(await readJson(response))) {
    return fail("unsupported");
  }
  return fail("other");
}

/**
 * The `accounts/{a}/users/{u}` the key belongs to, found from the key's
 * account and developer email (GET /verifyApiKey), then ListUsers filtered
 * by that email. Account members may list users with their own API key
 * (firectl resolves API-key users the same way).
 * @param {string} apiKey
 * @param {{ gatewayUrl?: string }} [options]
 * @returns {Promise<UserNameResult>}
 */
export async function lookupUserNameForKey(apiKey, { gatewayUrl = "" } = {}) {
  const verified = await verifyFireworksApiKey(apiKey, { gatewayUrl });
  if (!verified.ok) {
    if (verified.reason === "network") return fail("network");
    if (verified.reason === "rejected") return fail("forbidden");
    return fail("other");
  }
  if (!verified.accountId || !verified.email) {
    // Service-account keys carry no developer email, so there is no person
    // whose preference this would be.
    return fail("other", MESSAGES.noUser);
  }

  const parent = `accounts/${encodeURIComponent(verified.accountId)}`;
  const query = new URLSearchParams({ filter: `email="${verified.email}"`, pageSize: "2" });
  const { response } = await gatewayFetch(`${gatewayBase(gatewayUrl)}/v1/${parent}/users?${query}`, apiKey);
  if (!response) return fail("network");
  if (!response.ok) return httpFailure(response);

  const body = await readJson(response);
  const names = Array.isArray(body?.users)
    ? body.users.map((user) => user?.name).filter((name) => typeof name === "string" && name)
    : [];
  return names.length === 1 ? { ok: true, userName: names[0] } : fail("other", MESSAGES.noUser);
}

/**
 * @param {unknown} body
 * @returns {boolean|null}
 */
function shareNexusAnalyticsFrom(body) {
  return typeof body?.shareNexusAnalytics === "boolean" ? body.shareNexusAnalytics : null;
}

/**
 * Read the preference; null when the user has never answered.
 * @param {string} apiKey
 * @param {string} userName  accounts/{a}/users/{u}
 * @param {{ gatewayUrl?: string }} [options]
 * @returns {Promise<ShareNexusAnalyticsResult>}
 */
export async function getShareNexusAnalytics(apiKey, userName, { gatewayUrl = "" } = {}) {
  const { response } = await gatewayFetch(`${gatewayBase(gatewayUrl)}/v1/${userName}/settings`, apiKey);
  if (!response) return fail("network");
  if (!response.ok) return httpFailure(response);
  const body = await readJson(response);
  if (!body || typeof body !== "object") return fail("other");
  return { ok: true, shareNexusAnalytics: shareNexusAnalyticsFrom(body) };
}
