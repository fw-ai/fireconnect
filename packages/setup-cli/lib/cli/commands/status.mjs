import process from "node:process";
import { keyStatusSummary, resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { identityLabel, verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import { detectEnvironment } from "../../system/environment.mjs";
import { accent, check } from "../../ui/term.mjs";
import { bold, muted } from "../../ui.mjs";
import { printBoolField, printField, printSectionHeader } from "../../harness/status-display.mjs";

/**
 * `fireconnect status`: report sign-in state, machine environment, and where
 * the key is stored.
 *
 * Combines a LIVE auth check (the active key validated against the gateway,
 * with an identity line), host environment (OS/distro/WSL, Node, shell), and the
 * static storage report (config ref, secret backend, per-harness runtime source). Exit 1 when not signed in or the key is
 * rejected, so scripts can gate on it; a key that can't be reached to verify
 * stays exit 0 (present, just unverifiable right now).
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runStatusCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  const summary = await keyStatusSummary(home);
  const environment = detectEnvironment({ home });
  const { key: active, source } = await resolveFireworksKeyWithSource({ apiKey: "", home });
  // The resolver prefers FIREWORKS_API_KEY, so when it is set it is the
  // credential actually in effect — phrase rejections around that.
  const fromEnv = source === "env";

  // signedIn: true = verified; false = no key or rejected (exit 1);
  // null = a key is present but the API couldn't be reached (exit 0).
  /** @type {{ signedIn: boolean|null, email: string, accountId: string, reason: string }} */
  let auth;
  if (!active) {
    auth = { signedIn: false, email: "", accountId: "", reason: "no-key" };
  } else {
    const result = await verifyFireworksApiKey(active);
    if (result.ok) {
      auth = {
        signedIn: true,
        email: result.email,
        accountId: result.accountId,
        reason: "",
      };
    } else if (result.reason === "rejected") {
      auth = { signedIn: false, email: "", accountId: "", reason: "rejected" };
    } else {
      auth = { signedIn: null, email: "", accountId: "", reason: "unreachable" };
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({
      auth,
      activeKeySource: source,
      environment,
      ...summary,
    }, null, 2));
  } else {
    printAuthLine(auth, fromEnv);
    printActiveKeyLine(source, summary);
    console.log("");
    printEnvironment(environment);
    console.log("");
    printStorage(summary, source);
    printHarnesses(summary.perHarness);
  }

  if (auth.signedIn === false) {
    process.exitCode = 1;
  }
}

/**
 * State, in one line, exactly which key tools will use — the piece users most
 * often get wrong when both a stored key and a shell FIREWORKS_API_KEY exist.
 * @param {import("../../keys/api-key.mjs").FireworksKeySource} source
 * @param {Awaited<ReturnType<import("../../keys/api-key.mjs").keyStatusSummary>>} summary
 */
function printActiveKeyLine(source, summary) {
  if (source === "env") {
    const suffix = summary.keychainPresent
      ? " (overrides the stored key)"
      : "";
    console.log(`Active key: ${accent("FIREWORKS_API_KEY")} from your environment${suffix}.`);
    return;
  }
  if (source === "stored") {
    console.log(`Active key: stored credential — ${summary.backendLabel}.`);
  }
}

/**
 * @param {{ signedIn: boolean|null, email: string, accountId: string, reason: string }} auth
 * @param {boolean} fromEnv
 */
function printAuthLine(auth, fromEnv) {
  if (auth.signedIn === true) {
    console.log(formatSignedInLine(auth));
    return;
  }
  if (auth.reason === "no-key") {
    console.log(`Not signed in. Run ${accent("fireconnect login")} to sign in.`);
    return;
  }
  if (auth.reason === "rejected") {
    // `login` re-stores a key but cannot touch a FIREWORKS_API_KEY the
    // shell exports — tell env users the real fix instead of pointing at it.
    console.log(
      fromEnv
        ? `The Fireworks API rejected the FIREWORKS_API_KEY from your environment. Check or unset it to use a stored key instead.`
        : `A stored key was found, but the Fireworks API rejected it. Run ${accent("fireconnect login")} to replace it.`,
    );
    return;
  }
  console.log(
    `A Fireworks API key is ${fromEnv ? "set in your environment" : "stored"}, but the Fireworks API couldn't be reached to verify it.`,
  );
}

/**
 * @param {{ signedIn: boolean|null, email: string, accountId: string, reason: string }} auth
 */
function formatSignedInLine(auth) {
  const { email, accountId } = auth;
  if (email && accountId) {
    return `${check()} Signed in as ${email} (account: ${accountId}).`;
  }
  const who = identityLabel({ email, accountId });
  return who ? `${check()} Signed in as ${who}.` : `${check()} Signed in.`;
}

/**
 * @param {ReturnType<typeof detectEnvironment>} environment
 */
function printEnvironment(environment) {
  const distro = environment.os.distro?.prettyName ? ` — ${environment.os.distro.prettyName}` : "";
  const version = environment.cliVersion || "?";
  const gitInstall = environment.fireconnect.isGitInstall ? " (git install)" : "";

  printSectionHeader("Environment");
  printField("Platform", `${environment.kind} (${environment.os.platform}/${environment.os.arch})${distro}`);
  printField("Node", environment.node.version);
  printField("Shell", environment.shell || "(unknown)");
  printField("FireConnect", `v${version}${gitInstall}`);
}

/**
 * @param {Awaited<ReturnType<import("../../keys/api-key.mjs").keyStatusSummary>>} summary
 * @param {import("../../keys/api-key.mjs").FireworksKeySource} source
 */
function printStorage(summary, source) {
  const envOnly = source === "env" && !summary.keychainPresent;

  printSectionHeader("Storage");
  if (envOnly) {
    printField("Key stored", "no");
    printField("Secret backend", summary.backendLabel);
    console.log(muted(
      "Your shell's FIREWORKS_API_KEY is in use; nothing is saved to disk. "
        + `Run ${accent("fireconnect login")} to store a key in ${summary.backendLabel}.`,
    ));
    return;
  }

  printField("Config ref", summary.configRef);
  printField("Secret backend", summary.backendLabel);
  if (summary.location && summary.keychainPresent) {
    printField("Location", summary.location);
  }
  if (summary.backendError) {
    printField("Backend issue", summary.backendError);
  }
  printBoolField("Key stored", summary.keychainPresent);
  printBoolField("FIREWORKS_API_KEY in environment", summary.envPresent);
  if (summary.backend === "file" && summary.keychainPresent) {
    console.log("");
    console.log(muted(
      "Sandbox/CI tip: the shell hook exports FIREWORKS_API_KEY for Claude websearch MCP. "
        + "Baked-literal harnesses read the key from their config files. In non-interactive "
        + "shells where `fireconnect` isn't on PATH, export FIREWORKS_API_KEY directly "
        + "(the key is in the encrypted file above).",
    ));
  }
}

/**
 * @param {Array<{ id: string, enabled: boolean, readsFrom: string, storage: string }>} perHarness
 */
function printHarnesses(perHarness) {
  const enabled = perHarness.filter((h) => h.enabled);
  console.log("");
  printSectionHeader("Harnesses");
  if (enabled.length === 0) {
    console.log(muted("  All off."));
    return;
  }
  for (const h of enabled) {
    console.log(`  ${bold(h.id)}  ·  ${h.readsFrom}`);
  }
}
