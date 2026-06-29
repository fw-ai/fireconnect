import {
  resolveDataDir,
  userSettingsPath,
} from "./fireconnect-core.mjs";
import {
  codexConfigPath,
  codexCatalogPath,
  codexDataDir,
} from "./codex-core.mjs";
import {
  opencodeConfigPath,
  opencodeDataDir,
} from "./opencode-core.mjs";
import {
  piAuthPath,
  piDataDir,
  piModelsPath,
  piSettingsPath,
} from "./pi-core.mjs";
import { cursorStateDbPath } from "./cursor-core.mjs";
import { chatLanguageModelsPath, vscodeStateDbPath } from "./vscode-core.mjs";

/** @typedef {import("./harness-types.mjs").HarnessContext} HarnessContext */

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
    dataDir: resolveDataDir({ home: ctx.home, dataDir: ctx.dataDir }),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function vscodePathsFor(ctx) {
  return {
    vscodePath: chatLanguageModelsPath({ home: ctx.home, vscodePath: ctx.vscodePath }),
    stateDbPath: vscodeStateDbPath({ home: ctx.home, vscodePath: ctx.vscodePath }),
    dataDir: resolveDataDir({ home: ctx.home, dataDir: ctx.dataDir }),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function modelOverridesFrom(ctx) {
  return {
    main: ctx.main,
    opus: ctx.opus,
    sonnet: ctx.sonnet,
    haiku: ctx.haiku,
    subagent: ctx.subagent,
  };
}

/** Per-harness path-override fields + the flag to suggest in the error message. */
const HOME_VALIDATION = {
  claude: { fields: ["settingsPath"], flag: "--settings-path" },
  opencode: { fields: ["configPath"], flag: "--config-path" },
  codex: { fields: ["configPath"], flag: "--config-path" },
  pi: { fields: ["settingsPath", "configPath"], flag: "--settings-path" },
  cursor: { fields: ["dbPath"], flag: "--db-path" },
  vscode: { fields: ["vscodePath"], flag: "--vscode-path" },
};

/**
 * @param {HarnessContext} ctx
 * @param {"claude" | "opencode" | "codex" | "pi" | "cursor" | "vscode"} harnessId
 */
export function ensureHomeForHarness(ctx, harnessId) {
  const req = HOME_VALIDATION[harnessId] ?? HOME_VALIDATION.claude;
  const hasOverride = req.fields.some((field) => ctx[field]);
  if (!hasOverride && !ctx.home) {
    throw new Error(`HOME is not set; pass --home or ${req.flag}`);
  }
}
