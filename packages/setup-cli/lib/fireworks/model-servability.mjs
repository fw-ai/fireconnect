import { isAutoModelId, isFirerouterModelPattern } from "./model-specs.mjs";
import {
  isGatewayAnthropicSlot,
  shortFireworksModelRef,
  fireworksModelSlug,
} from "./model-id.mjs";
import { loadServerlessCatalog } from "./models.mjs";

// Custom (user-deployed) Fireworks models are served on the gateway but aren't
// listed in the public serverless catalog, so the servability check must allow
// them through.
const CUSTOM_DEPLOYMENT_REF_RE = /^accounts\/[^/]+\/deployments\/[^/]+/i;

/**
 * Whether a `--model` id is one we validate against the serverless catalog.
 * Firerouter gateway ids, the `auto` / `auto-*` open-mix routers, custom
 * deployment ids, and real Anthropic model ids are served on the gateway but
 * aren't (or aren't always) listed in the public catalog, so they're allowed
 * unconditionally; an empty model means the harness default is used.
 * @param {string} modelId
 * @returns {boolean}
 */
export function isModelIdValidationApplicable(modelId) {
  if (!modelId) return false;
  const ref = shortFireworksModelRef(modelId);
  if (isFirerouterModelPattern(ref)) return false;
  if (isAutoModelId(ref)) return false;
  if (isGatewayAnthropicSlot(ref)) return false;
  return !CUSTOM_DEPLOYMENT_REF_RE.test(ref);
}

/**
 * Throw if any provided model id isn't a real Fireworks serverless model.
 *
 * Fetches the live serverless catalog once and checks every applicable id
 * against it. Validation is skipped (no throw) when:
 *   - no id needs validating (all empty / firerouter / custom deployment),
 *   - the key is a Fire Pass key (the account catalog can't be enumerated), or
 *   - the catalog fetch fails (offline) — we can't verify, so we don't block.
 *
 * @param {string[]} modelIds
 * @param {{ apiKey: string, keyType?: string }} opts
 * @returns {Promise<void>}
 */
export async function assertRequestedModelsServable(modelIds, { apiKey, keyType = "" } = {}) {
  const applicable = modelIds.filter(Boolean).filter(isModelIdValidationApplicable);
  if (applicable.length === 0) return;
  if (keyType === "firepass") return;
  let catalog;
  try {
    ({ catalog } = await loadServerlessCatalog({ apiKey, keyType }));
  } catch {
    return; // offline / fetch failed — can't verify, don't block
  }
  if (!Array.isArray(catalog) || catalog.length === 0) return;
  const known = new Set();
  for (const entry of catalog) {
    if (entry?.shortId) known.add(entry.shortId);
    if (entry?.id) known.add(entry.id);
  }
  for (const id of applicable) {
    const slug = fireworksModelSlug(id);
    const normalized = String(shortFireworksModelRef(id)).replace(/\[1m\]$/i, "");
    if (!known.has(slug) && !known.has(normalized)) {
      throw new Error(
        `Model "${shortFireworksModelRef(id)}" is not available on Fireworks. `
        + `Run \`fireconnect model list\` to see serverless models.`,
      );
    }
  }
}

/** Single-id convenience wrapper around {@link assertRequestedModelsServable}. */
export function assertRequestedModelServable(modelId, opts) {
  return assertRequestedModelsServable([modelId], opts);
}
