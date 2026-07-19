import { readFile } from "node:fs/promises";
import { detectApiKeyType } from "./fireconnect-core.mjs";
import {
  FIREROUTER_FIREWORKS_HEADER,
  isFirerouterBaseUrl,
  resolveFirerouterBaseUrl,
} from "./firerouter-core.mjs";
import { resolveFirerouterClaudeModels } from "./firerouter-catalog.mjs";
import {
  buildModelEntry,
  currentVariant,
  disableVscodeFireworks,
  fireconnectSecretId,
  fireconnectSecretIds,
  findFireconnectProvider,
  fireworksProviderStatus,
  isFireconnectProvider,
  makeFireconnectSecretId,
  readChatLanguageModels,
  readVscodeBackup,
  readVscodeSecret,
  vscodeLocalStatePath,
  vscodeStateDbPath,
  writeChatLanguageModels,
  writeVscodeBackup,
  writeVscodeSecret,
} from "./vscode-core.mjs";
import {
  isSecretEncryptionAvailable,
  secretEncryptionUnavailableMessage,
} from "./vscode-safestorage.mjs";

/**
 * FireRouter mode for the VS Code Chat harness.
 *
 * VS Code's custom-endpoint provider supports `apiType: "messages"` (the Anthropic
 * Messages API) and per-model `requestHeaders`, so we can retarget it at FireRouter
 * (`https://router.fireworks.ai/v1/messages`). FireRouter authenticates with two
 * credentials — `X-FireRouter-Fireworks-Key` (Fireworks key) and `x-api-key`
 * (Anthropic key). VS Code resolves exactly ONE secret-backed value (the provider
 * `apiKey`, the only `"secret": true` property) and header interpolation only
 * recognizes the `${apiKey}` token, so a second credential cannot be pulled from
 * secret storage. In `messages` mode VS Code auto-sends `x-api-key: <apiKey>`, so
 * (Layout A):
 *
 *   - the provider `apiKey` holds the ANTHROPIC key (encrypted in `state.vscdb`
 *     under the same `chat.lm.secret.fw-*` row fireconnect owns);
 *   - the Fireworks key is written as a PLAINTEXT literal in each model's
 *     `requestHeaders["X-FireRouter-Fireworks-Key"]`.
 *
 * This trades the direct-mode "key never touches disk in plaintext" guarantee for
 * router mode's Anthropic-format routing — the same trade-off Claude Code router
 * mode makes (it writes the Fireworks key in plaintext to settings.json). The
 * Anthropic key — the more expensive/sensitive credential — stays encrypted.
 *
 * Ownership remains keyed on the `fw-` secret-id prefix (a fireconnect-ownership
 * marker, NOT a key-type marker): in router mode that row holds an Anthropic key,
 * in direct mode a Fireworks key. `off` and the no-backup strip path are therefore
 * mode-agnostic and reuse `disableVscodeFireworks`.
 */

/** Provider display name fireconnect writes in router mode. */
export const FIRECONNECT_FIREROUTER_PROVIDER_NAME = "Fireworks";

/** VS Code uses a url containing `/messages` as-is; pin the full Messages path. */
const MESSAGES_API_PATH = "/v1/messages";

/**
 * The FireRouter Messages-API URL VS Code's custom endpoint should target.
 * @param {string} baseUrl FireRouter root (no /v1 suffix)
 * @returns {string}
 */
export function firerouterVscodeMessagesUrl(baseUrl) {
  return `${resolveFirerouterBaseUrl(baseUrl)}${MESSAGES_API_PATH}`;
}

/**
 * Whether the fireconnect-owned provider in `arr` is wired for FireRouter mode.
 * Router iff the provider is fireconnect-owned AND its `apiType` is `messages`,
 * or one of its models targets the FireRouter host / carries the FireRouter
 * fireworks header. Direct-mode providers (apiType chat-completions, Fireworks
 * inference url) read as "none" here.
 * @param {object[]} arr chatLanguageModels.json array
 * @returns {"firerouter" | "none"}
 */
export function vscodeFirerouterProviderStatus(arr) {
  const provider = findFireconnectProvider(arr);
  if (!provider) return "none";
  if (provider.apiType === "messages") return "firerouter";
  const models = provider.models ?? [];
  if (models.some((m) => m?.requestHeaders?.[FIREROUTER_FIREWORKS_HEADER])) {
    return "firerouter";
  }
  if (models.some((m) => typeof m?.url === "string" && isFirerouterBaseUrl(m.url))) {
    return "firerouter";
  }
  return "none";
}

/**
 * Read the Anthropic key stored (encrypted) in `state.vscdb` for router mode.
 * In router mode the `fw-` secret row holds the Anthropic key. Returns "" when
 * not in router mode or no secret present.
 * @param {string} vscodePath
 * @param {string} [stateDbPath]
 * @param {object[]} [arr] pre-parsed chatLanguageModels.json array
 * @returns {Promise<string>}
 */
export async function readVscodeStoredAnthropicKey(vscodePath, stateDbPath, arr) {
  const providerArr = arr ?? await readChatLanguageModels(vscodePath);
  if (vscodeFirerouterProviderStatus(providerArr) === "none") {
    return "";
  }
  const secretId = fireconnectSecretIds(providerArr)[0];
  return readVscodeSecret({ vscodePath, stateDbPath, secretId });
}

/**
 * Read the plaintext Fireworks key from an existing router provider's model
 * `requestHeaders` (Layout A stores it there, not in `state.vscdb`). Lets a
 * re-run of `on --router` reuse the key the prior enable already wrote, without
 * re-supplying `--api-key`/env/global/keychain. Returns "" when there's no
 * router provider or no header. Direct-mode models carry no such header, so this
 * naturally returns "" outside router mode.
 * @param {string} vscodePath
 * @param {object[]} [arr] pre-parsed chatLanguageModels.json array
 * @returns {Promise<string>}
 */
export async function readVscodeRouterFireworksKey(vscodePath, arr) {
  const providerArr = arr ?? await readChatLanguageModels(vscodePath);
  const provider = findFireconnectProvider(providerArr);
  for (const model of provider?.models ?? []) {
    const key = model?.requestHeaders?.[FIREROUTER_FIREWORKS_HEADER];
    if (typeof key === "string" && key.trim()) {
      return key.trim();
    }
  }
  return "";
}

/**
 * FireRouter-mode display name for a Claude model id, e.g.
 * `claude-haiku-4-5` -> "Claude Haiku 4.5 (FireRouter)". The catalog advertises
 * only the raw id (suffixed "(FireRouter)"), so we prettify the id ourselves:
 * title-case the family words and join the trailing version numbers with dots —
 * something `prettyModelName` can't do, since it splits `-4-5` into "4 5". A
 * `[1m]` context marker is preserved; a dated snapshot suffix is dropped.
 * @param {string} id bare Claude model id
 * @returns {string}
 */
export function firerouterDisplayName(id) {
  let base = String(id ?? "").trim();
  let oneM = "";
  const marker = base.match(/\[1m\]$/i);
  if (marker) {
    oneM = " [1m]";
    base = base.slice(0, marker.index);
  }
  base = base.replace(/-\d{8}$/, ""); // drop dated snapshot suffix (e.g. -20251001)
  const words = [];
  const version = [];
  for (const tok of base.split(/[-_]/).filter(Boolean)) {
    if (/^\d+$/.test(tok)) {
      version.push(tok);
    } else {
      words.push(tok.charAt(0).toUpperCase() + tok.slice(1));
    }
  }
  const pretty = [words.join(" "), version.join(".")].filter(Boolean).join(" ");
  return `${pretty}${oneM} (FireRouter)`;
}

/**
 * Build a router-mode model entry from a FireRouter catalog descriptor. Starts
 * from `buildModelEntry` (default metadata), sets a prettified "(FireRouter)"
 * display name (the catalog's advertised `name` is just the raw id), prefers the
 * catalog's token limits when present, and overrides url/apiType + attaches the
 * FireRouter fireworks-key header. Claude models are multimodal, so enable vision.
 * @param {{id: string, name?: string, contextLimit?: number, outputLimit?: number}} model
 * @param {string} messagesUrl full FireRouter /v1/messages url
 * @param {string} fireworksKey plaintext Fireworks key (router header)
 * @returns {object}
 */
function buildRouterModelEntry(model, messagesUrl, fireworksKey) {
  const base = buildModelEntry(model.id);
  const entry = {
    ...base,
    name: firerouterDisplayName(model.id),
    vision: true,
    url: messagesUrl,
    apiType: "messages",
    requestHeaders: {
      [FIREROUTER_FIREWORKS_HEADER]: fireworksKey,
    },
  };
  if (Number.isInteger(model.contextLimit)) entry.maxInputTokens = model.contextLimit;
  if (Number.isInteger(model.outputLimit)) entry.maxOutputTokens = model.outputLimit;
  return entry;
}

/**
 * Enable FireRouter routing for VS Code Chat (Layout A): store the Anthropic key
 * encrypted in `state.vscdb` under a `fw-` secret, and register a `messages`
 * provider whose models target `…/v1/messages` and carry the Fireworks key as a
 * plaintext `X-FireRouter-Fireworks-Key` header.
 *
 * Router mode seeds the Claude set FireRouter advertises (via
 * `resolveFirerouterClaudeModels`); there is no `--main` (model choice happens in
 * the VS Code Chat picker, and fireconnect's model commands are disabled here).
 *
 * @param {{
 *   vscodePath: string,
 *   dataDir: string,
 *   stateDbPath?: string,
 *   baseUrl?: string,
 *   fireworksKey: string,
 *   anthropicKey: string,
 * }} opts
 * @returns {Promise<{ baseUrl: string, models: string[], secretId: string, stateDbPath: string }>}
 */
export async function enableFirerouterVscode({
  vscodePath,
  dataDir,
  stateDbPath,
  baseUrl = "",
  fireworksKey,
  anthropicKey,
}) {
  if (!fireworksKey?.trim()) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }
  if (!anthropicKey?.trim()) {
    throw new Error("No Anthropic API key found. Pass --anthropic-api-key or set ANTHROPIC_API_KEY.");
  }
  if (detectApiKeyType(fireworksKey) === "firepass") {
    throw new Error(
      "FireRouter mode routes Anthropic models and is not compatible with Fire Pass keys. "
        + "Use direct mode (fireconnect vscode on) for Fire Pass / glm routing.",
    );
  }

  const variant = currentVariant(vscodePath);
  const localStatePath = vscodeLocalStatePath({ vscodePath });
  if (!isSecretEncryptionAvailable({ variant, localStatePath })) {
    throw new Error(secretEncryptionUnavailableMessage(variant));
  }

  const resolvedBaseUrl = resolveFirerouterBaseUrl(baseUrl);
  const messagesUrl = firerouterVscodeMessagesUrl(resolvedBaseUrl);
  const claudeModels = await resolveFirerouterClaudeModels(resolvedBaseUrl);

  const arr = await readChatLanguageModels(vscodePath);

  // Snapshot pre-fireconnect state exactly once (mirror enableVscodeFireworks).
  const backup = await readVscodeBackup(dataDir, vscodePath);
  const hasBackup = backup.snapshot !== undefined;
  const alreadyManaged = fireworksProviderStatus(arr) !== "none";
  if (!hasBackup && !alreadyManaged) {
    const { existed: fileExisted, raw: fileRaw } = await readRawIfExists(vscodePath);
    await writeVscodeBackup(dataDir, vscodePath, { fileExisted, fileRaw, secretIds: [] });
  }

  // Reuse an existing fireconnect secret id, or mint one. In router mode the row
  // holds the Anthropic key (see module doc); switching from direct mode
  // overwrites the Fireworks key in that row with the Anthropic key, as intended.
  const existing = findFireconnectProvider(arr);
  const secretId = existing ? fireconnectSecretId(existing.apiKey) : makeFireconnectSecretId();
  const { stateDbPath: dbPath } = await writeVscodeSecret({
    vscodePath,
    stateDbPath,
    secretId,
    secret: anthropicKey.trim(),
  });

  // Preserve router-shaped models from a prior router `on` (refreshing their url
  // + key in case either changed), then ensure the FireRouter-advertised Claude
  // set is present. A direct-mode provider's models target the Fireworks inference
  // url and are dropped by this filter, so a direct→router switch starts from the
  // advertised set.
  const existingRouterModels = (existing?.models ?? []).filter(
    (m) => m?.apiType === "messages" || (typeof m?.url === "string" && isFirerouterBaseUrl(m.url)),
  );
  const models = computeRouterModels(existingRouterModels, claudeModels, messagesUrl, fireworksKey.trim());

  const next = addFirerouterProvider(arr, { secretId, models });
  await writeChatLanguageModels(vscodePath, next);

  return { baseUrl: resolvedBaseUrl, models: models.map((m) => m.id), secretId, stateDbPath: dbPath };
}

/**
 * Refresh router-specific fields on an existing model entry. Preserves id, name,
 * and other display metadata while applying the current messages url and
 * Fireworks key (both can change when re-running `on --router`).
 * @param {object} model
 * @param {string} messagesUrl
 * @param {string} fireworksKey
 * @returns {object}
 */
function refreshRouterModelEntry(model, messagesUrl, fireworksKey) {
  return {
    ...model,
    // Re-derive the display name so entries written before the pretty-name
    // convention (raw "<id> (FireRouter)") migrate on the next `on --router`.
    name: firerouterDisplayName(model.id),
    url: messagesUrl,
    apiType: "messages",
    vision: true,
    requestHeaders: {
      [FIREROUTER_FIREWORKS_HEADER]: fireworksKey,
    },
  };
}

/**
 * Compute the models list for the fireconnect router provider on `on`. The
 * FireRouter-advertised `claudeModels` set is the source of truth: stale ids
 * from a prior run are dropped when the catalog shrinks. Pre-existing entries
 * are refreshed (url + key can change on re-run); new catalog ids are built.
 * There is no `--main`: router-mode model choice happens in the VS Code Chat picker.
 * @param {object[]} existingRouterModels prior router-mode models, if any
 * @param {Array<{id: string, name?: string, contextLimit?: number, outputLimit?: number}>} claudeModels
 * @param {string} messagesUrl
 * @param {string} fireworksKey
 * @returns {object[]}
 */
function computeRouterModels(existingRouterModels, claudeModels, messagesUrl, fireworksKey) {
  const existingById = new Map();
  for (const m of existingRouterModels) {
    if (m?.id) {
      existingById.set(m.id, m);
    }
  }
  const models = [];
  for (const model of claudeModels) {
    if (!model?.id) continue;
    const existing = existingById.get(model.id);
    models.push(
      existing
        ? refreshRouterModelEntry(existing, messagesUrl, fireworksKey)
        : buildRouterModelEntry(model, messagesUrl, fireworksKey),
    );
  }
  return models;
}

/**
 * Add (or replace) the fireconnect-owned router provider. Other providers are
 * left alone. Mirrors `addFireworksProvider` but with the router shape.
 * @param {object[]} arr
 * @param {{ secretId: string, models: object[] }} opts
 * @returns {object[]}
 */
function addFirerouterProvider(arr, { secretId, models }) {
  const next = [...(arr ?? [])];
  const idx = next.findIndex(isFireconnectProvider);
  const provider = {
    name: FIRECONNECT_FIREROUTER_PROVIDER_NAME,
    vendor: "customendpoint",
    apiType: "messages",
    apiKey: `\${input:${secretId}}`,
    models,
  };
  if (idx >= 0) {
    next[idx] = provider;
  } else {
    next.push(provider);
  }
  return next;
}

/**
 * Disable FireRouter routing for VS Code Chat. Reuses `disableVscodeFireworks`:
 * ownership is keyed on the `fw-` secret id (mode-agnostic), so the backup
 * restore + secret deletion + no-backup strip logic is identical for router and
 * direct modes.
 * @param {{ vscodePath: string, dataDir: string, wasEnabled?: boolean, stateDbPath?: string }} opts
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function disableFirerouterVscode(opts) {
  return disableVscodeFireworks(opts);
}

/** Raw-text snapshot helper (mirror vscode-core's private readRawIfExists). */
async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { existed: false, raw: "" };
    throw error;
  }
}

export { vscodeStateDbPath };
