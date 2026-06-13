#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_DATA_DIR,
  FIREWORKS_BASE_URL,
  applyModelMapping,
  defaultModelIds,
  detectApiKeyType,
  disableFireworksProvider,
  enableFireworksProvider,
  isSafeDataDirRemoval,
  mappingFromEnv,
  providerStatePath,
  providerStatusFromEnv,
  readJsonIfExists,
  resolveModelMapping,
  resolveDataDir,
  userSettingsPath,
} from "../lib/fireconnect-core.mjs";
import {
  OPENCODE_API_KEY_ENV_REF,
  disableOpencodeFireworks,
  enableOpencodeFireworks,
  opencodeConfigPath,
  opencodeDataDir,
  opencodeProviderStatus,
} from "../lib/opencode-core.mjs";

const CLI_NAME = "fireconnect";

function parseArgs(argv) {
  const command = argv[0] || "help";
  const options = {
    home: process.env.HOME ?? "",
    settingsPath: "",
    configPath: "",
    harness: "claude-code",
    dataDir: "",
    apiKey: process.env.FIREWORKS_API_KEY ?? "",
    apiKeyFromFlag: false,
    baseUrl: FIREWORKS_BASE_URL,
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    subagent: "",
    json: false,
    positional: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", options: { ...options, positional: [command] } };
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--home") {
      options.home = requireValue(arg, next);
      i += 1;
    } else if (arg === "--settings-path") {
      options.settingsPath = requireValue(arg, next);
      i += 1;
    } else if (arg === "--config-path") {
      options.configPath = requireValue(arg, next);
      i += 1;
    } else if (arg === "--harness") {
      options.harness = requireValue(arg, next);
      if (options.harness !== "claude-code" && options.harness !== "opencode") {
        throw new Error(`--harness must be "claude-code" or "opencode", got: ${options.harness}`);
      }
      i += 1;
    } else if (arg === "--data-dir") {
      options.dataDir = requireValue(arg, next);
      i += 1;
    } else if (arg === "--api-key") {
      options.apiKey = requireValue(arg, next);
      options.apiKeyFromFlag = true;
      i += 1;
    } else if (arg === "--base-url") {
      options.baseUrl = requireValue(arg, next);
      i += 1;
    } else if (arg === "--main" || arg === "--model") {
      options.main = requireValue(arg, next);
      i += 1;
    } else if (arg === "--opus") {
      options.opus = requireValue(arg, next);
      i += 1;
    } else if (arg === "--sonnet") {
      options.sonnet = requireValue(arg, next);
      i += 1;
    } else if (arg === "--haiku") {
      options.haiku = requireValue(arg, next);
      i += 1;
    } else if (arg === "--subagent") {
      options.subagent = requireValue(arg, next);
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      options.positional.push(arg);
    }
  }

  return { command, options };
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function ensureNoPositional(options, command) {
  if (options.positional.length > 0) {
    throw new Error(`${command} does not accept positional arguments`);
  }
}

function ensureHome(options) {
  if (options.harness === "opencode") {
    if (!options.configPath && !options.home) {
      throw new Error("HOME is not set; pass --home or --config-path");
    }
    return;
  }
  if (!options.settingsPath && !options.home) {
    throw new Error("HOME is not set; pass --home or --settings-path");
  }
}

function opencodePathsFor(options) {
  return {
    configPath: opencodeConfigPath(options.home, options.configPath),
    dataDir: opencodeDataDir(options.home, options.dataDir),
  };
}

function pathsFor(options) {
  const settingsPath = userSettingsPath(options.home, options.settingsPath);
  const dataDir = resolveDataDir({
    home: options.home,
    dataDir: options.dataDir,
  });
  return { settingsPath, dataDir };
}

function modelOverridesFrom(options) {
  return {
    main: options.main,
    opus: options.opus,
    sonnet: options.sonnet,
    haiku: options.haiku,
    subagent: options.subagent,
  };
}

function printHelp(command = "") {
  const commandHelp = {
    on: `Usage:
  ${CLI_NAME} on [--api-key <key>] [--main <id>] [--harness opencode]

Route Claude Code (or OpenCode) through Fireworks. Saves a backup of your
previous provider settings so "${CLI_NAME} off" can restore them.

Options:
  --api-key <key>           Fireworks API key. Defaults to FIREWORKS_API_KEY.
  --base-url <url>          Anthropic-compatible URL. Default: ${FIREWORKS_BASE_URL}
  --main, --model <id>      Main model.
  --opus <id>               Model for the opus alias.
  --sonnet <id>             Model for the sonnet alias.
  --haiku <id>              Model for the haiku alias.
  --subagent <id>           Model for subagents.
  --harness opencode        Target OpenCode instead of Claude Code.
  --home <path>             Override HOME for settings resolution.
  --settings-path <path>    Explicit Claude Code settings file.
  --config-path <path>      Explicit opencode.json path (opencode).
  --data-dir <path>           Override backup/state directory.`,
    off: `Usage:
  ${CLI_NAME} off [--harness opencode]

Stop routing through Fireworks and restore your previous provider settings.

Options:
  --harness opencode        Target OpenCode instead of Claude Code.
  --home <path>             Override HOME for settings resolution.
  --settings-path <path>    Explicit Claude Code settings file.
  --config-path <path>      Explicit opencode.json path (opencode).
  --data-dir <path>           Override backup/state directory.`,
    status: `Usage:
  ${CLI_NAME} status [--json] [--harness opencode]

Show the current provider and whether an API key is configured.`,
    list: `Usage:
  ${CLI_NAME} list [--json] [--harness opencode]

Show the default and current model mapping.`,
    set: `Usage:
  ${CLI_NAME} set [--main <id>] [--opus <id>] [--sonnet <id>] [--haiku <id>] [--subagent <id>] [--harness opencode]

Change model aliases without touching provider credentials.`,
    reset: `Usage:
  ${CLI_NAME} reset [--harness opencode]

Reset model aliases to the defaults.`,
    uninstall: `Usage:
  ${CLI_NAME} uninstall

Turn off Fireworks routing and remove FireConnect from this machine
(local data and the CLI launcher).`,
  };

  if (command && commandHelp[command]) {
    console.log(commandHelp[command]);
    return;
  }

  console.log(`FireConnect — use Fireworks models in Claude Code and OpenCode.

Usage:
  ${CLI_NAME} <command> [options]

Commands:
  on         Route Claude Code through Fireworks.
  off        Restore your previous provider.
  status     Show the current provider.
  list       Show the model mapping.
  set        Change model aliases.
  reset      Reset models to defaults.
  uninstall  Remove FireConnect from this machine.
  help       Show help for a command.

Common options:
  --api-key <key>      Fireworks API key (or set FIREWORKS_API_KEY).
  --harness opencode   Manage OpenCode instead of Claude Code.
  --json               Machine-readable output for status/list.

Examples:
  ${CLI_NAME} on --api-key fw_...
  ${CLI_NAME} status
  ${CLI_NAME} set --main kimi-k2p6-turbo
  ${CLI_NAME} off
  ${CLI_NAME} on --harness opencode

Run "${CLI_NAME} help <command>" for all options.
`);
}

async function opencodeListCommand(options) {
  const { configPath } = opencodePathsFor(options);
  const config = await readJsonIfExists(configPath);
  const model = typeof config.model === "string" && config.model.startsWith("fireworks/")
    ? config.model.slice("fireworks/".length)
    : null;

  // OpenCode routes a single default model (no opus/sonnet/haiku alias slots),
  // so the mapping has one entry — same defaults/current shape as Claude Code.
  const payload = {
    harness: "opencode",
    defaults: { main: defaultModelIds().main },
    current: { main: model },
    provider: opencodeProviderStatus(config),
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Default mapping:");
  console.log(`  main -> ${payload.defaults.main}`);
  console.log("");
  console.log(`Current provider: ${payload.provider}`);
  console.log("Current mapping:");
  console.log(`  main -> ${payload.current.main ?? "(unset)"}`);
}

async function listCommand(options) {
  ensureNoPositional(options, "list");
  ensureHome(options);
  if (options.harness === "opencode") {
    await opencodeListCommand(options);
    return;
  }
  const { settingsPath, dataDir } = pathsFor(options);
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const env = settings.env ?? {};
  const token = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey || "";
  const keyType = detectApiKeyType(token);

  const payload = {
    defaults: defaultModelIds(keyType),
    current: mappingFromEnv(env),
    provider: providerStatusFromEnv(env),
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const defaults = payload.defaults;
  if (keyType !== "firepass") {
    console.log("Default mapping:");
    console.log(`  main     -> ${defaults.main}`);
    console.log(`  opus     -> ${defaults.opus}`);
    console.log(`  sonnet   -> ${defaults.sonnet}`);
    console.log(`  haiku    -> ${defaults.haiku}`);
    console.log(`  subagent -> ${defaults.subagent}`);
    console.log("");
  }

  console.log(`Current provider: ${payload.provider}`);
  if (keyType === "firepass") {
    console.log("Key type: Fire Pass (kimi-k2p6-turbo only)");
  }
  console.log("Current mapping:");
  console.log(`  main     -> ${payload.current.main ?? "(unset)"}`);
  console.log(`  opus     -> ${payload.current.opus ?? "(unset)"}`);
  console.log(`  sonnet   -> ${payload.current.sonnet ?? "(unset)"}`);
  console.log(`  haiku    -> ${payload.current.haiku ?? "(unset)"}`);
  console.log(`  subagent -> ${payload.current.subagent ?? "(unset)"}`);
}

async function opencodeStatusCommand(options) {
  const { configPath } = opencodePathsFor(options);
  const config = await readJsonIfExists(configPath);
  const fireworks = config.provider?.fireworks ?? null;
  const payload = {
    harness: "opencode",
    provider: opencodeProviderStatus(config),
    baseUrl: fireworks?.options?.baseURL ?? null,
    hasAuthToken: Boolean(fireworks?.options?.apiKey),
    model: typeof config.model === "string" ? config.model : null,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Harness: opencode`);
  console.log(`Provider: ${payload.provider}`);
  console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
  console.log(`API key configured: ${payload.hasAuthToken ? "yes" : "no"}`);
  console.log(`Model: ${payload.model ?? "(unset)"}`);
}

async function statusCommand(options) {
  ensureNoPositional(options, "status");
  ensureHome(options);
  if (options.harness === "opencode") {
    await opencodeStatusCommand(options);
    return;
  }
  const { settingsPath } = pathsFor(options);
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  const payload = {
    provider: providerStatusFromEnv(env),
    baseUrl: env.ANTHROPIC_BASE_URL ?? null,
    hasAuthToken: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    mapping: mappingFromEnv(env),
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Provider: ${payload.provider}`);
  console.log(`Base URL: ${payload.baseUrl ?? "(unset)"}`);
  console.log(`Auth token present: ${payload.hasAuthToken ? "yes" : "no"}`);
  console.log(`Main model: ${payload.mapping.main ?? "(unset)"}`);
}

async function setCommand(options, commandName = "set") {
  ensureNoPositional(options, commandName);
  ensureHome(options);
  if (options.harness === "opencode") {
    // OpenCode has a single default model; re-run `on` with the new --main.
    const { configPath, dataDir } = opencodePathsFor(options);
    const config = await readJsonIfExists(configPath);
    if (opencodeProviderStatus(config) !== "fireworks") {
      throw new Error(`${commandName} for opencode requires Fireworks to be enabled; run: ${CLI_NAME} on --harness opencode`);
    }
    // Reuse the existing configured key verbatim (it may be a literal key or the
    // {env:...} reference); apiKeyFromFlag=true makes enable write it back as-is.
    const existingKey = config.provider?.fireworks?.options?.apiKey ?? "";
    // `set` without --main keeps the configured model (enable's precedence does
    // that); `reset` must explicitly apply the default, like the Claude Code path.
    const modelId = commandName === "reset"
      ? options.main || defaultModelIds().main
      : options.main;
    const rawKey = options.apiKeyFromFlag ? options.apiKey : existingKey;
    const effectiveKey = rawKey === OPENCODE_API_KEY_ENV_REF
      ? (process.env.FIREWORKS_API_KEY ?? "")
      : rawKey;
    const keyType = detectApiKeyType(effectiveKey);
    const result = await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: options.apiKeyFromFlag ? options.apiKey : existingKey || options.apiKey,
      apiKeyFromFlag: options.apiKeyFromFlag || Boolean(existingKey),
      modelId,
      keyType,
    });
    console.log(`Updated OpenCode model: ${result.model}`);
    return;
  }
  const { settingsPath, dataDir } = pathsFor(options);
  // Resolve the key type from the currently stored token, not just the CLI flag.
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const env = settings.env ?? {};
  const token = options.apiKey || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey || "";
  const keyType = detectApiKeyType(token);
  await applyModelMapping({
    settingsPath,
    mapping: resolveModelMapping(modelOverridesFrom(options), keyType),
  });
  console.log("Updated Claude Code model aliases for Fireworks.");
}

async function onCommand(options) {
  ensureNoPositional(options, "on");
  ensureHome(options);
  if (options.harness === "opencode") {
    const { configPath, dataDir } = opencodePathsFor(options);
    // Re-running `on` without a key in the flag or environment should reuse the
    // key already configured (literal or {env:...} reference), like `set` does.
    let apiKey = options.apiKey;
    let apiKeyFromFlag = options.apiKeyFromFlag;
    let reusedExistingKey = false;
    if (!apiKey) {
      const config = await readJsonIfExists(configPath);
      const existingKey = config.provider?.fireworks?.options?.apiKey ?? "";
      if (existingKey) {
        apiKey = existingKey;
        apiKeyFromFlag = true; // write the existing value back verbatim
        reusedExistingKey = true;
      }
    }
    // Resolve env-ref placeholder to the real key before detecting type.
    const effectiveApiKey = apiKey === OPENCODE_API_KEY_ENV_REF
      ? (process.env.FIREWORKS_API_KEY ?? "")
      : apiKey;
    const keyType = detectApiKeyType(effectiveApiKey);
    const result = await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey,
      apiKeyFromFlag,
      modelId: options.main,
      keyType,
    });
    console.log(`Fireworks provider enabled for OpenCode (model: ${result.model}).`);
    if (reusedExistingKey) {
      console.log("Reused the API key already configured in opencode.json.");
    } else if (result.apiKeyMode === "env-reference") {
      console.log("API key written as {env:FIREWORKS_API_KEY} — keep FIREWORKS_API_KEY set in your shell.");
    } else {
      console.log("API key written into opencode.json (passed via --api-key).");
    }
    if (result.keyType === "firepass") {
      console.log("Fire Pass key detected: using kimi-k2p6-turbo for all aliases.");
    }
    console.log("Restart OpenCode for full effect.");
    return;
  }
  const { settingsPath, dataDir } = pathsFor(options);
  // Resolve the actual token from the same sources enableFireworksProvider uses
  // so the key type detection is accurate even when the CLI key is empty.
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const env = settings.env ?? {};
  const token = options.apiKey || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || state.fireworksApiKey || "";
  const keyType = detectApiKeyType(token);
  await enableFireworksProvider({
    settingsPath,
    dataDir,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    mapping: resolveModelMapping(modelOverridesFrom(options), keyType),
    keyType,
  });
  console.log("Fireworks provider enabled. Restart Claude Code for full effect.");
  if (keyType === "firepass") {
    console.log("Fire Pass key detected: using kimi-k2p6-turbo for all aliases.");
  }
}

async function offCommand(options) {
  ensureNoPositional(options, "off");
  ensureHome(options);
  if (options.harness === "opencode") {
    const { configPath, dataDir } = opencodePathsFor(options);
    await disableOpencodeFireworks({ configPath, dataDir });
    console.log("Fireworks provider disabled for OpenCode; original config restored.");
    return;
  }
  const { settingsPath, dataDir } = pathsFor(options);
  await disableFireworksProvider({ settingsPath, dataDir });
  console.log("Fireworks provider disabled. Restart Claude Code for full effect.");
}

async function removePath(pathToRemove) {
  try {
    await rm(pathToRemove, { recursive: true, force: true });
    return null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    return { path: pathToRemove, message: error.message };
  }
}

async function uninstallCommand(options) {
  ensureNoPositional(options, "uninstall");
  if (options.harness === "opencode") {
    throw new Error("uninstall does not support --harness opencode; use: fireconnect off --harness opencode");
  }
  const home = process.env.HOME ?? "";
  if (!home) {
    throw new Error("HOME is not set; uninstall requires HOME to be set.");
  }
  if (options.home !== home) {
    throw new Error("uninstall does not support --home");
  }
  if (options.settingsPath) {
    throw new Error("uninstall does not support --settings-path");
  }
  options.home = home;
  const { settingsPath, dataDir } = pathsFor(options);

  await disableFireworksProvider({ settingsPath, dataDir });

  const binDir = `${home}/.local/bin`;
  const defaultNew = path.join(home, DEFAULT_DATA_DIR);
  const dataDirsToRemove = new Set([defaultNew]);
  if (isSafeDataDirRemoval(dataDir, home)) {
    dataDirsToRemove.add(dataDir);
  } else if (path.resolve(dataDir) !== path.resolve(defaultNew)) {
    console.warn(`Skipped removing data dir: ${dataDir}`);
  }
  const pathsToRemove = [
    ...dataDirsToRemove,
    `${binDir}/fireconnect`,
  ];
  const removalFailures = [];
  for (const pathToRemove of pathsToRemove) {
    const failure = await removePath(pathToRemove);
    if (failure) {
      removalFailures.push(failure);
    }
  }

  if (removalFailures.length === 0) {
    console.log("FireConnect has been uninstalled from this user environment.");
  } else {
    console.error("FireConnect uninstall completed with errors:");
    for (const { path, message } of removalFailures) {
      console.error(`  ${path}: ${message}`);
    }
    process.exitCode = 1;
  }
  console.log("Restart Claude Code to fully apply changes.");
}

async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "help") {
    printHelp(options.positional[0] || "");
    return;
  }

  if (command === "list") {
    await listCommand(options);
    return;
  }

  if (command === "status") {
    await statusCommand(options);
    return;
  }

  if (command === "set") {
    await setCommand(options);
    return;
  }

  if (command === "on") {
    await onCommand(options);
    return;
  }

  if (command === "off") {
    await offCommand(options);
    return;
  }

  if (command === "reset") {
    await setCommand(options, "reset");
    return;
  }

  if (command === "uninstall") {
    await uninstallCommand(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
