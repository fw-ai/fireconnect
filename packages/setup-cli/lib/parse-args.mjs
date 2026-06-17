import process from "node:process";
import { FIREWORKS_BASE_URL } from "./fireconnect-core.mjs";
import { HARNESSES } from "./harness.mjs";

const GLOBAL_COMMANDS = new Set(["configure", "uninstall", "upgrade", "help"]);
const HARNESS_VERBS = new Set(["on", "off", "status"]);

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
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    subagent: "",
    slot: "",
    search: "",
    json: false,
    harnesses: "",
    apiKeyMode: "",
  };
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * @param {string[]} argv
 */
function parseFlagsAndPositionals(argv) {
  const ctx = createBaseContext();
  const positional = [];

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
      };
    }

    if (arg === "--json") {
      ctx.json = true;
    } else if (arg === "--home") {
      ctx.home = requireValue(arg, next);
      i += 1;
    } else if (arg === "--settings-path") {
      ctx.settingsPath = requireValue(arg, next);
      i += 1;
    } else if (arg === "--config-path") {
      ctx.configPath = requireValue(arg, next);
      i += 1;
    } else if (arg === "--data-dir") {
      ctx.dataDir = requireValue(arg, next);
      i += 1;
    } else if (arg === "--api-key") {
      ctx.apiKey = requireValue(arg, next);
      ctx.apiKeyFromFlag = true;
      i += 1;
    } else if (arg === "--base-url") {
      ctx.baseUrl = requireValue(arg, next);
      i += 1;
    } else if (arg === "--main" || arg === "--model") {
      ctx.main = requireValue(arg, next);
      i += 1;
    } else if (arg === "--opus") {
      ctx.opus = requireValue(arg, next);
      i += 1;
    } else if (arg === "--sonnet") {
      ctx.sonnet = requireValue(arg, next);
      i += 1;
    } else if (arg === "--haiku") {
      ctx.haiku = requireValue(arg, next);
      i += 1;
    } else if (arg === "--subagent") {
      ctx.subagent = requireValue(arg, next);
      i += 1;
    } else if (arg === "--slot") {
      ctx.slot = requireValue(arg, next);
      i += 1;
    } else if (arg === "--search") {
      ctx.search = requireValue(arg, next);
      i += 1;
    } else if (arg === "--harnesses") {
      ctx.harnesses = requireValue(arg, next);
      i += 1;
    } else if (arg === "--api-key-mode") {
      ctx.apiKeyMode = requireValue(arg, next);
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { ctx, positional, help: false, helpTopic: "" };
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
    if (sub !== "list" && sub !== "select" && sub !== "reset") {
      throw new Error(`Usage: fireconnect ${harnessId} model <list|select|reset>`);
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
 * @param {string[]} argv
 */
export function parseCli(argv) {
  const { ctx, positional, help, helpTopic } = parseFlagsAndPositionals(argv);

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
    return { kind: "harness", route, ctx };
  }

  throw new Error(`Unknown command: ${first}. Run: fireconnect help`);
}
