import process from "node:process";
import { FIREWORKS_BASE_URL } from "./fireconnect-core.mjs";
import { HARNESSES } from "./harness.mjs";
import { parseDemoArgs } from "./demo/parse-demo-args.mjs";

const GLOBAL_COMMANDS = new Set(["login", "logout", "status", "configure", "uninstall", "upgrade", "help", "key"]);
// `key export` is internal plumbing (apiKeyHelper + shell hooks), not a
// user-facing command; the `key` namespace is intentionally undocumented.
const KEY_SUBCOMMANDS = new Set(["export"]);
const HARNESS_VERBS = new Set(["on", "off", "status", "usage"]);

/**
 * @typedef {import("./harness-types.mjs").HarnessContext} HarnessContext
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
    router: false,
    azure: false,
    provider: "",
    anthropicKey: "",
    anthropicKeyFromFlag: false,
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    fable: "",
    subagent: "",
    slot: "",
    search: "",
    session: "",
    lastN: "",
    verbose: false,
    json: false,
    dbPath: "",
    mode: "",
    force: false,
    storedOnly: false,
    vscodePath: "",
    withToken: false,
    revoke: false,
    paste: false,
  };
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
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
    case "--router": ctx.router = true; return false;
    case "--azure": ctx.azure = true; ctx.provider = "azure"; return false;
    case "--force": ctx.force = true; return false;
    case "--stored-only": ctx.storedOnly = true; return false;
    case "--with-token": ctx.withToken = true; return false;
    case "--paste": ctx.paste = true; return false;
    case "--revoke": ctx.revoke = true; return false;
    case "--home": ctx.home = requireValue(arg, next); return true;
    case "--settings-path": ctx.settingsPath = requireValue(arg, next); return true;
    case "--config-path": ctx.configPath = requireValue(arg, next); return true;
    case "--data-dir": ctx.dataDir = requireValue(arg, next); return true;
    case "--api-key": ctx.apiKey = requireValue(arg, next); ctx.apiKeyFromFlag = true; return true;
    case "--base-url": ctx.baseUrl = requireValue(arg, next); ctx.baseUrlFromFlag = true; return true;
    case "--provider": ctx.provider = requireValue(arg, next); return true;
    case "--anthropic-key":
    case "--anthropic-api-key": ctx.anthropicKey = requireValue(arg, next); ctx.anthropicKeyFromFlag = true; return true;
    case "--main":
    case "--model": ctx.main = requireValue(arg, next); return true;
    case "--opus": ctx.opus = requireValue(arg, next); return true;
    case "--sonnet": ctx.sonnet = requireValue(arg, next); return true;
    case "--haiku": ctx.haiku = requireValue(arg, next); return true;
    case "--fable": ctx.fable = requireValue(arg, next); return true;
    case "--subagent": ctx.subagent = requireValue(arg, next); return true;
    case "--slot": ctx.slot = requireValue(arg, next); return true;
    case "--search": ctx.search = requireValue(arg, next); return true;
    case "--session": ctx.session = requireValue(arg, next); return true;
    case "--last_n":
    case "--last-n": ctx.lastN = requireValue(arg, next); return true;
    case "--db-path": ctx.dbPath = requireValue(arg, next); return true;
    case "--mode": ctx.mode = requireValue(arg, next); return true;
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

    const consumed = applyGlobalFlag(ctx, arg, next);
    if (consumed === true) {
      i += 1;
    } else if (consumed === null) {
      if (arg.startsWith("--")) {
        throw new Error(`Unknown argument: ${arg}`);
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

  if (tokens[0] === "model") {
    const sub = tokens[1];
    if (sub === "add") {
      // `model add` takes one optional positional: the model id to register.
      if (tokens.length > 3) {
        throw new Error(`fireconnect ${harnessId} model add takes at most one model id`);
      }
      return { harnessId, noun: "model", verb: "add", arg: tokens[2] ?? "" };
    }
    if (sub !== "list" && sub !== "select" && sub !== "reset") {
      throw new Error(`Usage: fireconnect ${harnessId} model <list|select|reset|add>`);
    }
    if (tokens.length > 2) {
      throw new Error(`fireconnect ${harnessId} model ${sub} does not accept positional arguments`);
    }
    return { harnessId, noun: "model", verb: sub };
  }

  const verb = tokens[0];
  if (!HARNESS_VERBS.has(verb)) {
    throw new Error(`Unknown harness command: ${tokens.join(" ")}. Run: fireconnect help ${harnessId}`);
  }
  if (tokens.length > 1) {
    throw new Error(`fireconnect ${harnessId} ${verb} does not accept positional arguments`);
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
    const consumed = applyGlobalFlag(scratch, arg, argv[i + 1]);
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

  const first = positional[0] ?? "help";
  const rest = positional.slice(1);

  if (first === "help") {
    return { kind: "global", command: "help", ctx, helpTopic: rest[0] ?? "" };
  }

  if (first === "model") {
    throw new Error(
      "model commands are harness-scoped. Use: fireconnect <harness> model <list|select|reset> "
      + "(e.g. fireconnect claude model list)",
    );
  }

  if (GLOBAL_COMMANDS.has(first)) {
    if (first === "key") {
      const subcommand = rest[0];
      if (!subcommand || !KEY_SUBCOMMANDS.has(subcommand)) {
        throw new Error("Unknown command. Manage your key with `fireconnect login`, `fireconnect logout`, or `fireconnect status`.");
      }
      if (rest.length > 1) {
        throw new Error(`fireconnect key ${subcommand} does not accept positional arguments`);
      }
      return { kind: "global", command: "key", keySubcommand: subcommand, ctx };
    }
    if (rest.length > 0) {
      throw new Error(`${first} does not accept positional arguments`);
    }
    return { kind: "global", command: first, ctx };
  }

  if (HARNESSES.includes(first)) {
    if (rest[0] === "help") {
      return { kind: "global", command: "help", ctx, helpTopic: first };
    }
    const route = parseHarnessRoute(first, rest);
    // Fold a `model add <id>` positional into ctx.main so the handler reads it
    // the same way as `--model`/`--main`. An explicit flag wins over positional.
    if (route.arg && !ctx.main) {
      ctx.main = route.arg;
    }
    return { kind: "harness", route, ctx };
  }

  throw new Error(`Unknown command: ${first}. Run: fireconnect help`);
}
