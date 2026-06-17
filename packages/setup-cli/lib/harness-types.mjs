import { HARNESSES } from "./harness.mjs";

/** @typedef {import("./harness.mjs").HarnessId} HarnessId */

/**
 * @typedef {Object} HarnessContext
 * @property {string} home
 * @property {string} [settingsPath]
 * @property {string} [configPath]
 * @property {string} [dataDir]
 * @property {string} apiKey
 * @property {boolean} apiKeyFromFlag
 * @property {string} baseUrl
 * @property {string} main
 * @property {string} opus
 * @property {string} sonnet
 * @property {string} haiku
 * @property {string} subagent
 * @property {string} slot
 * @property {string} search
 * @property {boolean} json
 */

/**
 * @typedef {Object} HarnessAdapter
 * @property {HarnessId} id
 * @property {string} label
 * @property {(ctx: HarnessContext) => Promise<void>} on
 * @property {(ctx: HarnessContext) => Promise<void>} off
 * @property {(ctx: HarnessContext) => Promise<void>} status
 * @property {(ctx: HarnessContext) => Promise<void>} modelList
 * @property {(ctx: HarnessContext) => Promise<void>} modelSelect
 * @property {(ctx: HarnessContext) => Promise<void>} modelReset
 * @property {(ctx: HarnessContext) => Promise<string>} resolveKey
 */

const REQUIRED_METHODS = [
  "on",
  "off",
  "status",
  "modelList",
  "modelSelect",
  "modelReset",
  "resolveKey",
];

/**
 * @param {HarnessAdapter} adapter
 * @returns {HarnessAdapter}
 */
export function defineHarness(adapter) {
  if (!adapter.id || !HARNESSES.includes(adapter.id)) {
    throw new Error(`Harness adapter id must be one of: ${HARNESSES.join(", ")}`);
  }
  if (!adapter.label) {
    throw new Error(`Harness adapter ${adapter.id} must define label`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Harness adapter ${adapter.id} missing method: ${method}`);
    }
  }
  return adapter;
}

/**
 * @param {HarnessAdapter} adapter
 * @param {{ verb: string, noun?: string }} route
 * @param {HarnessContext} ctx
 */
export async function dispatchHarnessCommand(adapter, route, ctx) {
  const { verb, noun } = route;

  if (noun === "model") {
    if (verb === "list") {
      await adapter.modelList(ctx);
      return;
    }
    if (verb === "select") {
      await adapter.modelSelect(ctx);
      return;
    }
    if (verb === "reset") {
      await adapter.modelReset(ctx);
      return;
    }
    throw new Error(
      `Unknown command: model ${verb}. Run: fireconnect help ${adapter.id}`,
    );
  }

  switch (verb) {
    case "on":
      await adapter.on(ctx);
      return;
    case "off":
      await adapter.off(ctx);
      return;
    case "status":
      await adapter.status(ctx);
      return;
    default:
      throw new Error(
        `Unknown harness command: ${verb}. Run: fireconnect help ${adapter.id}`,
      );
  }
}
