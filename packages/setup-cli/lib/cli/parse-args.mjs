import process from "node:process";
import { FIREWORKS_BASE_URL } from "../fireworks/model-id.mjs";
import { ROUTING_PREFERENCE_LEVELS, normalizeRoutingPreference } from "../firerouter/core.mjs";
import { HARNESSES } from "../harness/id.mjs";
import { parseDemoArgs } from "../demo/parse-demo-args.mjs";
import { withSuggestion } from "../ui.mjs";

const GLOBAL_COMMANDS = new Set([
  "login", "logout", "status", "model", "configure", "uninstall", "upgrade",
  "help", "key", "banner", "finalize-install",
]);
// `key export` is internal plumbing (apiKeyHelper + shell hooks), not a
// user-facing command; the `key` namespace is intentionally undocumented.
const KEY_SUBCOMMANDS = new Set(["export"]);
const HARNESS_VERBS = new Set(["on", "off", "status", "usage", "live"]);

/**
 * Flags that were renamed/retired, mapped to their current spelling. Typing an
 * old name gets an exact "use X instead" instead of a fuzzy did-you-mean.
 */
const RENAMED_FLAGS = {
  "--main": "--model",
  "--router": "--model firerouter",
  "--model-id": "--model",
  "--anthropic-key": "--anthropic-api-key",
  "--last_n": "--last-n",
};

const RETIRED_FLAG_MESSAGES = {
  "--openai-api-key":
    "--openai-api-key is no longer supported: FireRouter supports Anthropic BYOK only. Use --anthropic-api-key.",
};

/** Every flag the parser understands — used only for typo suggestions. */
const KNOWN_FLAGS = [
  "--help", "--version", "--json", "--home", "--settings-path", "--config-path",
  "--data-dir", "--api-key", "--base-url", "--azure", "--provider",
  "--anthropic-api-key", "--model", "--opus",
  "--sonnet", "--haiku", "--fable", "--subagent", "--search",
  "--db-path", "--vscode-path", "--force", "--stored-only",
  "--last-n", "--plain", "--verbose", "--routing-preference", "--session", "--days",
  "--account", "--anthropic", "--paste", "--revoke", "--with-token",
  "--interactive", "--non-interactive",
];

function helpHint(harnessId = "") {
  return harnessId
    ? `Run: fireconnect ${harnessId} help`
    : "Run: fireconnect help";
}

function withContextualHelp(message, positionals = []) {
  if (message.includes("Run: fireconnect")) {
    return message;
  }
  const harnessId = HARNESSES.includes(positionals[0]) ? positionals[0] : "";
  return `${message} ${helpHint(harnessId)}`;
}

/**
 * @typedef {import("../harness/types.mjs").HarnessContext} HarnessContext
 */

/**
 * @returns {HarnessContext}
 */
export function createBaseContext() {
  return {
    home: process.env.HOME ?? "",
    settingsPath: "",
    configPath: "",
    dataDir: "",
    apiKey: "",
    apiKeyFromFlag: false,
    baseUrl: FIREWORKS_BASE_URL,
    baseUrlFromFlag: false,
    routingPreference: null,
    azure: false,
    provider: "",
    anthropicKey: "",
    anthropicKeyFromFlag: false,
    anthropic: false,
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    fable: "",
    subagent: "",
    search: "",
    session: "",
    days: 0,
    lastN: "",
    verbose: false,
    plain: false,
    json: false,
    dbPath: "",
    force: false,
    storedOnly: false,
    vscodePath: "",
    withToken: false,
    revoke: false,
    paste: false,
    account: "",
    onboardingMode: "auto",
  };
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * A positive whole number of days for `--days`.
 *
 * Rejects 0 and negatives rather than clamping: `--days 0` reads as "no
 * lookback", and silently treating it as 3 would show sessions the user asked to
 * exclude. Capped at 365 so a stray `--days 99999` cannot walk the whole
 * project history pricing every log it finds.
 */
function requireDays(flag, value) {
  const raw = requireValue(flag, value);
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`${flag} must be a whole number of days between 1 and 365`);
  }
  return days;
}

function requireRoutingPreference(flag, value) {
  const raw = requireValue(flag, value);
  const preference = normalizeRoutingPreference(raw);
  if (preference === null) {
    const names = Object.keys(ROUTING_PREFERENCE_LEVELS).join(", ");
    throw new Error(`${flag} must be one of: ${names} (or 1-5)`);
  }
  return preference;
}

/**
 * Apply one global (command-agnostic) flag to `ctx`. Shared by the main parser
 * and the demo parser so global-flag knowledge lives in exactly one place — the
 * demo folder only owns demo-specific flags. Does NOT handle `--help`/`--version`
 * (those short-circuit their callers).
 *
 * @param {object} ctx @param {string} arg @param {string|undefined} next
 * @returns {boolean|null} true = value flag (caller must skip `next`);
 *   false = boolean flag; null = not a global flag (caller decides).
 */
export function applyGlobalFlag(ctx, arg, next) {
  switch (arg) {
    case "--json": ctx.json = true; return false;
    case "--verbose":
    case "-v": ctx.verbose = true; return false;
    case "--plain": ctx.plain = true; return false;
    case "--routing-preference": ctx.routingPreference = requireRoutingPreference(arg, next); return true;
    case "--azure": ctx.azure = true; ctx.provider = "azure"; return false;
    case "--force": ctx.force = true; return false;
    case "--stored-only": ctx.storedOnly = true; return false;
    case "--with-token": ctx.withToken = true; return false;
    case "--paste": ctx.paste = true; return false;
    // `login --account <id>`: enterprise SSO sign-in via the account's own
    // identity provider (same semantics as `firectl signin <account-id>`).
    case "--account": ctx.account = requireValue(arg, next); return true;
    case "--revoke": ctx.revoke = true; return false;
    case "--anthropic": ctx.anthropic = true; return false;
    case "--interactive":
      if (ctx.onboardingMode === "skip") {
        throw new Error("--interactive and --non-interactive cannot be used together");
      }
      ctx.onboardingMode = "prompt";
      return false;
    case "--non-interactive":
      if (ctx.onboardingMode === "prompt") {
        throw new Error("--interactive and --non-interactive cannot be used together");
      }
      ctx.onboardingMode = "skip";
      return false;
    case "--home": ctx.home = requireValue(arg, next); return true;
    case "--settings-path": ctx.settingsPath = requireValue(arg, next); return true;
    case "--config-path": ctx.configPath = requireValue(arg, next); return true;
    case "--data-dir": ctx.dataDir = requireValue(arg, next); return true;
    case "--api-key": ctx.apiKey = requireValue(arg, next); ctx.apiKeyFromFlag = true; return true;
    case "--base-url": ctx.baseUrl = requireValue(arg, next); ctx.baseUrlFromFlag = true; return true;
    case "--provider": ctx.provider = requireValue(arg, next); return true;
    case "--anthropic-api-key": ctx.anthropicKey = requireValue(arg, next); ctx.anthropicKeyFromFlag = true; return true;
    case "--model": ctx.main = requireValue(arg, next); return true;
    case "--opus": ctx.opus = requireValue(arg, next); return true;
    case "--sonnet": ctx.sonnet = requireValue(arg, next); return true;
    case "--haiku": ctx.haiku = requireValue(arg, next); return true;
    case "--fable": ctx.fable = requireValue(arg, next); return true;
    case "--subagent": ctx.subagent = requireValue(arg, next); return true;
    case "--search": ctx.search = requireValue(arg, next); return true;
    case "--session": ctx.session = requireValue(arg, next); return true;
    case "--days": ctx.days = requireDays(arg, next); return true;
    case "--last-n": ctx.lastN = requireValue(arg, next); return true;
    case "--db-path": ctx.dbPath = requireValue(arg, next); return true;
    case "--vscode-path": ctx.vscodePath = requireValue(arg, next); return true;
    default: return null;
  }
}

/**
 * @param {string[]} argv
 */
function parseFlagsAndPositionals(argv) {
  const ctx = createBaseContext();
  const positional = [];
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      const explicitTopic = next && !next.startsWith("--") ? next : "";
      return {
        ctx,
        positional,
        help: true,
        helpTopic: explicitTopic || positional[positional.length - 1] || "",
        version: false,
      };
    }

    if (arg === "--version" || arg === "-V") {
      version = true;
      continue;
    }

    let consumed;
    try {
      consumed = applyGlobalFlag(ctx, arg, next);
    } catch (error) {
      throw new Error(withContextualHelp(
        error instanceof Error ? error.message : String(error),
        positional,
      ));
    }
    if (consumed === true) {
      i += 1;
    } else if (consumed === null) {
      if (arg.startsWith("--")) {
        const retiredMessage = RETIRED_FLAG_MESSAGES[arg];
        if (retiredMessage) {
          throw new Error(retiredMessage);
        }
        const renamedTo = RENAMED_FLAGS[arg];
        if (renamedTo) {
          throw new Error(`Unknown argument: ${arg}. Use ${renamedTo} instead.`);
        }
        throw new Error(withContextualHelp(
          withSuggestion(`Unknown argument: ${arg}.`, arg, KNOWN_FLAGS),
          positional,
        ));
      }
      positional.push(arg);
    }
    // consumed === false → a boolean global flag; already applied.
  }

  return { ctx, positional, help: false, helpTopic: "", version };
}

/**
 * @param {string} harnessId
 * @param {string[]} tokens
 */
function parseHarnessRoute(harnessId, tokens) {
  if (tokens.length === 0) {
    return { harnessId, verb: "on", noun: "" };
  }

  const verb = tokens[0];
  if (!HARNESS_VERBS.has(verb)) {
    throw new Error(`${withSuggestion(
      `Unknown harness command: ${tokens.join(" ")}.`,
      verb,
      HARNESS_VERBS,
    )} ${helpHint(harnessId)}`);
  }
  if (tokens.length > 1) {
    throw new Error(
      `fireconnect ${harnessId} ${verb} does not accept positional arguments. `
        + helpHint(harnessId),
    );
  }

  return { harnessId, verb, noun: "" };
}

/**
 * Locate the command token (first positional), tolerating leading global flags
 * so `fireconnect --json demo` resolves the same as `fireconnect demo --json`.
 * Skips global value-flags via applyGlobalFlag (on a throwaway ctx) so a value
 * like `--home /x` isn't mistaken for the command. Returns index -1 when the
 * command can't be determined from the prefix (help/version/unknown flag) — the
 * normal parser then handles it.
 * @param {string[]} argv @returns {{ index: number, command: string|null }}
 */
function findCommand(argv) {
  const scratch = createBaseContext();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") {
      return { index: -1, command: null };
    }
    if (!arg.startsWith("-")) {
      return { index: i, command: arg };
    }
    let consumed;
    try {
      consumed = applyGlobalFlag(scratch, arg, argv[i + 1]);
    } catch (error) {
      throw new Error(withContextualHelp(
        error instanceof Error ? error.message : String(error),
      ));
    }
    if (consumed === true) {
      i += 1;
    } else if (consumed === null) {
      return { index: -1, command: null }; // unknown flag before any command
    }
  }
  return { index: -1, command: null };
}

/**
 * @param {string[]} argv
 */
export function parseCli(argv) {
  // `demo` is a self-contained subcommand: its full flag grammar lives in the
  // demo folder, so the shared parser never has to know about demo-only flags.
  // Detect it as the first positional (not just argv[0]) so global flags may
  // precede it, then hand off everything but the `demo` token.
  const cmd = findCommand(argv);
  if (cmd.command === "demo") {
    const rest = argv.slice(0, cmd.index).concat(argv.slice(cmd.index + 1));
    return parseDemoArgs(rest, createBaseContext());
  }

  const { ctx, positional, help, helpTopic, version } = parseFlagsAndPositionals(argv);

  if (version) {
    return { kind: "global", command: "version", ctx };
  }

  if (help) {
    return { kind: "global", command: "help", ctx, helpTopic };
  }

  // Bare `fireconnect` opens the interactive launcher (which falls back to
  // help when not attached to a TTY). Help stays reachable via `help`/`--help`.
  if (positional.length === 0) {
    if (ctx.onboardingMode !== "auto") {
      const flag = ctx.onboardingMode === "prompt" ? "--interactive" : "--non-interactive";
      throw new Error(`${flag} applies only to \`fireconnect claude on\`. Run: fireconnect help`);
    }
    return { kind: "global", command: "launcher", ctx };
  }

  const first = positional[0];
  const rest = positional.slice(1);

  if (first === "help") {
    return { kind: "global", command: "help", ctx, helpTopic: rest[0] ?? "" };
  }

  if (first === "model") {
    if (rest[0] !== "list" || rest.length !== 1) {
      throw new Error(
        `Unexpected model subcommand: ${rest[0] || "(missing)"}. `
          + "Run: fireconnect help",
      );
    }
    return { kind: "global", command: "model", modelSubcommand: "list", ctx };
  }

  if (GLOBAL_COMMANDS.has(first)) {
    if (ctx.onboardingMode !== "auto") {
      const flag = ctx.onboardingMode === "prompt" ? "--interactive" : "--non-interactive";
      throw new Error(`${flag} applies only to \`fireconnect claude on\`. Run: fireconnect help`);
    }
    if (first === "key") {
      const subcommand = rest[0];
      if (!subcommand || !KEY_SUBCOMMANDS.has(subcommand)) {
        throw new Error(
          "Unknown key command. Manage your key with `fireconnect login`, "
            + "`fireconnect logout`, or `fireconnect status`. Run: fireconnect help",
        );
      }
      if (rest.length > 1) {
        throw new Error(
          `fireconnect key ${subcommand} does not accept positional arguments. `
            + helpHint(),
        );
      }
      return { kind: "global", command: "key", keySubcommand: subcommand, ctx };
    }
    if (rest.length > 0) {
      throw new Error(`${first} does not accept positional arguments. ${helpHint()}`);
    }
    return { kind: "global", command: first, ctx };
  }

  if (HARNESSES.includes(first)) {
    if (rest[0] === "help") {
      return { kind: "global", command: "help", ctx, helpTopic: first };
    }
    return { kind: "harness", route: parseHarnessRoute(first, rest), ctx };
  }

  throw new Error(`${withSuggestion(
    `Unknown command: ${first}.`,
    first,
    [...GLOBAL_COMMANDS, ...HARNESSES],
  )} ${helpHint()}`);
}
