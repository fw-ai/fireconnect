import process, { stdin } from "node:process";

import {
  keysUrlFor,
  refreshCatalogCacheForHome,
  resolveFireworksApiKeyValue,
  tryReadKeychainSecret,
} from "../../keys/api-key.mjs";
import { isEnabledFireworksHarness, readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import { HARNESS_COMMANDS } from "../../harness/id.mjs";
import { deleteSecret, hasSecret } from "../../keys/secret-store.mjs";
import { syncBakedKeysAfterStore } from "../../keys/sync.mjs";
import { identityLabel, verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import {
  clearMintedKeyState,
  readMintedKeyState,
  revokeMintedKey,
} from "../../keys/mint-api-key.mjs";
import {
  savedAutoProviderKeyStatus,
  unsetAutoProviderKeys,
} from "../../keys/auto-provider-keys.mjs";
import { accent, check, link, withSpinner } from "../../ui/term.mjs";
import { runInteractiveSignIn, runSsoBrowserFlow, signInSucceeded } from "../../auth/login/flows.mjs";
import {
  fail,
  loginNonInteractive,
} from "../../auth/login/output.mjs";
import { promptYesNo } from "../../auth/login/prompts.mjs";

export { KEYS_URL } from "../../auth/login/output.mjs";
export {
  promptAccountChoice,
  promptAccountId,
  promptSignInMethod,
  promptYesNo,
} from "../../auth/login/prompts.mjs";
export { runInteractiveSignIn, signInSucceeded } from "../../auth/login/flows.mjs";

function requireHome(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }
  return home;
}

async function readStdinToken() {
  let data = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) {
    data += chunk;
  }
  return data.trim();
}

function printKeyRotationHints({ tty = stdin.isTTY } = {}) {
  if (tty) {
    console.log(`  Rotate without prompting:  ${accent("nexus login --force")}`);
  }
  console.log(`  Or pass a key directly:      ${accent("nexus login --api-key <key>")}`);
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runLoginCommand(ctx) {
  const home = requireHome(ctx);

  if (ctx.withToken) {
    await loginNonInteractive(home, await readStdinToken(), ctx.accountType || "unknown");
    return;
  }

  if (ctx.apiKeyFromFlag) {
    await loginNonInteractive(home, ctx.apiKey.trim());
    return;
  }

  if (ctx.paste) {
    if (!stdin.isTTY) {
      fail("Run nexus login --with-token < key.txt to sign in non-interactively.");
      return;
    }
    await runInteractiveSignIn(home, { method: "paste" });
    return;
  }

  if (ctx.account?.trim()) {
    const handled = await runSsoBrowserFlow(home, ctx.account.trim());
    if (!handled) {
      if (!stdin.isTTY) {
        fail("Run nexus login --with-token < key.txt to sign in non-interactively.");
        return;
      }
      await runInteractiveSignIn(home, { method: "paste" });
    }
    return;
  }

  const existing = await resolveFireworksApiKeyValue({ apiKey: "", home });
  if (existing) {
    const result = await withSpinner("Checking your credentials…", () => verifyFireworksApiKey(existing));
    if (result.ok || result.reason !== "rejected") {
      const who = result.ok ? identityLabel(result) : "";
      console.log(
        result.ok
          ? `${check()} Already signed in${who ? ` as ${who}` : ""}.`
          : `${check()} Already signed in (couldn't verify with the Fireworks API right now).`,
      );
      // Harness configs bake the key as a literal and go stale on rotation.
      if (result.ok) {
        for (const note of await syncBakedKeysAfterStore(home, existing)) {
          console.log(`  ${note}`);
        }
      }
      printKeyRotationHints();
      const rotate = stdin.isTTY
        && (ctx.force || await promptYesNo("  Sign in again and replace this machine's key?", { defaultYes: false }));
      if (!rotate) {
        // The account's plan may have changed since the catalog was cached.
        // A rotation skips this: storing the new key refetches its catalog.
        if (result.ok) {
          await withSpinner("Refreshing your model list…", () => refreshCatalogCacheForHome(home, existing));
        }
        return;
      }
    } else {
      console.log("Your stored key was rejected by the Fireworks API — let's replace it.");
    }
  }

  if (!stdin.isTTY) {
    fail("Run nexus login --with-token < key.txt to sign in non-interactively.");
    return;
  }

  await runInteractiveSignIn(home);
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
/**
 * Connected harnesses keep their own copy of the key in their settings, and
 * logout leaves their routing alone: say so, and how to remove the copies.
 * @param {Record<string, { enabled?: boolean, provider?: string }>} harnesses
 */
function bakedKeyCopiesNote(harnesses) {
  const ids = Object.keys(harnesses).filter((id) => isEnabledFireworksHarness(harnesses, id));
  if (!ids.length) {
    return "";
  }
  const names = ids.map((id) => HARNESS_COMMANDS.find((entry) => entry.command === id)?.name ?? id);
  const commands = ids.map((id) => accent(`nexus ${id} off`)).join(", ");
  return `Note: ${names.join(", ")} still ${ids.length === 1 ? "has" : "have"} a copy of the key in `
    + `${ids.length === 1 ? "its" : "their"} settings and can keep using it until it is revoked. `
    + `To remove the ${ids.length === 1 ? "copy" : "copies"}: ${commands}`;
}

export async function runLogoutCommand(ctx) {
  const home = requireHome(ctx);
  const config = await readGlobalConfig(home);
  const hadSecret = await hasSecret(home);
  const envNote = process.env.FIREWORKS_API_KEY?.trim()
    ? `Note: FIREWORKS_API_KEY is still set in your environment; Nexus ignores it.`
    : "";
  const bakedLine = bakedKeyCopiesNote(config.harnesses ?? {});

  const savedProviderKeys = savedAutoProviderKeyStatus(config);
  const providersToClear = ["anthropic", "openai"].filter((provider) => savedProviderKeys[provider]);
  if (!hadSecret && !config.apiKey) {
    // A missing credential must not leave a previous account's classification.
    if (config.nexusAccount) {
      await writeGlobalConfig(home, { nexusAccount: false });
    }
    if (providersToClear.length) {
      await unsetAutoProviderKeys(home, providersToClear);
      console.log("Logged out — removed the saved provider keys from this machine.");
    } else {
      console.log("Not signed in — no stored credentials to clear.");
    }
    if (bakedLine) {
      console.log(bakedLine);
    }
    if (envNote) {
      console.log(envNote);
    }
    return;
  }

  const minted = await readMintedKeyState(home);
  const KEYS_URL = keysUrlFor(config.nexusAccount);
  let revokeLine = "";
  if (minted) {
    const label = minted.displayName || "the API key created by this machine";
    let shouldRevoke = ctx.revoke;
    if (!ctx.revoke && stdin.isTTY) {
      console.log(`Browser sign-in created an API key for this machine (${accent(label)}).`);
      shouldRevoke = await promptYesNo("Revoke it too? It stops working everywhere it's used.");
    }
    if (shouldRevoke) {
      const apiKey = await tryReadKeychainSecret(home);
      if (apiKey) {
        const revoked = await withSpinner("Revoking this machine's API key…", () => revokeMintedKey({ apiKey, keyId: minted.keyId, userName: minted.userName }));
        revokeLine = revoked.ok
          ? `${check()} Revoked ${accent(label)} server-side.`
          : `Couldn't revoke ${accent(label)} — ${revoked.failure}. Revoke it at ${link(KEYS_URL)}`;
      } else {
        revokeLine = `${accent(label)} may still exist server-side — revoke it at ${link(KEYS_URL)}`;
      }
    } else {
      revokeLine = `Left ${accent(label)} active — revoke it anytime at ${link(KEYS_URL)}`;
    }
    await clearMintedKeyState(home);
  }

  await deleteSecret(home);
  if (config.apiKey || config.nexusAccount) {
    await writeGlobalConfig(home, { apiKey: "", nexusAccount: false });
  }
  // Saved Anthropic/OpenAI keys are credentials too: leaving them would let
  // the next account on this machine send (and be billed through) them.
  if (providersToClear.length) {
    await unsetAutoProviderKeys(home, providersToClear);
  }
  console.log("Logged out — removed the stored key from this machine.");
  if (revokeLine) {
    console.log(revokeLine);
  }
  if (bakedLine) {
    console.log(bakedLine);
  }
  if (envNote) {
    console.log(envNote);
  }
}
