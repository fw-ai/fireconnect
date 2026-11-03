import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import path from "node:path";
import process from "node:process";
import {
  AZURE_API_KEY_ENV_REF,
  AZURE_OPENAI_COMPATIBLE_NPM,
  AZURE_PROVIDER_LABEL,
  DEFAULT_AZURE_MODEL,
  effectiveAzureApiKey,
  lookupAzureFoundryModelLimits,
  normalizeAzureBaseUrl,
} from "../../fireworks/azure-core.mjs";
import {
  AUTO_MODEL_ID,
  defaultMainModel,
  canonicalAutoModelId,
  dropRetiredModelId,
  fireworksModelSlug,
  fullFireworksResourceId,
  isAutoModelId,
  isAutoInstantModelId,
  isFirerouterModelPattern,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { hasModelReasoningLevels } from "../../fireworks/reasoning.mjs";
import { resolveManagedDisplayName } from "../../fireworks/model-display.mjs";
import { planModelList } from "../../harness/catalog-refresh.mjs";
import { resolveFireworksCatalog } from "../../fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../fireworks/pricing.mjs";
import {
  assumedModelsDevListed,
  hasRichFireworksLimits,
  opencodeModalitiesField,
} from "./catalog-policy.mjs";
import {
  modelsDevRegistryStatus,
  refreshModelsDevFireworksRegistry,
} from "../../fireworks/models-dev-registry.mjs";
import { lookupCachedContextLength } from "../../fireworks/serverless-catalog-cache.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { NEXUS_PROVIDERS_HEADER, RETIRED_ROUTING_PREFERENCE_HEADER, omitHeaders } from "../../firerouter/core.mjs";
import {
  isFireworksShapedKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { isHarnessEnabled } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";
import { dropOpencodeProvider, mirrorOpencodeV2Providers } from "./providers-v2.mjs";
import { DATA_DIRNAME, LEGACY_DATA_DIRNAME } from "../../system/data-dir.mjs";

/**
 * Restore a raw config snapshot from a backup (or delete the config when the
 * snapshot recorded that it didn't exist), then remove the backup. Returns true
 * when it restored, false when the backup carried no snapshot.
 * @param {{ configPath: string, backupPath: string, backup: { snapshot?: { existed: boolean, raw: string }, configPath?: string } }} args
 */
export async function restoreOpencodeSnapshot({ configPath, backupPath, backup }) {
  if (!backup || backup.snapshot === undefined) {
    return false;
  }
  // Refuse to restore a snapshot taken for a different config file.
  if (backup.configPath !== undefined && backup.configPath !== path.resolve(configPath)) {
    throw new Error(
      `Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`,
    );
  }
  if (backup.snapshot.existed) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, backup.snapshot.raw);
  } else {
    try {
      await unlink(configPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await unlink(backupPath);
  return true;
}

export const OPENCODE_CONFIG_RELATIVE_PATH = ".config/opencode/opencode.json";
export const OPENCODE_DATA_RELATIVE_DIR = ".nexus/opencode";
export const OPENCODE_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const OPENCODE_FIREWORKS_PROVIDER_ID = "fireworks-ai";
export const OPENCODE_AZURE_PROVIDER_ID = "fireworks-azure";
export const OPENCODE_MANAGED_PROVIDER_IDS = [OPENCODE_FIREWORKS_PROVIDER_ID, OPENCODE_AZURE_PROVIDER_ID];

/**
 * Every opencode.json write goes through here so a v2 `providers` map can
 * never drift from the managed `provider` entries.
 * @param {string} configPath
 * @param {Record<string, any>} config
 * @param {{ mode?: number }} [opts]
 */
export async function writeOpencodeConfig(configPath, config, { mode } = {}) {
  const next = mirrorOpencodeV2Providers(config, OPENCODE_MANAGED_PROVIDER_IDS);
  await writeJson(configPath, next, { mode });
  return next;
}

function isEmptyObject(value) {
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

/** Drop the provider id Nexus used before `fireworks-ai`; it never had a v2 mirror. */
function withoutRetiredFireworksProvider(config) {
  if (!config.provider?.fireworks) {
    return config;
  }
  const { fireworks: _retired, ...provider } = config.provider;
  return { ...config, provider };
}

/**
 * Whether Nexus should write a provider.models entry for this model.
 * Anything models.dev already lists is in OpenCode's picker under its full id,
 * so an override would only add a duplicate row. Otherwise FireRouter,
 * `auto` / `auto-*`, `-latest` router aliases, and catalog models need
 * overrides (display name, modalities, limits).
 * @param {string} modelId
 */
export function opencodeNeedsProviderModelOverride(modelId) {
  if (!modelId || typeof modelId !== "string") {
    return false;
  }
  const canonical = fullFireworksResourceId(modelId);
  const registryStatus = modelsDevRegistryStatus(canonical);
  if (registryStatus === "present") {
    return false;
  }
  if (isFirerouterModelPattern(modelId) || isAutoModelId(modelId)) {
    return true;
  }
  const slug = fireworksModelSlug(normalizeModelId(modelId));
  if (slug.endsWith("-latest") || slug.endsWith("-fast-latest")) {
    return true;
  }

  if (!canonical.startsWith("accounts/fireworks/")) {
    return false;
  }

  const limits = resolveFireworksCatalog(modelId).limits;
  if (!hasRichFireworksLimits(limits)) {
    return false;
  }

  if (registryStatus === "absent") {
    return true;
  }

  // Registry unavailable: override serverless-catalog models not assumed on models.dev.
  return Boolean(lookupCachedContextLength(canonical)) && !assumedModelsDevListed(modelId);
}

function isModelsDevDuplicate(id) {
  const canonical = fullFireworksResourceId(id);
  return canonical !== id && modelsDevRegistryStatus(canonical) === "present";
}

/**
 * Drop short-key rows (written by earlier releases) for models OpenCode now
 * lists from models.dev under their full id; they show up twice in `/models`.
 * @param {Record<string, unknown>} models
 */
export function withoutModelsDevDuplicates(models) {
  return Object.fromEntries(Object.entries(models).filter(([id]) => !isModelsDevDuplicate(id)));
}

/**
 * Model ref written to `config.model` for OpenCode. Router aliases and
 * FireRouter use short gateway slugs with provider overrides; catalog models
 * use full accounts/fireworks/... ids so models.dev can resolve them.
 * @param {string} modelId
 * @returns {string}
 */
export function opencodeConfigModelRef(modelId) {
  const stored = shortFireworksModelRef(normalizeModelId(modelId));
  if (opencodeNeedsProviderModelOverride(stored)) {
    return stored;
  }
  return fullFireworksResourceId(modelId);
}

export function effectiveOpencodeApiKey(storedKey) {
  if (!storedKey) {
    return "";
  }
  return storedKey === OPENCODE_API_KEY_ENV_REF
    ? "" // env is not a credential source
    : storedKey;
}

export function opencodeConfigPath(home, configPath) {
  if (configPath) {
    return configPath;
  }
  return path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
}

export function opencodeDataDir(home, dataDir) {
  if (dataDir) {
    return dataDir;
  }
  return path.join(home, OPENCODE_DATA_RELATIVE_DIR);
}

// Backups are keyed by the config file they snapshot, so enabling Fireworks on
// two different opencode.json paths (e.g. via --config-path) can never restore
// one file's content onto the other.
export function opencodeBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

// Raw-text snapshot (not parsed JSON) so `off` can restore the user's file
// byte-for-byte, preserving their formatting and key order.
export async function readRawIfExists(filePath) {
  try {
    return { existed: true, raw: await readFile(filePath, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existed: false, raw: "" };
    }
    throw error;
  }
}

export function opencodeCurrentModelId(config) {
  const modelRef = typeof config.model === "string" ? config.model : "";
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  if (modelRef.startsWith(azurePrefix)) {
    return modelRef.slice(azurePrefix.length);
  }
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  if (modelRef.startsWith(prefix)) {
    return shortFireworksModelRef(modelRef.slice(prefix.length));
  }
  if (modelRef.startsWith("fireworks/")) {
    return shortFireworksModelRef(modelRef.slice("fireworks/".length));
  }
  return null;
}

export function opencodeProviderStatus(config) {
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  const hasAzure = Boolean(config.provider?.[OPENCODE_AZURE_PROVIDER_ID]);
  const hasFireworksAi = Boolean(config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
  const hasLegacy = Boolean(config.provider?.fireworks);
  const model = typeof config.model === "string" ? config.model : "";
  const azureModel = model.startsWith(azurePrefix);
  if (hasAzure && azureModel) {
    return "azure";
  }
  const fireworksModel = model.startsWith(prefix) || model.startsWith("fireworks/");
  if ((hasFireworksAi || hasLegacy) && fireworksModel) {
    return "fireworks";
  }
  if (hasAzure || azureModel || hasFireworksAi || hasLegacy || fireworksModel) {
    return "custom";
  }
  return "default";
}

/**
 * @param {string} storedRef
 * @returns {"literal" | "env-reference" | "missing"}
 */
export function opencodeAuthKeyMode(storedRef) {
  if (!storedRef) {
    return "missing";
  }
  if (storedRef === OPENCODE_API_KEY_ENV_REF || storedRef === AZURE_API_KEY_ENV_REF) {
    return "env-reference";
  }
  return "literal";
}

/**
 * Build an OpenCode `provider.models` entry for a Fireworks model id.
 * Vision-capable models (including latest router aliases and FireRouter)
 * get image input modalities from the shared Fireworks model specs.
 * Latest router aliases are absent from models.dev, so limit.context/output
 * must be set explicitly or OpenCode falls back to ~128k.
 * @param {string} modelId
 * @returns {{ name: string, limit: { context: number, output: number }, modalities?: { input: string[] } }}
 */
export function buildOpencodeModelEntry(modelId) {
  const normalized = normalizeModelId(modelId);
  const { limits, input } = resolveFireworksCatalog(normalized);
  const pricing = lookupFireworksPricing(normalized);
  return {
    name: resolveManagedDisplayName(normalized),
    limit: {
      context: limits.contextWindow,
      output: limits.maxTokens,
    },
    ...(pricing
      ? {
          cost: {
            input: pricing.input,
            output: pricing.output,
            cache_read: pricing.cachedInput,
          },
        }
      : {}),
    ...(limits.vision ? { modalities: { input } } : {}),
  };
}

/** Auto picker key; resource paths are not gateway Auto model ids. */
export function opencodeAutoModelKey(modelId) {
  return typeof modelId === "string"
    ? canonicalAutoModelId(modelId.replace(/^(?:fireworks-ai|fireworks)\//, ""))
    : "";
}

function isModelObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A `variants` value OpenCode loads: object variants, `disabled` boolean when set. */
function isVariantMap(value) {
  return isModelObject(value) && Object.values(value).every((variant) => isModelObject(variant)
    && (variant.disabled === undefined || typeof variant.disabled === "boolean"));
}

/** A `reasoning_options` value OpenCode loads: effort, toggle and budget_tokens entries. */
function isReasoningOptions(value) {
  return Array.isArray(value) && value.every((option) => {
    if (!isModelObject(option)) return false;
    if (option.type === "effort") {
      return Array.isArray(option.values) && option.values.every((effort) => effort === null || typeof effort === "string");
    }
    if (option.type === "budget_tokens") {
      return ["min", "max"].every((key) => option[key] === undefined || Number.isFinite(option[key]));
    }
    return option.type === "toggle";
  });
}

/** Stricter than the shared helpers, which also accept other `auto-*` mixes. */
function isOpencodeAutoRow(modelId, entry) {
  return opencodeAutoModelKey(modelId) === AUTO_MODEL_ID
    && canonicalAutoModelId(entry?.id ?? AUTO_MODEL_ID) === AUTO_MODEL_ID;
}

/** A row-level `provider` OpenCode loads: an object whose `npm` and `api`, when set, are strings. */
function isRowProviderOverride(value) {
  return isModelObject(value) && ["npm", "api"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

/** Bare slug for a picker key or full resource ref, without a provider prefix. */
function opencodeRowSlug(modelId) {
  return typeof modelId === "string"
    ? fireworksModelSlug(modelId.replace(/^(?:fireworks-ai|fireworks)\//i, ""))
    : "";
}

/** Whether a picker key names canonical Auto or a reasoning-table model. */
function isReasoningRowKey(modelId) {
  if (opencodeAutoModelKey(modelId) === AUTO_MODEL_ID) return true;
  const slug = opencodeRowSlug(modelId);
  if (!slug || canonicalAutoModelId(slug) || isFirerouterModelPattern(modelId)) return false;
  const ref = typeof modelId === "string" ? modelId.replace(/^(?:fireworks-ai|fireworks)\//i, "") : "";
  // A table key can name a model even when the slug's suffix suggests a router.
  const modelRef = ref.includes("/") ? ref : `accounts/fireworks/models/${ref}`;
  return hasModelReasoningLevels(modelRef) || hasModelReasoningLevels(fullFireworksResourceId(ref));
}

/**
 * Whether an existing row is one the effort repair may mark: canonical Auto,
 * or a model Nexus's reasoning table lists. A row carrying its own `id` is a
 * remap or a user-authored copy, not the row Nexus wrote (Nexus rows never
 * set `id`); other `auto-*` mixes and FireRouter rows keep their behavior.
 * The two marking predicates differ by provenance, deliberately: repair
 * touches pre-existing rows of unknown origin, so it stays with the table;
 * {@link isAuthoredOpencodeReasoningRow} covers rows Nexus itself writes or
 * the user just selected through Nexus — and the shared reasoning layer
 * already grants every Nexus catalog model an effort ladder on the other
 * harnesses, so a Nexus-authored row carries the flag from the start.
 */
function isOpencodeReasoningRepairRow(modelId, entry) {
  if (isOpencodeAutoRow(modelId, entry)) return true;
  if (!isModelObject(entry) || entry.id !== undefined) return false;
  return isReasoningRowKey(modelId);
}

/**
 * Whether a row Nexus itself is writing (or the model being enabled) may be
 * marked: any catalog row Nexus authors for a model OpenCode's catalog does
 * not carry, not just the reasoning table's current entries, so a model
 * Nexus adds later gets effort controls without a code change here.
 */
function isAuthoredOpencodeReasoningRow(modelId, entry) {
  if (!isModelObject(entry)) return false;
  const slug = opencodeRowSlug(modelId);
  if (!slug || isFirerouterModelPattern(modelId)) return false;
  if (canonicalAutoModelId(slug)) return isOpencodeAutoRow(modelId, entry);
  return entry.id === undefined;
}

function markReasoning(modelId, entry, providerNpm, eligible) {
  if (!isModelObject(entry) || !eligible(modelId, entry)) return entry;
  if (["reasoning", "reasoning_options", "variants"].some((key) => entry[key] !== undefined)) return entry;
  if (entry.provider !== undefined && !isRowProviderOverride(entry.provider)) return entry;
  // OpenCode takes the row's SDK from its own provider.npm, then the provider's
  // npm, then models.dev (openai-compatible for fireworks-ai). Other SDKs build
  // differently shaped effort variants, so their rows stay as written.
  // Normalize the spellings config can carry (`aisdk:` prefix, `@version`
  // suffix) before comparing, or a compatible row silently never flags.
  const rawNpm = entry.provider?.npm ?? providerNpm ?? "@ai-sdk/openai-compatible";
  const npm = typeof rawNpm === "string"
    ? rawNpm.replace(/^aisdk:/, "").replace(/@[^@/]+$/, "")
    : rawNpm;
  if (npm !== "@ai-sdk/openai-compatible") return entry;
  return { ...entry, reasoning: true };
}

/**
 * Mark a reasoning row Nexus manages as a reasoning model: OpenCode 1.x
 * then offers its own effort variants and sends the one picked (2.x already
 * does), with no default effort. This covers canonical Auto and any model
 * Nexus adds that OpenCode's catalog does not list — those rows exist only
 * because Nexus wrote them, and without the flag 1.x silently drops the
 * selected effort. A row with effort controls the user set (`reasoning`,
 * `reasoning_options`, `variants`, loadable or not) stays as written: the
 * flag would change the choices OpenCode builds from them.
 * @param {string} modelId
 * @param {unknown} entry
 * @param {unknown} [providerNpm] `npm` of the provider entry holding the row
 */
export function withOpencodeReasoningEffort(modelId, entry, providerNpm) {
  return markReasoning(modelId, entry, providerNpm, isOpencodeReasoningRepairRow);
}

/**
 * {@link withOpencodeReasoningEffort} for a row Nexus is authoring now (or
 * the row of the model being enabled): not limited to the reasoning table,
 * so newly added catalog-missing models are covered as soon as Nexus writes
 * their row.
 * @param {string} modelId
 * @param {unknown} entry
 * @param {unknown} [providerNpm] `npm` of the provider entry holding the row
 */
export function withAuthoredOpencodeReasoningEffort(modelId, entry, providerNpm) {
  return markReasoning(modelId, entry, providerNpm, isAuthoredOpencodeReasoningRow);
}

/**
 * Build an OpenCode `provider.models` entry for a Microsoft Foundry deployment.
 * Foundry deployment names (FW-GLM-5.2, etc.) are absent from models.dev, so
 * limit.context/output must be set from the mapped Fireworks model specs.
 * @param {string} deploymentName
 * @returns {{ name: string, limit: { context: number, output: number }, modalities?: { input: string[] } }}
 */
export function buildOpencodeAzureModelEntry(deploymentName) {
  const limits = lookupAzureFoundryModelLimits(deploymentName);
  const entry = {
    name: deploymentName,
    limit: {
      context: limits.contextWindow,
      output: limits.maxTokens,
    },
  };
  const modalities = opencodeModalitiesField(limits);
  if (modalities) {
    entry.modalities = modalities;
  }
  return entry;
}

/** Canonical `provider.models` key — collapses full resource ids and legacy prefixed refs. */
export function opencodeProviderModelKey(modelId) {
  const stored = shortFireworksModelRef(normalizeModelId(modelId));
  // Path-shaped gateway IDs (firerouter/...) must match config.model after the
  // fireworks-ai/ prefix; last-segment collapse would orphan the override.
  if (
    stored.includes("/")
    && !stored.startsWith("accounts/")
    && !stored.startsWith("fireworks-ai/")
    && !stored.startsWith("fireworks/")
  ) {
    return stored;
  }
  return fireworksModelSlug(stored);
}

function homeFromDataDir(dataDir) {
  if (path.basename(dataDir) !== "opencode" || ![DATA_DIRNAME, LEGACY_DATA_DIRNAME].includes(path.basename(path.dirname(dataDir)))) {
    return "";
  }
  return path.dirname(path.dirname(dataDir));
}

export async function enableOpencodeFireworks({
  configPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  effectiveApiKey = "",
  modelId,
  byokHeaders = {},
  telemetryHeaders = {},
  catalogModelIds = [],
  catalogAvailable = catalogModelIds.length > 0,
}) {
  if (!apiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  await refreshModelsDevFireworksRegistry();

  const snapshot = await readRawIfExists(configPath);
  let config = {};
  if (snapshot.existed && snapshot.raw.trim()) {
    try {
      config = JSON.parse(snapshot.raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON`);
    }
  }

  // Resolve the reference for validation/model policy, but keep the reference
  // on disk so an environment-key rotation takes effect without re-running on.
  const resolvedEffective = effectiveApiKey?.trim()
    || (apiKey === OPENCODE_API_KEY_ENV_REF ? "" : apiKey);
  if (!resolvedEffective?.trim()) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const modelRef = typeof config.model === "string" ? config.model : "";
  // Model precedence: explicit request > model already configured by a previous
  // `on` > default. A repeat `on` without --model must not reset the user's choice.
  const currentModelId = modelRef.startsWith(prefix)
    ? modelRef.slice(prefix.length)
    : modelRef.startsWith("fireworks/")
      ? modelRef.slice("fireworks/".length)
      : "";

  // A plain re-`on` drops a carried-over FireRouter selection to `auto`;
  // (a FireRouter `--model` is rejected at admission, so `modelId` is never one from the CLI).
  const resolvedModel = normalizeModelId(modelId || dropRetiredModelId(currentModelId) || defaultMainModel());
  const storedModel = shortFireworksModelRef(resolvedModel);

  const backupPath = opencodeBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const providerStatus = opencodeProviderStatus(config);
  const hasFireconnectRouting = providerStatus === "fireworks"
    || providerStatus === "azure";
  const home = homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;
  if (shouldSnapshot) {
    // The snapshot can contain credentials from the user's other providers —
    // keep the backup (and its directory) private to the owner.
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const base = dropOpencodeProvider(withoutRetiredFireworksProvider(config), OPENCODE_AZURE_PROVIDER_ID);
  const existing = base.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID] ?? {};
  // FireRouter BYOK header (x-anthropic-api-key) lets the gateway pass hard
  // requests through to Anthropic. Drop any stale one when none is supplied
  // (e.g. switching firerouter → a direct model). x-openai-api-key is dropped
  // too, to clean up configs written before OpenAI BYOK was removed.
  // x-fireworks-api-key is dropped because the Fireworks key belongs in
  // options.apiKey, never in a header; stripping it here clears stale keys left
  // in headers by older releases, and the retired routing-preference header
  // goes the same way.
  const byokHeaderNames = [
    "x-anthropic-api-key",
    "x-openai-api-key",
    "x-fireworks-api-key",
    NEXUS_PROVIDERS_HEADER,
    RETIRED_ROUTING_PREFERENCE_HEADER,
  ];
  const priorHeaders = Object.fromEntries(
    Object.entries(existing.options?.headers ?? {}).filter(
      ([name]) => !byokHeaderNames.includes(name.toLowerCase()),
    ),
  );
  const nextHeaders = {
    ...mergeFireconnectTelemetryHeaders(priorHeaders, telemetryHeaders),
    ...(byokHeaders ?? {}),
  };
  const storedApiKey = resolvedEffective;
  const nextOptions = { ...(existing.options ?? {}), apiKey: storedApiKey };
  if (Object.keys(nextHeaders).length > 0) {
    nextOptions.headers = nextHeaders;
  } else {
    delete nextOptions.headers;
  }
  // The registerable set carries bare `auto` (see catalogWithAutomaticAuto);
  // keep it alongside the accounts/ rows so the picker can offer it.
  const catalog = catalogModelIds.filter(
    (id) => typeof id === "string" && (id.startsWith("accounts/") || isAutoModelId(id)),
  );
  const buildModels = (ids, priorModels) => {
    /** @type {Record<string, { name: string, modalities?: { input: string[] }, reasoning?: boolean, reasoning_options?: object[], variants?: Record<string, object> }>} */
    const out = {};
    for (const id of ids) {
      if (!opencodeNeedsProviderModelOverride(id)) {
        continue;
      }
      const normalized = normalizeModelId(id);
      const stored = opencodeProviderModelKey(normalized);
      if (stored) {
        const prior = priorModels[stored];
        // OpenCode rejects the whole file over one malformed value, so only
        // effort settings it can load carry over; the rest is rebuilt.
        // Nexus authors this row (the model is absent from OpenCode's
        // catalog), so it carries the reasoning flag unless the carried-over
        // settings or the provider SDK say otherwise.
        out[stored] = withAuthoredOpencodeReasoningEffort(stored, {
          ...buildOpencodeModelEntry(normalized),
          ...(typeof prior?.reasoning === "boolean" ? { reasoning: prior.reasoning } : {}),
          ...(isReasoningOptions(prior?.reasoning_options) ? { reasoning_options: prior.reasoning_options } : {}),
          ...(isVariantMap(prior?.variants) ? { variants: prior.variants } : {}),
        }, existing.npm);
      }
    }
    return out;
  };
  // Shared list policy (lib/harness/catalog-refresh.mjs), in the full
  // resource-id space; this code only translates ids to provider rows. Rows
  // the catalog serves are re-rendered from it (name, context limits, cost
  // all drift), other kept rows stay verbatim.
  const keyOf = (id) => {
    const key = opencodeProviderModelKey(id);
    return key ? fullFireworksResourceId(key) : "";
  };
  const prior = { ...(existing.models ?? {}) };
  // Legacy builds wrote several keys for one model (full id, provider
  // prefix, short slug); each is kept or pruned with its model.
  const priorIds = new Set(Object.keys(prior).map(keyOf));
  const served = new Set(catalog.map(fullFireworksResourceId));
  const ids = planModelList({
    currentIds: [...priorIds],
    freshIds: [...served],
    catalogAvailable,
    freshInstall: priorIds.size === 0,
    selectedId: keyOf(storedModel),
    keepUnserved: (id) => isAutoModelId(id) && !isAutoInstantModelId(id),
  });
  const keep = new Set(ids);
  let models = {
    ...Object.fromEntries(Object.entries(prior).filter(([key]) => keep.has(keyOf(key)))),
    // Fresh entries overwrite kept rows (metadata refresh) and fill the gaps.
    ...buildModels(ids.filter((id) => (catalogAvailable && served.has(id)) || !priorIds.has(id)), prior),
  };
  models = Object.fromEntries(Object.entries(withoutModelsDevDuplicates(models))
    .map(([id, entry]) => [id, withOpencodeReasoningEffort(id, entry, existing.npm)]));
  // The model being enabled may be a catalog-missing model the reasoning
  // table does not list yet; its row is Nexus-managed on this path even
  // when a previous release wrote it without the flag.
  const selectedKey = opencodeProviderModelKey(storedModel);
  if (selectedKey && models[selectedKey]) {
    models[selectedKey] = withAuthoredOpencodeReasoningEffort(selectedKey, models[selectedKey], existing.npm);
  }
  const hasLiteralSecret = Boolean(storedApiKey)
    || Object.keys(byokHeaders ?? {}).length > 0;
  const next = await writeOpencodeConfig(configPath, {
    ...base,
    provider: {
      ...base.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: { ...existing, options: nextOptions, models },
    },
    model: `${prefix}${opencodeConfigModelRef(resolvedModel)}`,
  }, { mode: hasLiteralSecret ? 0o600 : undefined });
  return {
    model: next.model,
    modelsAdded: Object.keys(next.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.models ?? {}),
    apiKeyMode: "literal",
  };
}

export async function enableOpencodeAzure({
  configPath,
  dataDir,
  apiKey,
  apiKeyFromFlag = false,
  baseUrl,
  modelId,
}) {
  if (!apiKey || (apiKey === AZURE_API_KEY_ENV_REF && !effectiveAzureApiKey(apiKey))) {
    throw new Error("No Azure API key found. Run `nexus configure --provider azure --api-key <key>` or export AZURE_API_KEY with your Foundry key.");
  }

  const normalizedBaseUrl = normalizeAzureBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error(
      "No Azure endpoint found. Pass --base-url with your Microsoft Foundry project endpoint "
      + "(e.g. https://<resource>.services.ai.azure.com).",
    );
  }

  const snapshot = await readRawIfExists(configPath);
  let config = {};
  if (snapshot.existed && snapshot.raw.trim()) {
    try {
      config = JSON.parse(snapshot.raw);
    } catch {
      throw new Error(`${configPath} is not valid JSON`);
    }
  }

  const backupPath = opencodeBackupPath(dataDir, configPath);
  const hasBackup = (await readJsonIfExists(backupPath)).snapshot !== undefined;
  const hasFireconnectRouting = opencodeProviderStatus(config) === "fireworks"
    || opencodeProviderStatus(config) === "azure";
  const home = homeFromDataDir(dataDir);
  const wasGloballyEnabled = home ? await isHarnessEnabled(home, HARNESS.OPENCODE) : false;
  const shouldSnapshot = !hasBackup
    ? !hasFireconnectRouting || !wasGloballyEnabled
    : !hasFireconnectRouting;
  if (shouldSnapshot) {
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, { configPath: path.resolve(configPath), snapshot });
    await chmod(backupPath, 0o600);
  }

  const base = dropOpencodeProvider(withoutRetiredFireworksProvider(config), OPENCODE_FIREWORKS_PROVIDER_ID);
  const existing = base.provider?.[OPENCODE_AZURE_PROVIDER_ID] ?? {};
  const resolvedModel = modelId || opencodeProviderStatus(config) === "azure"
    ? (modelId || opencodeCurrentModelId(config) || DEFAULT_AZURE_MODEL)
    : DEFAULT_AZURE_MODEL;
  const apiKeyValue = apiKeyFromFlag ? apiKey : AZURE_API_KEY_ENV_REF;
  const azureProvider = {
    ...existing,
    npm: AZURE_OPENAI_COMPATIBLE_NPM,
    name: AZURE_PROVIDER_LABEL,
    options: {
      ...(existing.options ?? {}),
      baseURL: normalizedBaseUrl,
      apiKey: apiKeyValue,
    },
    models: {
      ...(existing.models ?? {}),
      [resolvedModel]: buildOpencodeAzureModelEntry(resolvedModel),
    },
  };

  const next = await writeOpencodeConfig(configPath, {
    ...base,
    provider: { ...base.provider, [OPENCODE_AZURE_PROVIDER_ID]: azureProvider },
    model: `${OPENCODE_AZURE_PROVIDER_ID}/${resolvedModel}`,
  }, { mode: apiKeyFromFlag ? 0o600 : undefined });
  return {
    model: next.model,
    baseUrl: normalizedBaseUrl,
    apiKeyMode: apiKeyFromFlag ? "literal" : "env-reference",
  };
}

export async function disableOpencodeFireworks({ configPath, dataDir, wasEnabled = false }) {
  const backupPath = opencodeBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const config = await readJsonIfExists(configPath);
  const hasBackup = backup.snapshot !== undefined;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  const azurePrefix = `${OPENCODE_AZURE_PROVIDER_ID}/`;
  const hasOwnedProvider = Boolean(
    config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]
      || config.provider?.[OPENCODE_AZURE_PROVIDER_ID]
      || config.provider?.fireworks,
  );
  const hasOwnedModel = typeof config.model === "string"
    && (
      config.model.startsWith(prefix)
      || config.model.startsWith(azurePrefix)
      || config.model.startsWith("fireworks/")
    );

  if (!wasEnabled && !hasBackup && !hasOwnedProvider && !hasOwnedModel) {
    return "unchanged";
  }

  if (await restoreOpencodeSnapshot({ configPath, backupPath, backup })) {
    return "restored";
  }

  // No backup: strip only what we own, and only touch the file if we actually
  // removed something — never create a config that didn't exist, and never
  // re-serialize an unrelated config.
  const { existed } = await readRawIfExists(configPath);
  if (!existed) {
    return "unchanged";
  }
  const liveConfig = await readJsonIfExists(configPath);
  let stripped = OPENCODE_MANAGED_PROVIDER_IDS.reduce(
    (config, id) => dropOpencodeProvider(config, id),
    withoutRetiredFireworksProvider(liveConfig),
  );
  if (typeof stripped.model === "string"
    && (
      stripped.model.startsWith(prefix)
      || stripped.model.startsWith(azurePrefix)
      || stripped.model.startsWith("fireworks/")
    )) {
    const { model: _model, ...rest } = stripped;
    stripped = rest;
  }
  if (stripped === liveConfig && !isEmptyObject(liveConfig.provider)) {
    return "unchanged";
  }
  if (isEmptyObject(stripped.provider)) {
    const { provider: _empty, ...rest } = stripped;
    stripped = rest;
  }
  if (stripped.providers !== liveConfig.providers && isEmptyObject(stripped.providers)) {
    const { providers: _empty, ...rest } = stripped;
    stripped = rest;
  }
  await writeJson(configPath, stripped);
  return "stripped";
}

/**
 * Re-bake the gateway `fireworks-ai` provider's `options.apiKey` after a
 * login`/rotation. Converts legacy env-reference auth to a literal. Skips
 * unmanaged providers and Azure routes.
 * @param {{ configPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>}
 */
export async function refreshOpencodeGatewayKey({ configPath, fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) return false;
  const config = await readJsonIfExists(configPath);
  const gateway = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const current = gateway?.options?.apiKey;
  const envReference = opencodeAuthKeyMode(typeof current === "string" ? current : "") === "env-reference";
  const rotatable = typeof current === "string" && isFireworksShapedKey(current) && current !== key;
  if (!envReference && !rotatable) {
    return false;
  }
  await writeOpencodeConfig(configPath, {
    ...config,
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...gateway,
        options: { ...gateway.options, apiKey: key },
      },
    },
  }, { mode: 0o600 });
  return true;
}

/**
 * Drop saved provider keys from the gateway `fireworks-ai` provider's
 * `options.headers`, after `nexus auto --unset anthropic-api-key` / `--unset openai-api-key`.
 * @param {{ configPath: string, headerNames: string[] }} opts
 * @returns {Promise<boolean>} whether opencode.json changed
 */
export async function removeOpencodeSavedProviderKeys({ configPath, headerNames }) {
  const config = await readJsonIfExists(configPath);
  const gateway = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const headers = omitHeaders(gateway?.options?.headers, headerNames);
  if (!headers) {
    return false;
  }
  const { headers: _dropped, ...options } = gateway.options;
  await writeOpencodeConfig(configPath, {
    ...config,
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...gateway,
        options: Object.keys(headers).length ? { ...options, headers } : options,
      },
    },
  }, { mode: 0o600 });
  return true;
}
