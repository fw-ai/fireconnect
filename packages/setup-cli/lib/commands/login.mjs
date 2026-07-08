import process, { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { readSecret } from "../read-secret.mjs";
import { isFireworksShapedKey } from "../fireconnect-core.mjs";
import { persistApiKeyToKeychain, resolveFireworksApiKeyValue, tryReadKeychainSecret } from "../api-key.mjs";
import { assertBackendCanStore, keyStorageSummaryLine } from "../key-storage-report.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../global-config.mjs";
import { deleteSecret, hasSecret } from "../secret-store.mjs";
import { identityLabel, verifyFireworksApiKey } from "../verify-api-key.mjs";
import { signInViaDeviceFlow, signInViaLocalhostCallback } from "../browser-auth.mjs";
import {
  clearMintedKeyState,
  listAccountsForIdToken,
  mintApiKeyForAccount,
  mintedKeyName,
  readMintedKeyState,
  revokeMintedKey,
  writeMintedKeyState,
} from "../mint-api-key.mjs";
import { accent, check, link, openInBrowser, withSpinner } from "../term.mjs";

export const KEYS_URL = "https://app.fireworks.ai/settings/users/api-keys";
const MAX_PASTE_ATTEMPTS = 3;

/**
 * Login/logout print their own one-line recovery copy instead of throwing —
 * a raw `Error: …` is exactly the texture this command exists to avoid.
 * @param {string} message
 */
function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function requireHome(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }
  return home;
}

/**
 * One-line reason a verification failed, phrased for the caller's context.
 * @param {import("../verify-api-key.mjs").VerifyResult} result
 * @param {{ interactive?: boolean }} [options]
 */
function verifyFailureLine(result, { interactive = false } = {}) {
  if (result.reason === "rejected") {
    return interactive
      ? `That key didn't work. Check it at ${link(KEYS_URL)} or paste another.`
      : `That key didn't work. Check it at ${KEYS_URL}`;
  }
  if (result.reason === "network") {
    return `Couldn't reach the Fireworks API (${result.detail}). Check your connection and try again.`;
  }
  return `The Fireworks API returned an unexpected response (${result.status}). Try again in a moment.`;
}

/**
 * Store the key and return the backend-honest one-liner saying where it went
 * (OS keychain vs encrypted-file vs plaintext fallback) — the where is the
 * trust story, so callers print it rather than dropping it.
 * @param {string} home
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function storeApiKey(home, apiKey) {
  const { backend, message } = await keyStorageSummaryLine(home);
  await assertBackendCanStore(backend, home);
  await persistApiKeyToKeychain(home, apiKey, { backend });
  return message;
}

/**
 * @param {import("../verify-api-key.mjs").VerifyResult} result
 */
function signedInLine(result) {
  const who = identityLabel(result);
  return who ? `${check()} Signed in as ${who}.` : `${check()} Signed in.`;
}

/**
 * `FIREWORKS_API_KEY` wins over the stored key in every downstream resolver
 * (see `resolveFireworksApiKeyValue`). When it is set to something other than
 * the key we just stored, a bare "Signed in" would overstate what actually
 * takes effect — commands would keep using the env value. Return a one-line,
 * actionable heads-up; "" when the env var is absent or already matches.
 * @param {string} storedKey
 */
function envOverrideNote(storedKey) {
  const envKey = process.env.FIREWORKS_API_KEY?.trim();
  if (envKey && envKey !== storedKey.trim()) {
    return `Note: ${accent("FIREWORKS_API_KEY")} is set in your environment and overrides this key. `
      + `Unset it (${accent("unset FIREWORKS_API_KEY")}) for this sign-in to take effect.`;
  }
  return "";
}

/**
 * Every sign-in ends here: identity, then what changed on this machine and
 * how to undo it — reversibility that isn't announced doesn't reassure.
 * @param {import("../verify-api-key.mjs").VerifyResult | { email: string, accountId: string }} result
 * @param {string[]} [notes]
 */
function printSuccessBlock(result, notes = [], { nextHint = true } = {}) {
  console.log("");
  console.log(`  ${signedInLine(result)}`);
  for (const note of notes.filter(Boolean)) {
    console.log(`  ${note}`);
  }
  console.log(`  Remove it from this machine anytime with  ${accent("fireconnect logout")}`);
  console.log("");
  if (nextHint) {
    console.log(`  Next: connect a tool with  ${accent("fireconnect claude on")}`);
  }
}

/**
 * Read the whole of stdin (for --with-token).
 * @returns {Promise<string>}
 */
async function readStdinToken() {
  let data = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) {
    data += chunk;
  }
  return data.trim();
}

/**
 * Non-interactive sign-in from an explicit key (--with-token stdin or
 * --api-key flag). Single-line output, no prompts, no spinner.
 * @param {string} home
 * @param {string} key
 */
async function loginNonInteractive(home, key) {
  if (!key) {
    fail("No key provided. Run fireconnect login --with-token < key.txt to sign in non-interactively.");
    return;
  }
  if (!isFireworksShapedKey(key)) {
    fail(`That doesn't look like a Fireworks key (expected it to start with fw_ or fpk_). Get one at ${KEYS_URL}`);
    return;
  }
  const result = await verifyFireworksApiKey(key);
  if (!result.ok) {
    fail(verifyFailureLine(result));
    return;
  }
  await storeApiKey(home, key);
  console.log(signedInLine(result));
  const note = envOverrideNote(key);
  if (note) {
    console.log(note);
  }
}

/**
 * Ask for the one fact that decides the flow: does the user have a key value
 * in hand, or should we make one? Framed around the key rather than the
 * sign-in mechanism — "create" quietly covers no-account (the browser page
 * offers sign-up) and lost-key (old key values are unrecoverable), so every
 * newcomer can answer without understanding OAuth or Fireworks' key model.
 * Enter takes the default (create). Exported for tests.
 *
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<"browser" | "paste" | null>} null when cancelled.
 */
export async function promptSignInMethod({ stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  out_.write("\n");
  out_.write("  FireConnect needs a Fireworks API key for this machine.\n");
  out_.write(`  (Removable anytime with ${accent("fireconnect logout", out_)}.)\n`);
  out_.write("\n");
  out_.write(`    ${accent("1", out_)}) Create one for me — opens your browser to sign in or sign up\n`);
  out_.write(`    ${accent("2", out_)}) I already have a key — paste it\n`);
  out_.write("\n");
  // Iterate lines on one interface rather than looping rl.question(): a line
  // arriving between two question() calls is silently dropped, and a pending
  // question never settles when stdin closes. Running out of lines (Ctrl-D)
  // cancels.
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt("  Choice [1]: ");
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "1") {
        return "browser";
      }
      if (answer === "2") {
        return "paste";
      }
      if (answer === "q" || answer === "quit") {
        return null;
      }
      out_.write("  Enter 1 or 2, or q to cancel.\n");
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * One yes/no question; Enter takes the default. EOF (Ctrl-D) answers no —
 * the callers ask before doing something irreversible, so silence must not
 * consent. Exported for tests.
 * @param {string} question
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<boolean>}
 */
export async function promptYesNo(question, { stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt(`${question} [Y/n]: `);
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        return true;
      }
      if (answer === "n" || answer === "no") {
        return false;
      }
      out_.write("  Enter y or n.\n");
      rl.prompt();
    }
    return false;
  } finally {
    rl.close();
  }
}

/**
 * Strip the `accounts/` prefix so the chooser lists a readable slug, not the
 * full resource name. Falls back to the whole string for anything unexpected.
 * @param {string} name
 */
function accountLabel(name) {
  return name.startsWith("accounts/") ? name.slice("accounts/".length) : name;
}

/**
 * When browser sign-in resolves to more than one Fireworks account, ask which
 * one this machine's key should belong to — minting silently under the first
 * can put the key in an account the user didn't mean to use. Enter takes the
 * first; `q` or EOF (Ctrl-D) cancels. Exported for tests.
 * @param {string[]} accountNames  resources like "accounts/acme"
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<number|null>} index into accountNames, or null if cancelled.
 */
export async function promptAccountChoice(accountNames, { stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  out_.write("\n");
  out_.write("  Your sign-in is linked to more than one Fireworks account. Which one should this key belong to?\n");
  out_.write("\n");
  accountNames.forEach((name, i) => {
    out_.write(`    ${accent(String(i + 1), out_)}) ${accountLabel(name)}\n`);
  });
  out_.write("\n");
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt("  Choice [1]: ");
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "1") {
        return 0;
      }
      if (answer === "q" || answer === "quit") {
        return null;
      }
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= accountNames.length) {
        return n - 1;
      }
      out_.write(`  Enter 1 to ${accountNames.length}, or q to cancel.\n`);
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * Browser sign-in (login_roadmap.md Stage 2): localhost-callback flow first,
 * then the device-flow service, each yielding a Cognito id_token that is
 * exchanged for a named fw_ key and stored through the same path as paste.
 *
 * Returns true when sign-in finished (success or a fatal denial); false to
 * fall through to the paste flow — the reason is already printed.
 * @param {string} home
 */
async function runBrowserFlow(home, { nextHint = true } = {}) {
  const say = (line) => console.log(`  ${line}`);
  console.log("");

  // Localhost-callback first; if the browser can't be opened here, cascade to
  // the device flow (its verification URL works from any device), then paste.
  const flows = [
    () => signInViaLocalhostCallback({ onStatus: say }),
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
      fail(`  ${result.failure} Run ${accent("fireconnect login")} to try again.`);
      return true;
    }
    say(result.failure);
  }
  if (!tokens) {
    say("Switching to key paste.");
    return false;
  }

  // Resolve the account OUTSIDE the spinner: a principal can map to several
  // Fireworks accounts, and picking one is an interactive prompt that a
  // spinning line would clobber. ListUsers + CreateApiKey then run under it.
  const listed = await listAccountsForIdToken(tokens.idToken);
  let accountName = "";
  let accountFailure = "";
  if (!listed.ok) {
    accountFailure = listed.failure;
  } else if (listed.accountNames.length === 0) {
    accountFailure = "Your sign-in worked, but no Fireworks account is associated with it.";
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

  const outcome = accountFailure
    ? { failure: accountFailure }
    : await withSpinner("Signing you in…", async () => {
        const mint = await mintApiKeyForAccount(tokens.idToken, accountName, { email: tokens.email });
        if (!mint.ok) {
          return { failure: mint.failure };
        }
        const verify = await verifyFireworksApiKey(mint.key);
        if (!verify.ok && verify.reason === "rejected") {
          // A freshly minted key the API rejects means something is genuinely
          // broken — don't store it.
          return { failure: "The Fireworks API rejected the key that was just created for you. Try again in a moment." };
        }
        return { mint, verify };
      });
  if (outcome.failure) {
    say(outcome.failure);
    say("Switching to key paste.");
    return false;
  }

  const storedLine = await storeApiKey(home, outcome.mint.key);
  // Remember what we created (ids only) so `logout` can revoke it server-side.
  await writeMintedKeyState(home, {
    keyId: outcome.mint.keyId,
    userName: outcome.mint.userName,
    displayName: mintedKeyName(),
  });
  // Identity: prefer the live verifyApiKey headers; if that call couldn't be
  // made (network blip), the id_token's email claim is still honest.
  const identity = outcome.verify.ok ? outcome.verify : { email: tokens.email, accountId: "" };
  printSuccessBlock(identity, [
    `Created API key ${accent(mintedKeyName())} — revoke anytime at ${link(KEYS_URL)}`,
    storedLine,
    envOverrideNote(outcome.mint.key),
  ], { nextHint });
  return true;
}

/**
 * The guided paste flow (interactive TTY).
 * @param {string} home
 */
async function runPasteFlow(home, { nextHint = true } = {}) {
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
        continue; // the browser hand-off is not a failed attempt
      }
      attempts += 1;
      continue;
    }

    if (!isFireworksShapedKey(key)) {
      attempts += 1;
      console.log(
        `  That doesn't look like a Fireworks key (expected it to start with fw_ or fpk_). `
        + `Try again, or get one at ${link(KEYS_URL)}`,
      );
      continue;
    }

    const result = await withSpinner("Checking your key…", () => verifyFireworksApiKey(key));
    if (result.ok) {
      const storedLine = await storeApiKey(home, key);
      printSuccessBlock(result, [storedLine, envOverrideNote(key)], { nextHint });
      return;
    }
    attempts += 1;
    console.log(`  ${verifyFailureLine(result, { interactive: true })}`);
  }

  fail(`Sign-in not completed. Run ${accent("fireconnect login")} to try again.`);
}

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runLoginCommand(ctx) {
  const home = requireHome(ctx);

  if (ctx.withToken) {
    await loginNonInteractive(home, await readStdinToken());
    return;
  }

  // `login --api-key fw_…` is an explicit re-auth: validate and store it
  // without prompts, even when already signed in.
  if (ctx.apiKeyFromFlag) {
    await loginNonInteractive(home, ctx.apiKey.trim());
    return;
  }

  // `login --paste` skips the method chooser and goes straight to the guided
  // paste flow. The recovery line browser sign-in prints on a status-16
  // failure points here, so the flag it names has to actually exist.
  if (ctx.paste) {
    if (!stdin.isTTY) {
      fail("Run fireconnect login --with-token < key.txt to sign in non-interactively.");
      return;
    }
    await runInteractiveSignIn(home, { method: "paste" });
    return;
  }

  if (!ctx.force) {
    const existing = await resolveFireworksApiKeyValue({ apiKey: "", home });
    if (existing) {
      const fromEnv = existing === process.env.FIREWORKS_API_KEY?.trim();
      const result = await withSpinner("Checking your credentials…", () => verifyFireworksApiKey(existing));
      if (result.ok || result.reason !== "rejected") {
        const who = result.ok ? identityLabel(result) : "";
        const suffix = fromEnv ? " (from FIREWORKS_API_KEY)" : "";
        console.log(
          result.ok
            ? `${check()} Already signed in${who ? ` as ${who}` : ""}${suffix}.`
            : `${check()} Already signed in${suffix} (couldn't verify with the Fireworks API right now).`,
        );
        console.log(`  Re-authenticate with  ${accent("fireconnect login --force")}`);
        return;
      }
      if (fromEnv) {
        // A rejected FIREWORKS_API_KEY can't be fixed by storing another key —
        // the env value keeps winning over anything in the keychain. Say what
        // actually failed and how to fix it, instead of dropping into a paste
        // flow that wouldn't take effect until the env var is unset.
        fail(`The Fireworks API rejected the ${accent("FIREWORKS_API_KEY")} from your environment. Check or unset it to use a stored key instead.`);
        return;
      }
      console.log("Your stored key was rejected by the Fireworks API — let's replace it.");
    }
  }

  if (!stdin.isTTY) {
    fail("Run fireconnect login --with-token < key.txt to sign in non-interactively.");
    return;
  }

  await runInteractiveSignIn(home);
}

/**
 * The interactive sign-in: method chooser, then the chosen flow. Shared by
 * `fireconnect login` and the no-credentials on-ramp in `<harness> on`.
 * The method is the user's call: "create" mints a key via browser sign-in,
 * "paste" uses one they already have.
 *
 * `nextHint: false` drops the "Next: connect a tool…" line — the on-ramp
 * already is that next step.
 * @param {string} home
 * @param {{ nextHint?: boolean }} [options]
 * @returns {Promise<boolean>} true when a key ended up stored.
 */
export async function runInteractiveSignIn(home, { nextHint = true, method: chosen } = {}) {
  const method = chosen ?? await promptSignInMethod();
  if (!method) {
    fail(`Sign-in cancelled. Run ${accent("fireconnect login")} when you're ready.`);
    return false;
  }

  let handled = false;
  if (method === "browser") {
    handled = await runBrowserFlow(home, { nextHint });
  }
  if (!handled) {
    await runPasteFlow(home, { nextHint });
  }

  return signInSucceeded(home);
}

/**
 * Whether a usable credential is in effect after the sign-in flows ran — the
 * on-ramp's success signal. Resolving alone isn't enough: when
 * FIREWORKS_API_KEY is set to a rejected value it wins over any key the flow
 * just stored, so a bare "a key is resolvable" would read as success and the
 * on-ramp would rerun `on` with the same bad credential. Verify the resolved
 * key and treat a rejection as failure; a network blip isn't a rejection, so
 * stay lenient there (mirrors runLoginCommand's already-signed-in check). Both
 * flows already verified the key they stored, so this only bites when the env
 * var overrides with a different value. Exported for tests.
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

/**
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runLogoutCommand(ctx) {
  const home = requireHome(ctx);

  const config = await readGlobalConfig(home);
  const hadSecret = await hasSecret(home);
  const envNote = process.env.FIREWORKS_API_KEY?.trim()
    ? `Note: FIREWORKS_API_KEY is still set in your environment; commands keep using it until you unset it.`
    : "";

  if (!hadSecret && !config.apiKey) {
    console.log("Not signed in — no stored credentials to clear.");
    if (envNote) {
      console.log(envNote);
    }
    return;
  }

  // The key this CLI created can also be revoked server-side — but only
  // with consent: the user may have exported it into CI or another tool,
  // and revocation is irreversible (key values are unrecoverable). --revoke
  // pre-answers; on a TTY without it we ask; without a TTY the safe answer is
  // keep, said out loud. Decide *before* clearing local credentials — the
  // key authenticates its own deletion, so this is the last chance.
  const minted = await readMintedKeyState(home);
  let revokeLine = "";
  if (minted) {
    const label = minted.displayName || "the API key created by this machine";
    let shouldRevoke = ctx.revoke;
    if (!ctx.revoke && stdin.isTTY) {
      console.log(`Browser sign-in created an API key for this machine (${accent(label)}).`);
      shouldRevoke = await promptYesNo("Revoke it too? It stops working everywhere it's used.");
    }
    if (shouldRevoke) {
      // A key can only authenticate its own deletion, and the minted key is the
      // one in the keychain — read it directly rather than via the env-first
      // resolver, so a stray FIREWORKS_API_KEY (possibly a different account)
      // can't misdirect the DeleteApiKey to fail or target the wrong principal.
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
  if (config.apiKey) {
    await writeGlobalConfig(home, { apiKey: "" });
  }
  console.log("Logged out — removed the stored key from this machine.");
  if (revokeLine) {
    console.log(revokeLine);
  }
  if (envNote) {
    console.log(envNote);
  }
}
