import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  isEnabledFireworksHarness,
  readGlobalConfig,
  setHarnessState,
} from "../config/global-config.mjs";
import {
  copilotAppPathsFor,
  copilotCliPathsFor,
  cursorPathsFor,
  piPathsFor,
} from "./context.mjs";
import { HARNESS, HARNESSES } from "./id.mjs";
import { readJsonIfExists, writeJson } from "../io/json.mjs";
import { writeFileAtomic } from "../io/atomic-write.mjs";
import { fullFireworksResourceId, shortFireworksModelRef } from "../fireworks/model-id.mjs";
import { resolveManagedDisplayName } from "../fireworks/model-display.mjs";
import { isFirepassKey } from "../keys/key-type.mjs";
import { byokEnvFromHeaders } from "../firerouter/core.mjs";
import { buildFireconnectTelemetryHeaders } from "../telemetry/request-headers.mjs";
import {
  copilotModelIds,
  describeCopilotAppModels,
  describeCopilotModels,
} from "../harnesses/copilot-shared.mjs";
import {
  findFireconnectProvider as findCopilotProvider,
  insertCopilotProviderModel,
  isCopilotRunning,
  listCopilotProviderModels,
} from "../harnesses/copilot-app/sqlite.mjs";
import { providerApiKey } from "../harnesses/copilot-app/core.mjs";
import { buildCliModels, readCopilotCliState } from "../harnesses/copilot-cli/config.mjs";
import {
  APPLICATION_USER_KEY,
  addUserModel,
  cursorProviderStatus,
  fireconnectRegisteredModels,
  readCursorState,
} from "../harnesses/cursor/core.mjs";
import { applyCursorWrites, isCursorRunning } from "../harnesses/cursor/sqlite.mjs";
import {
  codexCatalogPath,
  codexConfigPath,
  codexStoredAuthRef,
  effectiveCodexApiKey,
  fireconnectManagedVariant,
} from "../harnesses/codex/core.mjs";
import { parseToml } from "../harnesses/codex/toml.mjs";
import {
  buildCodexAutoCatalogEntry,
  codexCatalogContainsModel,
} from "../harnesses/codex/catalog.mjs";
import { isChatGptRunning } from "../harnesses/codex/ide-running.mjs";
import {
  OPENCODE_FIREWORKS_PROVIDER_ID,
  buildOpencodeModelEntry,
  effectiveOpencodeApiKey,
  opencodeConfigPath,
  opencodeProviderModelKey,
  opencodeProviderStatus,
  readRawIfExists,
} from "../harnesses/opencode/core.mjs";
import {
  piProviderStatus,
  resolvePiApiKeyValue,
} from "../harnesses/pi/core.mjs";
import {
  PI_AUTO_ENABLED_MODEL,
  buildPiCustomFireworksModelEntry,
  piEnabledModels,
} from "../harnesses/pi/fireworks-models.mjs";
import {
  buildModelEntry,
  chatLanguageModelsPath,
  findFireconnectProvider as findVscodeProvider,
  isVscodeRunning,
  readChatLanguageModels,
  readVscodeStoredKey,
  vscodeStoredByokHeaders,
  writeChatLanguageModels,
} from "../harnesses/vscode/core.mjs";
import { withFireconnectRequestHeadersForModels } from "../harnesses/vscode/request-headers.mjs";

/**
 * Ensure the `auto` mix is registered in one harness's picker catalog.
 *
 * Single entry point for the auto backfill: `fireconnect upgrade` (via the
 * forward migrations) and any other caller switch on the harness id here.
 * Every branch is key-independent (static spec, no network), skips Fire Pass
 * installs and running IDEs, and never touches the active model selection.
 * Claude is separately handled and DeepSeek has no catalog, so both no-op.
 * Unknown ids throw, like the harness registry.
 *
 * @param {string} harnessId one of {@link HARNESSES}
 * @param {string} home
 * @param {object} [opts] `{ isRunning }` override for the running-IDE guard;
 *   primarily a test seam — production callers pass nothing.
 * @returns {Promise<boolean>} true when that harness's catalog was updated
 */
export async function ensureAutoCatalogEntry(harnessId, home, opts = {}) {
  switch (harnessId) {
    case HARNESS.CLAUDE:
    case HARNESS.DEEPSEEK:
      // Claude is separately handled; DeepSeek has no catalog.
      return false;
    case HARNESS.OPENCODE:
    case HARNESS.CODEX:
    case HARNESS.PI:
    case HARNESS.CURSOR:
    case HARNESS.VSCODE:
    case HARNESS.COPILOT_APP:
    case HARNESS.COPILOT_CLI:
      break;
    default:
      throw new Error(`Unknown harness: ${harnessId}. Choose one of: ${HARNESSES.join(", ")}`);
  }
  // Upgrade only touches harnesses that are actually on. Each branch below
  // additionally verifies its own managed config before writing anything.
  if (!(await enabledFireworksHarness(home, harnessId))) {
    return false;
  }
  switch (harnessId) {
    case HARNESS.OPENCODE:
      return ensureOpencodeAuto(home);
    case HARNESS.CODEX:
      return ensureCodexAuto(home, opts);
    case HARNESS.PI:
      return ensurePiAuto(home);
    case HARNESS.CURSOR:
      return ensureCursorAuto(home, opts);
    case HARNESS.VSCODE:
      return ensureVscodeAuto(home, opts);
    case HARNESS.COPILOT_APP:
      return ensureCopilotAppAuto(home, opts);
    default:
      return ensureCopilotCliAuto(home);
  }
}

/**
 * Single gate for the upgrade backfill: the harness must be flagged on
 * (and not on Azure). Returns the harness map for branches that need more
 * than the flag (Pi's managed-id record), null otherwise.
 */
async function enabledFireworksHarness(home, harnessId) {
  if (!home) {
    return null;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, harnessId)) {
    return null;
  }
  return harnesses;
}

async function ensureOpencodeAuto(home) {
  const resolvedPath = opencodeConfigPath(home);
  const snapshot = await readRawIfExists(resolvedPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  const config = JSON.parse(snapshot.raw);
  if (opencodeProviderStatus(config) !== "fireworks") {
    return false;
  }
  const provider = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] ?? {};
  const models = { ...(provider.models ?? {}) };
  if (Object.keys(models).some((id) => opencodeProviderModelKey(id) === "auto")) {
    return false;
  }
  if (isFirepassKey(effectiveOpencodeApiKey(provider.options?.apiKey))) {
    return false;
  }
  const next = {
    ...config,
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...provider,
        models: { auto: buildOpencodeModelEntry("auto"), ...models },
      },
    },
  };
  const storedApiKey = provider.options?.apiKey;
  await writeJson(resolvedPath, next, {
    mode: typeof storedApiKey === "string" && storedApiKey ? 0o600 : undefined,
  });
  return true;
}

async function ensureCodexAuto(home, { isRunning = isChatGptRunning } = {}) {
  if (isRunning()) {
    return false;
  }
  const resolvedConfigPath = codexConfigPath(home);
  const snapshot = await readRawIfExists(resolvedConfigPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  const doc = parseToml(snapshot.raw);
  if (fireconnectManagedVariant(doc) !== "fireworks") {
    return false;
  }
  if (isFirepassKey(effectiveCodexApiKey(codexStoredAuthRef(doc)))) {
    return false;
  }
  const ref = typeof doc.root.model_catalog_json === "string" ? doc.root.model_catalog_json.trim() : "";
  if (!ref) {
    // No catalog reference: leave the install alone. A fresh offline `on`
    // writes no catalog either, so inventing an auto-only file here would
    // swap Codex's default metadata for a one-model picker until the next
    // networked `on` rebuilds the full catalog.
    return false;
  }
  const resolvedCatalogPath = resolveCodexCatalogPath(home, ref);
  const catalog = await readJsonIfExists(resolvedCatalogPath);
  if (!Array.isArray(catalog.models)) {
    return false;
  }
  if (codexCatalogContainsModel(catalog, "auto")) {
    return false;
  }
  const nextRows = [buildCodexAutoCatalogEntry("auto"), ...catalog.models];
  await mkdir(path.dirname(resolvedCatalogPath), { recursive: true, mode: 0o700 });
  await writeJson(resolvedCatalogPath, { ...catalog, models: nextRows }, { mode: 0o600 });
  return true;
}

/** Catalog file for a managed Codex config: its `model_catalog_json` ref, else the default path. */
function resolveCodexCatalogPath(home, ref) {
  if (ref.startsWith("~/")) {
    return path.join(home, ref.slice("~/".length));
  }
  if (path.isAbsolute(ref)) {
    return ref;
  }
  return codexCatalogPath(home);
}

async function ensurePiAuto(home) {
  const { settingsPath, authPath, modelsPath } = piPathsFor({ home });
  const [settingsSnap, authSnap, modelsSnap] = await Promise.all([
    readRawIfExists(settingsPath),
    readRawIfExists(authPath),
    readRawIfExists(modelsPath),
  ]);
  if (!settingsSnap.existed || !settingsSnap.raw.trim()) {
    return false;
  }
  let settings = JSON.parse(settingsSnap.raw);
  if (piProviderStatus(settings) !== "fireworks") {
    return false;
  }
  const auth = authSnap.existed && authSnap.raw.trim() ? JSON.parse(authSnap.raw) : {};
  if (isFirepassKey(resolvePiApiKeyValue(auth?.fireworks?.key ?? ""))) {
    return false;
  }
  const modelsConfig = modelsSnap.existed && modelsSnap.raw.trim() ? JSON.parse(modelsSnap.raw) : {};

  let changed = false;
  const providers = { ...(modelsConfig.providers ?? {}) };
  const fireworks = { ...(providers.fireworks ?? {}) };
  const rows = [...(fireworks.models ?? [])];
  if (!rows.some((model) => fullFireworksResourceId(model?.id) === "auto")) {
    rows.unshift(buildPiCustomFireworksModelEntry("auto", resolveManagedDisplayName("auto")));
    fireworks.models = rows;
    providers.fireworks = fireworks;
    changed = true;
  }

  const { harnesses } = await readGlobalConfig(home);
  const profiles = { ...(harnesses[HARNESS.PI]?.profiles ?? {}) };
  const managed = Array.isArray(profiles.managedModelIds) ? [...profiles.managedModelIds] : [];
  if (!managed.some((id) => fullFireworksResourceId(id) === "auto")) {
    managed.unshift("auto");
    profiles.managedModelIds = managed;
    changed = true;
  }

  const scope = Array.isArray(settings.enabledModels)
    ? [...settings.enabledModels]
    : piEnabledModels(settings.defaultModel);
  if (!scope.includes(PI_AUTO_ENABLED_MODEL)) {
    scope.push(PI_AUTO_ENABLED_MODEL);
  }
  if (JSON.stringify(scope) !== JSON.stringify(settings.enabledModels)) {
    settings = { ...settings, enabledModels: scope };
    await writeJson(settingsPath, settings);
    changed = true;
  }

  if (changed) {
    await writeJson(modelsPath, { ...modelsConfig, providers });
    await setHarnessState(home, HARNESS.PI, { profiles });
  }
  return changed;
}

async function ensureCursorAuto(home, { isRunning = isCursorRunning } = {}) {
  const resolvedDbPath = cursorPathsFor({ home }).dbPath;
  if (!existsSync(resolvedDbPath)) {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  const { blob, openAIKey } = await readCursorState(resolvedDbPath);
  if (cursorProviderStatus(blob, openAIKey) !== "fireworks") {
    return false;
  }
  if (isFirepassKey(openAIKey)) {
    return false;
  }
  const toShortRef = (id) => shortFireworksModelRef(String(id ?? ""));
  if (fireconnectRegisteredModels(blob).map(toShortRef).includes("auto")
    || (blob?.aiSettings?.userAddedModels ?? []).map(toShortRef).includes("auto")) {
    return false;
  }
  const next = addUserModel(blob, "auto");
  await applyCursorWrites(resolvedDbPath, [
    { op: "set", key: APPLICATION_USER_KEY, value: JSON.stringify(next) },
  ]);
  return true;
}

async function ensureVscodeAuto(home, { isRunning = isVscodeRunning } = {}) {
  const jsonPath = chatLanguageModelsPath({ home });
  const arr = await readChatLanguageModels(jsonPath);
  const provider = findVscodeProvider(arr);
  if (!provider) {
    return false;
  }
  const ids = (provider.models ?? []).map((model) => shortFireworksModelRef(model?.id));
  if (ids.includes("auto")) {
    return false;
  }
  const storedKey = await readVscodeStoredKey(jsonPath, undefined, arr);
  if (isFirepassKey(storedKey)) {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  const models = withFireconnectRequestHeadersForModels(
    [buildModelEntry("auto"), ...(provider.models ?? [])],
    {
      telemetryHeaders: buildFireconnectTelemetryHeaders(HARNESS.VSCODE),
      byokHeaders: byokEnvFromHeaders(vscodeStoredByokHeaders(arr)),
    },
  );
  await writeChatLanguageModels(
    jsonPath,
    arr.map((p) => (p === provider ? { ...p, models } : p)),
  );
  return true;
}

async function ensureCopilotAppAuto(home, { isRunning = isCopilotRunning } = {}) {
  const resolvedDbPath = copilotAppPathsFor({ home }).dbPath;
  if (!existsSync(resolvedDbPath)) {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  const provider = await findCopilotProvider(resolvedDbPath);
  if (!provider) {
    return false;
  }
  if (isFirepassKey(providerApiKey(provider))) {
    return false;
  }
  const ids = copilotModelIds(
    (await listCopilotProviderModels(resolvedDbPath, provider.id)).map((model) => model.model_id),
  );
  if (ids.includes("auto")) {
    return false;
  }
  const [auto] = describeCopilotAppModels(["auto"]);
  await insertCopilotProviderModel(resolvedDbPath, { providerId: provider.id, model: auto });
  return true;
}

async function ensureCopilotCliAuto(home) {
  const resolvedPath = copilotCliPathsFor({ home }).providersPath;
  const config = await readJsonIfExists(resolvedPath);
  const state = await readCopilotCliState(resolvedPath);
  if (!state.configured) {
    return false;
  }
  if (copilotModelIds(state.models).includes("auto")) {
    return false;
  }
  if (isFirepassKey(state.apiKey)) {
    return false;
  }
  if (!Array.isArray(config.models)) {
    return false;
  }
  const [auto] = buildCliModels(describeCopilotModels(["auto"]));
  await writeFileAtomic(resolvedPath, `${JSON.stringify({ ...config, models: [...config.models, auto] }, null, 2)}\n`);
  await chmod(resolvedPath, 0o600).catch(() => {});
  return true;
}
