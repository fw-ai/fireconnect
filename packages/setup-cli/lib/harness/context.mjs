import {
  resolveDataDir,
  userSettingsPath,
} from "../harnesses/claude/core.mjs";
import {
  codexConfigPath,
  codexCatalogPath,
  codexDataDir,
} from "../harnesses/codex/core.mjs";
import {
  deepseekCredentialsPath,
  deepseekDataDir,
  deepseekSettingsPath,
} from "../harnesses/deepseek/core.mjs";
import {
  opencodeConfigPath,
  opencodeDataDir,
} from "../harnesses/opencode/core.mjs";
import {
  piAuthPath,
  piDataDir,
  piModelsPath,
  piSettingsPath,
} from "../harnesses/pi/core.mjs";
import { cursorStateDbPath, cursorDataDir } from "../harnesses/cursor/core.mjs";
import { chatLanguageModelsPath, vscodeDataDir, vscodeStateDbPath } from "../harnesses/vscode/core.mjs";
import { copilotDataDir } from "../harnesses/copilot-app/core.mjs";
import { copilotDataDbPath } from "../harnesses/copilot-app/sqlite.mjs";
import {
  copilotCliDataDir,
  copilotProvidersPath,
  copilotSettingsPath,
} from "../harnesses/copilot-cli/config.mjs";

/** @typedef {import("./types.mjs").HarnessContext} HarnessContext */

/**
 * @param {HarnessContext} ctx
 */
export function claudePathsFor(ctx) {
  return {
    settingsPath: userSettingsPath(ctx.home, ctx.settingsPath),
    dataDir: resolveDataDir({ home: ctx.home, dataDir: ctx.dataDir }),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function opencodePathsFor(ctx) {
  return {
    configPath: opencodeConfigPath(ctx.home, ctx.configPath),
    dataDir: opencodeDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function codexPathsFor(ctx) {
  return {
    configPath: codexConfigPath(ctx.home, ctx.configPath),
    dataDir: codexDataDir(ctx.home, ctx.dataDir),
    catalogPath: codexCatalogPath(ctx.home, ctx.catalogPath),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function piPathsFor(ctx) {
  const settingsPath = piSettingsPath(ctx.home, ctx.settingsPath || ctx.configPath);
  return {
    settingsPath,
    authPath: piAuthPath(ctx.home, "", settingsPath),
    modelsPath: piModelsPath(ctx.home, settingsPath),
    dataDir: piDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function cursorPathsFor(ctx) {
  return {
    dbPath: cursorStateDbPath({ home: ctx.home, dbPath: ctx.dbPath }),
    dataDir: cursorDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function vscodePathsFor(ctx) {
  return {
    vscodePath: chatLanguageModelsPath({ home: ctx.home, vscodePath: ctx.vscodePath }),
    stateDbPath: vscodeStateDbPath({ home: ctx.home, vscodePath: ctx.vscodePath }),
    dataDir: vscodeDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function copilotAppPathsFor(ctx) {
  return {
    dbPath: copilotDataDbPath({ home: ctx.home, dbPath: ctx.dbPath }),
    dataDir: copilotDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * The CLI harness's paths live in its own data dir so its backup can never
 * collide with the desktop harness's.
 * @param {HarnessContext} ctx
 */
export function copilotCliPathsFor(ctx) {
  return {
    providersPath: copilotProvidersPath({ home: ctx.home, providersPath: ctx.providersPath }),
    settingsPath: copilotSettingsPath({ home: ctx.home }),
    dataDir: copilotCliDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function deepseekPathsFor(ctx) {
  const settingsPath = deepseekSettingsPath(ctx.home, ctx.configPath);
  return {
    settingsPath,
    credentialsPath: deepseekCredentialsPath(ctx.home, { settingsPath }),
    dataDir: deepseekDataDir(ctx.home, ctx.dataDir),
  };
}

/** Per-harness path-override fields + the flag to suggest in the error message. */
const HOME_VALIDATION = {
  claude: { fields: ["settingsPath"], flag: "--settings-path" },
  opencode: { fields: ["configPath"], flag: "--config-path" },
  codex: { fields: ["configPath"], flag: "--config-path" },
  pi: { fields: ["settingsPath", "configPath"], flag: "--settings-path" },
  cursor: { fields: ["dbPath"], flag: "--db-path" },
  "copilot-app": { fields: ["dbPath"], flag: "--db-path" },
  "copilot-cli": { fields: ["providersPath"], flag: "--providers-path" },
  vscode: { fields: ["vscodePath"], flag: "--vscode-path" },
  copilot: { fields: ["dbPath"], flag: "--db-path" },
  deepseek: { fields: ["configPath"], flag: "--config-path" },
};

/**
 * @param {HarnessContext} ctx
 * @param {"claude" | "opencode" | "codex" | "pi" | "cursor" | "vscode" | "copilot" | "deepseek"} harnessId
 */
export function ensureHomeForHarness(ctx, harnessId) {
  const req = HOME_VALIDATION[harnessId] ?? HOME_VALIDATION.claude;
  const hasOverride = req.fields.some((field) => ctx[field]);
  if (!hasOverride && !ctx.home) {
    throw new Error(`HOME is not set; pass --home or ${req.flag}`);
  }
}
