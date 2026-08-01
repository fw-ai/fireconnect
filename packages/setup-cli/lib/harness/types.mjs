import { HARNESSES } from "./id.mjs";

/** @typedef {import("./id.mjs").HarnessId} HarnessId */

/**
 * @typedef {Object} HarnessContext
 * @property {string} home
 * @property {string} [settingsPath]
 * @property {string} [configPath]
 * @property {string} [dataDir]
 * @property {string} apiKey
 * @property {boolean} apiKeyFromFlag
 * @property {string} baseUrl
 * @property {boolean} [baseUrlFromFlag]
 * @property {number|null} [routingPreference] // x-routing-preference header value (1-5); null = unset (FireRouter default)
 * @property {boolean} [azure]
 * @property {string} [provider]
 * @property {string} anthropicKey
 * @property {boolean} anthropicKeyFromFlag
 * @property {string} main
 * @property {string} opus
 * @property {string} sonnet
 * @property {string} haiku
 * @property {string} fable
 * @property {string} subagent
 * @property {string} search
 * @property {string} [session] // claude usage: session id prefix or explicit .jsonl path
 * @property {string} [lastN]   // claude usage: latest N parent sessions
 * @property {boolean} [verbose]
 * @property {boolean} [plain]   // claude usage: force plain summary instead of interactive TUI
 * @property {"auto"|"prompt"|"skip"} [onboardingMode] // claude on model onboarding policy
 * @property {boolean} json
 * @property {string} [dbPath]   // cursor: explicit state.vscdb path
 * @property {boolean} [force]   // cursor/vscode: write even if the IDE is running
 * @property {boolean} [storedOnly] // key export: prefer secret store; env only when nothing stored
 * @property {string} [vscodePath]      // vscode: explicit chatLanguageModels.json path
 */

/**
 * @typedef {Object} HarnessAdapter
 * @property {HarnessId} id
 * @property {string} label
 * @property {(ctx: HarnessContext) => Promise<void|{ cancelled?: boolean }>} on
 * @property {(ctx: HarnessContext) => Promise<void>} off
 * @property {(ctx: HarnessContext) => Promise<void>} status
 * @property {(ctx: HarnessContext) => Promise<void>} [usage]
 * @property {(ctx: HarnessContext) => Promise<string>} resolveKey
 * @property {(ctx: HarnessContext) => Promise<HarnessContext>} [resolveOnContext]
 *   Resolve state-dependent defaults needed before validating `on` options.
 * @property {{ byok?: "none"|"value"|"envref", autoCatalog?: boolean, catalogByok?: boolean }|null} [firerouter]
 */

const REQUIRED_METHODS = [
  "on",
  "off",
  "status",
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
 * @returns {Promise<void|{ cancelled?: boolean }>}
 */
export async function dispatchHarnessCommand(adapter, route, ctx) {
  const { verb } = route;

  switch (verb) {
    case "on":
      return adapter.on(ctx);
    case "off":
      await adapter.off(ctx);
      return;
    case "status":
      await adapter.status(ctx);
      return;
    case "usage":
      if (typeof adapter.usage !== "function") {
        throw new Error(
          `usage is not supported for ${adapter.id}. Run: fireconnect ${adapter.id} help`,
        );
      }
      await adapter.usage(ctx);
      return;
    default:
      throw new Error(
        `Unknown harness command: ${verb}. Run: fireconnect ${adapter.id} help`,
      );
  }
}
