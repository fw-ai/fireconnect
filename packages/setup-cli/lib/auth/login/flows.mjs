import process, { stdin } from "node:process";

import { signInViaDeviceFlow, signInViaLocalhostCallback } from "../browser-auth.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import {
  keysUrlFor,
  keysUrlForHome,
  resolveFireworksApiKeyValue,
} from "../../keys/api-key.mjs";
import { readSecret } from "../../ui/read-secret.mjs";
import { sanitize } from "../../ui/sanitize.mjs";
import {
  FIREPASS_KEY_UNSUPPORTED_MESSAGE,
  isFirePassKey,
  isFireworksShapedKey,
} from "../../keys/key-type.mjs";
import { createUserJit, getOAuthArgumentsForAccount } from "../sso-account.mjs";
import {
  BROWSER_SIGNIN_NO_ACCOUNT_FAILURE,
  listAccountsForIdToken,
  mintApiKeyForAccount,
  mintedKeyName,
  writeMintedKeyState,
} from "../../keys/mint-api-key.mjs";
import { verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import { accent, link, openInBrowser, withSpinner } from "../../ui/term.mjs";
import {
  fail,
  printSuccessBlock,
  storeApiKey,
  verifyFailureLine,
} from "./output.mjs";
import { activeKeySourceNote } from "../../keys/storage-report.mjs";
import {
  promptAccountChoice,
  promptAccountId,
  promptSignInMethod,
} from "./prompts.mjs";

const MAX_PASTE_ATTEMPTS = 3;
const ACCOUNT_KIND_TIMEOUT_MS = 5_000;

/**
 * Who the browser sign-in came back as, shown before a key is created so a
 * sign-in that returned an unexpected identity is visible.
 * @param {string} email
 * @param {string} accountName  accounts/<id>
 */
export function signedInIdentityLine(email, accountName) {
  const who = sanitize(email) || "an account with no email";
  const account = sanitize(String(accountName ?? "").replace(/^accounts\//, ""));
  return `Signed in as ${who} — creating a key in account ${account}.`;
}

async function completeMintedSignIn(home, {
  idToken,
  email,
  accountName,
  fallbackAccountId = "",
  rememberSsoAccountId = "",
  nexusAccount = false,
  nextHint = true,
  say,
}) {
  say(signedInIdentityLine(email, accountName));
  const keyName = mintedKeyName();
  const outcome = await withSpinner("Signing you in…", async () => {
    const mint = await mintApiKeyForAccount(idToken, accountName, { email, keyName });
    if (!mint.ok) {
      return { failure: mint.failure };
    }
    const verify = await verifyFireworksApiKey(mint.key);
    if (!verify.ok && verify.reason === "rejected") {
      return { failure: "The Fireworks API rejected the key that was just created for you. Try again in a moment." };
    }
    return { mint, verify };
  });
  if (outcome.failure) {
    say(outcome.failure);
    return false;
  }

  const stored = await storeApiKey(home, outcome.mint.key, nexusAccount ? "nexus" : "platform");
  await writeMintedKeyState(home, {
    keyId: outcome.mint.keyId,
    userName: outcome.mint.userName,
    displayName: keyName,
  });
  if (rememberSsoAccountId) {
    await writeGlobalConfig(home, { ssoAccountId: rememberSsoAccountId });
  }
  const identity = outcome.verify.ok ? outcome.verify : { email, accountId: fallbackAccountId };
  printSuccessBlock(identity, [
    `Created API key ${accent(keyName)} — revoke anytime at ${link(keysUrlFor(nexusAccount))}`,
    stored.message,
    ...stored.notes,
    activeKeySourceNote(outcome.mint.key),
  ], { nextHint });
  return true;
}

async function runBrowserFlow(home, { nextHint = true } = {}) {
  const say = (line) => console.log(`  ${line}`);
  console.log("");

  const flows = [
    // The Nexus client gets our own sign-in pages; SSO accounts
    // (runSsoBrowserFlow) keep their pool's own sign-in.
    () => signInViaLocalhostCallback({ onStatus: say, nexusSignInPage: true }),
    () => signInViaDeviceFlow({ onStatus: say }),
  ];

  let tokens = null;
  for (const flow of flows) {
    const result = await flow();
    if (result.ok) {
      tokens = result;
      break;
    }
    if (result.fatal) {
      fail(`  ${result.failure} Run ${accent("nexus login")} to try again.`);
      return true;
    }
    say(result.failure);
  }
  if (!tokens) {
    say("Switching to key paste.");
    return false;
  }

  const listed = await listAccountsForIdToken(tokens.idToken);
  let accountName = "";
  let accountFailure = "";
  if (!listed.ok) {
    accountFailure = listed.failure;
  } else if (listed.accountNames.length === 0) {
    accountFailure = BROWSER_SIGNIN_NO_ACCOUNT_FAILURE;
  } else if (listed.accountNames.length > 1) {
    const idx = await promptAccountChoice(listed.accountNames);
    if (idx === null) {
      accountFailure = "Sign-in cancelled — no account selected.";
    } else {
      accountName = listed.accountNames[idx];
    }
  } else {
    accountName = listed.accountNames[0];
  }

  if (accountFailure) {
    say(accountFailure);
    say("Switching to key paste.");
    return false;
  }
  const completed = await completeMintedSignIn(home, {
    idToken: tokens.idToken,
    email: tokens.email,
    accountName,
    nexusAccount: listed.nexusAccountNames.includes(accountName),
    nextHint,
    say,
  });
  if (!completed) {
    say("Switching to key paste.");
    return false;
  }
  return true;
}

async function runSsoBrowserFlow(home, accountId, { nextHint = true } = {}) {
  const say = (line) => console.log(`  ${line}`);
  console.log("");

  const args = await getOAuthArgumentsForAccount(accountId);
  if (!args.ok) {
    fail(`  ${args.failure}`);
    return true;
  }

  say(`Signing in through ${accent(accountId)}'s identity provider…`);
  const tokens = await signInViaLocalhostCallback({
    onStatus: say,
    cognitoDomain: args.cognitoDomain,
    clientId: args.clientId,
  });
  if (!tokens.ok) {
    if (tokens.fatal) {
      fail(`  ${tokens.failure} Run ${accent(`nexus login --account ${accountId}`)} to try again.`);
      return true;
    }
    say(tokens.failure);
    say("Switching to key paste.");
    return false;
  }

  const jit = await createUserJit(tokens.idToken, accountId);
  if (!jit.ok) {
    fail(`  ${jit.failure}`);
    return true;
  }

  // Best-effort: an SSO sign-in names its account, so the list is only read
  // for the account kind; a failed or slow lookup keeps Platform links.
  // The request itself is aborted at the deadline, so a stalled response
  // can't keep the CLI running after sign-in.
  const listed = await listAccountsForIdToken(tokens.idToken, {
    signal: AbortSignal.timeout(ACCOUNT_KIND_TIMEOUT_MS),
  }).catch(() => null);
  const completed = await completeMintedSignIn(home, {
    idToken: tokens.idToken,
    email: tokens.email,
    accountName: `accounts/${accountId}`,
    nexusAccount: listed?.nexusAccountNames?.includes(`accounts/${accountId}`) === true,
    fallbackAccountId: accountId,
    rememberSsoAccountId: accountId,
    nextHint,
    say,
  });
  if (!completed) {
    say("Switching to key paste.");
    return false;
  }
  return true;
}

async function runPasteFlow(home, { nextHint = true } = {}) {
  // Whoever signed in here last: a pasted key's account isn't known.
  const KEYS_URL = await keysUrlForHome(home);
  console.log("");
  console.log(`  Get a key from  ${link(KEYS_URL)}`);
  console.log("  Press Enter to open that page in your browser, or paste your key below.");
  console.log("");

  let openedBrowser = false;
  let attempts = 0;
  while (attempts < MAX_PASTE_ATTEMPTS) {
    const key = await readSecret("  Paste your Fireworks API key: ", { allowEmpty: true });

    if (!key) {
      if (!openedBrowser) {
        openedBrowser = true;
        const opened = await openInBrowser(KEYS_URL);
        console.log(
          opened
            ? "  Opened your browser — create a key there, then paste it here."
            : `  Couldn't open a browser. Visit ${link(KEYS_URL)}, then paste the key here.`,
        );
        continue;
      }
      attempts += 1;
      continue;
    }

    if (isFirePassKey(key)) {
      attempts += 1;
      console.log(`  ${FIREPASS_KEY_UNSUPPORTED_MESSAGE}`);
      continue;
    }
    if (!isFireworksShapedKey(key)) {
      attempts += 1;
      console.log(
        `  That doesn't look like a Fireworks key (expected it to start with fw_). `
        + `Try again, or get one at ${link(KEYS_URL)}`,
      );
      continue;
    }

    const result = await withSpinner("Checking your key…", () => verifyFireworksApiKey(key));
    if (result.ok) {
      const stored = await storeApiKey(home, key);
      printSuccessBlock(result, [stored.message, ...stored.notes, activeKeySourceNote(key)], { nextHint });
      return;
    }
    attempts += 1;
    console.log(`  ${verifyFailureLine(result, { interactive: true, keysUrl: KEYS_URL })}`);
  }

  fail(`Sign-in not completed. Run ${accent("nexus login")} to try again.`);
}

/**
 * @param {string} home
 * @param {{ nextHint?: boolean, method?: "browser" | "paste" | "sso" }} [options]
 * @returns {Promise<boolean>}
 */
export async function runInteractiveSignIn(home, { nextHint = true, method: chosen } = {}) {
  const method = chosen ?? await promptSignInMethod();
  if (!method) {
    fail(`Sign-in cancelled. Run ${accent("nexus login")} when you're ready.`);
    return false;
  }

  let handled = false;
  if (method === "browser") {
    handled = await runBrowserFlow(home, { nextHint });
  }
  if (method === "sso") {
    const remembered = (await readGlobalConfig(home)).ssoAccountId;
    const accountId = await promptAccountId(remembered);
    if (!accountId) {
      fail(`Sign-in cancelled. Run ${accent("nexus login")} when you're ready.`);
      return false;
    }
    handled = await runSsoBrowserFlow(home, accountId, { nextHint });
  }
  if (!handled) {
    await runPasteFlow(home, { nextHint });
  }

  return signInSucceeded(home);
}

/**
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function signInSucceeded(home) {
  const stored = await resolveFireworksApiKeyValue({ apiKey: "", home });
  if (!stored) {
    return false;
  }
  const result = await verifyFireworksApiKey(stored);
  return result.ok || result.reason !== "rejected";
}

export { runSsoBrowserFlow };
