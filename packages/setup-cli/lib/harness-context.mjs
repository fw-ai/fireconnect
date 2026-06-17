import {
  resolveDataDir,
  userSettingsPath,
} from "./fireconnect-core.mjs";
import {
  opencodeConfigPath,
  opencodeDataDir,
} from "./opencode-core.mjs";

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
export function modelOverridesFrom(ctx) {
  return {
    main: ctx.main,
    opus: ctx.opus,
    sonnet: ctx.sonnet,
    haiku: ctx.haiku,
    subagent: ctx.subagent,
  };
}

/**
 * @param {HarnessContext} ctx
 * @param {"claude" | "opencode"} harnessId
 */
export function ensureHomeForHarness(ctx, harnessId) {
  if (harnessId === "opencode") {
    if (!ctx.configPath && !ctx.home) {
      throw new Error("HOME is not set; pass --home or --config-path");
    }
    return;
  }
  if (!ctx.settingsPath && !ctx.home) {
    throw new Error("HOME is not set; pass --home or --settings-path");
  }
}
