import process from "node:process";
import { keyStatusSummary, resolveFireworksApiKeyValue } from "../api-key.mjs";
import { identityLabel, verifyFireworksApiKey } from "../verify-api-key.mjs";
import { accent, check } from "../term.mjs";

/**
 * `fireconnect status`: report sign-in state and where the key is stored.
 *
 * Combines a LIVE auth check (the active key validated against the gateway,
 * with an identity line) and the static storage report (config ref, backend,
 * per-harness runtime source). Exit 1 when not signed in or the key is
 * rejected, so scripts can gate on it; a key that can't be reached to verify
 * stays exit 0 (present, just unverifiable right now).
 *
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runStatusCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  const summary = await keyStatusSummary(home);
  const active = await resolveFireworksApiKeyValue({ apiKey: "", home });
  // The resolver prefers FIREWORKS_API_KEY, so when it is set it is the
  // credential actually in effect — phrase rejections around that.
  const fromEnv = Boolean(process.env.FIREWORKS_API_KEY?.trim());

  // signedIn: true = verified; false = no key or rejected (exit 1);
  // null = a key is present but the API couldn't be reached (exit 0).
  let auth;
  if (!active) {
    auth = { signedIn: false, email: "", reason: "no-key" };
  } else {
    const result = await verifyFireworksApiKey(active);
    if (result.ok) {
      auth = { signedIn: true, email: identityLabel(result), reason: "" };
    } else if (result.reason === "rejected") {
      auth = { signedIn: false, email: "", reason: "rejected" };
    } else {
      auth = { signedIn: null, email: "", reason: "unreachable" };
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({ auth, ...summary }, null, 2));
  } else {
    printAuthLine(auth, fromEnv);
    console.log("");
    printStorage(summary);
  }

  if (auth.signedIn === false) {
    process.exitCode = 1;
  }
}

/**
 * @param {{ signedIn: boolean|null, email: string, reason: string }} auth
 * @param {boolean} fromEnv
 */
function printAuthLine(auth, fromEnv) {
  if (auth.signedIn === true) {
    console.log(auth.email ? `${check()} Signed in as ${auth.email}.` : `${check()} Signed in.`);
    return;
  }
  if (auth.reason === "no-key") {
    console.log(`Not signed in. Run ${accent("fireconnect login")} to sign in.`);
    return;
  }
  if (auth.reason === "rejected") {
    // `login --force` re-stores a key but cannot touch a FIREWORKS_API_KEY the
    // shell exports — tell env users the real fix instead of pointing at it.
    console.log(
      fromEnv
        ? `The Fireworks API rejected the FIREWORKS_API_KEY from your environment. Check or unset it to use a stored key instead.`
        : `A stored key was found, but the Fireworks API rejected it. Run ${accent("fireconnect login --force")} to replace it.`,
    );
    return;
  }
  console.log(
    `A Fireworks API key is ${fromEnv ? "set in your environment" : "stored"}, but the Fireworks API couldn't be reached to verify it.`,
  );
}

/**
 * @param {Awaited<ReturnType<import("../api-key.mjs").keyStatusSummary>>} summary
 */
function printStorage(summary) {
  console.log(`Config ref: ${summary.configRef}`);
  console.log(`Secret backend: ${summary.backendLabel}`);
  if (summary.location) {
    console.log(`Location: ${summary.location}`);
  }
  if (summary.backendError) {
    console.log(`Backend issue: ${summary.backendError}`);
  }
  console.log(`Key stored: ${summary.keychainPresent ? "yes" : "no"}`);
  console.log(`FIREWORKS_API_KEY in environment: ${summary.envPresent ? "yes" : "no"}`);
  if (summary.backend === "file" && summary.keychainPresent) {
    console.log("");
    console.log(
      "Sandbox/CI tip: Codex/OpenCode/Pi read FIREWORKS_API_KEY from the environment via a shell hook. "
        + "In non-interactive shells where `fireconnect` isn't on PATH, export FIREWORKS_API_KEY directly "
        + "(the key is in the encrypted file above) so the hook isn't required.",
    );
  }
  console.log("");
  console.log("Per harness (where the key is read from at runtime):");
  for (const h of summary.perHarness) {
    const state = h.enabled ? "on" : "off";
    console.log(`  ${h.id} [${state}] — ${h.readsFrom} — storage: ${h.storage}`);
  }
}
