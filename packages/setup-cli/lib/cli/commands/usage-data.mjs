import process from "node:process";
import { resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { readMintedKeyState } from "../../keys/mint-api-key.mjs";
import { getShareNexusAnalytics, lookupUserNameForKey } from "../../fireworks/user-settings.mjs";

/**
 * `nexus usage-data`: hidden plumbing for the Nexus desktop app, which never
 * holds the Fireworks key and reads the signed-in user's "share anonymous
 * usage data" answer through this CLI. The answer is set on the web only, so
 * this is read-only.
 *
 * Nexus Desktop parses the --json output, so its shape is a contract:
 *   {"ok":true,"shareNexusAnalytics":true|false|null}   (null = never answered)
 *   {"ok":false,"code":"not-signed-in"|"network"|"unsupported"|"forbidden"|"other","message":"..."}
 * Failures exit 1. Messages never include the key, email or account ID.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runUsageDataCommand(ctx) {
  const result = await usageDataResult(ctx).catch(() => ({
    ok: false,
    code: "other",
    message: "Couldn't read your stored Fireworks key.",
  }));
  if (ctx.json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    const label = result.shareNexusAnalytics === null ? "not set" : result.shareNexusAnalytics ? "on" : "off";
    console.log(`Sharing anonymous usage data: ${label}`);
  } else {
    console.error(result.message);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @returns {Promise<{ ok: true, shareNexusAnalytics: boolean|null } | { ok: false, code: string, message: string }>}
 */
async function usageDataResult(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  const { key, source } = await resolveFireworksKeyWithSource({ apiKey: ctx.apiKey, home });
  if (!key) {
    return {
      ok: false,
      code: "not-signed-in",
      message: "Not signed in. Run nexus login to sign in.",
    };
  }

  const user = await resolveUserName(key, source, home);
  if (!user.ok) {
    return user;
  }
  return getShareNexusAnalytics(key, user.userName);
}

/**
 * Browser sign-in records the user the minted key belongs to, and storing any
 * other key clears that record, so it is current exactly when the stored key
 * is the one in use. Otherwise look the user up from the key itself.
 * @param {string} key
 * @param {import("../../keys/api-key.mjs").FireworksKeySource} source
 * @param {string} home
 */
async function resolveUserName(key, source, home) {
  if (source === "stored" && home) {
    const minted = await readMintedKeyState(home).catch(() => null);
    if (minted?.userName) {
      return { ok: true, userName: minted.userName };
    }
  }
  return lookupUserNameForKey(key);
}
