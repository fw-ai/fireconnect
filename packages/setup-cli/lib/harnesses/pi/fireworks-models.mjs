import { resolveManagedDisplayName } from "../../fireworks/model-display.mjs";
import {
  DEFAULT_FIREWORKS_MODEL_LIMITS,
  fireworksInputModalities,
  isRouterShortId,
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
} from "../../fireworks/model-specs.mjs";
import {
  fireworksModelSlug,
  fullFireworksResourceId,
  isAutoModelId,
  isFirerouterModelPattern,
} from "../../fireworks/model-id.mjs";
import { preferLatestAliases } from "../../fireworks/models.mjs";
import { getServerlessCatalogSnapshot } from "../../fireworks/serverless-catalog-cache.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";
import { planCatalogRefresh } from "../../harness/catalog-refresh.mjs";

const PI_PROVIDER = "fireworks";

/**
 * Fireworks model ids currently known from the in-process serverless catalog
 * cache (preferLatestAliases-filtered, like the live registerable set). Used as
 * the offline/no-catalog registration source instead of a hand-maintained list.
 * Returns [] when no cached snapshot is available.
 */
export function cachedFireworksModelIds() {
  const snapshot = getServerlessCatalogSnapshot();
  if (!snapshot?.entries?.length) {
    return [];
  }
  return preferLatestAliases(snapshot.entries)
    .filter((entry) => typeof entry.id === "string" && entry.id.startsWith("accounts/"))
    .map((entry) => entry.id);
}

const PI_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function withPiModelDefaults(model) {
  return {
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow,
    maxTokens: DEFAULT_FIREWORKS_MODEL_LIMITS.maxTokens,
    cost: PI_DEFAULT_COST,
    ...model,
    cost: model.cost ?? PI_DEFAULT_COST,
  };
}

/**
 * Full custom model entry keyed by the canonical accounts/fireworks/... id, so
 * Pi's `mergeCustomModels` replaces any built-in row of the same id (an actual
 * override, not a short-id duplicate) and appends models Pi doesn't ship.
 * Limits/modalities/cost come from the shared Fireworks specs — the same source
 * OpenCode's `buildOpencodeModelEntry` uses — so there is no Pi-specific catalog
 * table to keep in sync.
 * @param {string} modelId
 * @param {string} name
 * @param {boolean} [reasoning=true]
 * @param {{ firepass?: boolean }} [options]
 */
export function buildPiCustomFireworksModelEntry(modelId, name, reasoning = true, { firepass = false } = {}) {
  const limits = lookupFireworksModelLimits(modelId);
  const entry = {
    id: fullFireworksResourceId(modelId),
    name,
    reasoning,
    input: fireworksInputModalities(limits),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
  };
  // Fire Pass is a subscription — no per-model metered cost.
  const cost = lookupFireworksModelCost(modelId, { firepass });
  if (cost) {
    entry.cost = cost;
  }
  return entry;
}

/**
 * Pi `enabledModels` glob that scopes the picker to FireConnect's router rows
 * only, hiding Pi's built-in concrete Fireworks models (gpt-oss-120b, glm-5p2,
 * …) which surface because they share the `fireworks` provider auth. Matched by
 * Pi's resolveModelScope against `provider/modelId` (provider = "fireworks").
 */
export const PI_FIREWORKS_ROUTER_SCOPE = "fireworks/accounts/fireworks/routers/*";
export const PI_ENABLED_MODELS = [PI_FIREWORKS_ROUTER_SCOPE];
/** Picker scope entry for the `auto` mix (`provider/modelId` glob form). */
export const PI_AUTO_ENABLED_MODEL = "fireworks/auto";

const PI_ROUTER_ID_PREFIX = "accounts/fireworks/routers/";

/**
 * Pi resolves `defaultModel` through `enabledModels` and silently substitutes
 * its own built-in default when the model falls outside that scope — which then
 * 404s, because Pi's default (kimi-k2p5-turbo) is long gone from the gateway.
 * So any active model that isn't a router-path id (`auto`, a concrete serverless
 * model, a custom deployment) is enabled explicitly alongside the router scope.
 * @param {string} activeModelId id as stored in Pi's config
 */
export function piEnabledModels(activeModelId) {
  const stored = fullFireworksResourceId(activeModelId ?? "");
  if (!stored || stored.startsWith(PI_ROUTER_ID_PREFIX)) {
    return [...PI_ENABLED_MODELS];
  }
  return [...PI_ENABLED_MODELS, `${PI_PROVIDER}/${stored}`];
}

function isRouterCatalogId(id) {
  if (!id || typeof id !== "string") {
    return false;
  }
  // firerouter* gateway patterns (incl. slash-bearing like firerouter/x).
  if (isFirerouterModelPattern(id)) {
    return true;
  }
  if (id.startsWith("accounts/fireworks/routers/")) {
    return true;
  }
  // Router aliases / suffixed router slugs, by the same heuristic
  // fullFireworksResourceId uses to pick routers/ vs models/.
  return isRouterShortId(fireworksModelSlug(id));
}

function piCatalogEntry(id) {
  return { id, name: resolveManagedDisplayName(id), reasoning: true };
}

function piModelsToRegister(resolvedModel, catalogModelIds = []) {
  // The registerable set carries bare `auto` (see catalogWithAutomaticAuto);
  // keep it alongside the accounts/ rows so the picker can offer it.
  const catalog = catalogModelIds.filter(
    (id) => typeof id === "string" && (id.startsWith("accounts/") || isAutoModelId(id)),
  );
  const routerCatalog = (catalog.length ? catalog : cachedFireworksModelIds())
    .filter((id) => isRouterCatalogId(id) || isAutoModelId(id));
  const entries = routerCatalog.map(piCatalogEntry);
  const resolvedCanonical = fullFireworksResourceId(resolvedModel);
  if (resolvedCanonical
    && !entries.some((entry) => fullFireworksResourceId(entry.id) === resolvedCanonical)) {
    entries.push(piCatalogEntry(resolvedModel));
  }
  return entries;
}

export function planPiCatalogUpdate(
  resolvedModel,
  catalogModelIds,
  previousManagedIds,
  {
    modelRequested = false,
    catalogAvailable = false,
    existingModelIds = [],
    initialized = false,
  } = {},
) {
  const previous = previousManagedIds.map(fullFireworksResourceId);
  if (modelRequested) {
    const selected = fullFireworksResourceId(resolvedModel);
    const existing = new Set(existingModelIds.map(fullFireworksResourceId));
    const managed = previous.includes(selected) || !existing.has(selected)
      ? [...new Set([...previous, selected])]
      : previous;
    return {
      add: [piCatalogEntry(resolvedModel)],
      refresh: [],
      remove: [],
      managed,
    };
  }
  if (!initialized) {
    const add = piModelsToRegister(resolvedModel, catalogModelIds);
    return {
      add,
      refresh: [],
      remove: [],
      managed: add.map((entry) => fullFireworksResourceId(entry.id)),
    };
  }
  if (!catalogAvailable) {
    return { add: [], refresh: [], remove: [], managed: previous };
  }
  // Shared catalog-refresh policy: prune delisted managed ids, add newly
  // served ones, and refresh metadata (name/limits/cost) of kept managed rows.
  const plan = planCatalogRefresh({
    currentIds: previous,
    freshIds: catalogModelIds.map(fullFireworksResourceId),
    keepUnserved: (id) => isAutoModelId(id) || isFirerouterModelPattern(id),
  });
  const existing = new Set(existingModelIds.map(fullFireworksResourceId));
  // Additions only with ownership evidence: a lost managedModelIds record
  // (empty `previous` on an initialized install) means the config may be the
  // user's own, so reseeding it would be a hijack. Never claim a row the
  // config already carries under that id either.
  const add = previous.length === 0
    ? []
    : plan.added
      .filter((id) => !existing.has(id))
      .map((id) => piCatalogEntry(id));
  const refresh = plan.kept
    .filter((id) => existing.has(id))
    .map((id) => piCatalogEntry(id));
  return {
    add,
    refresh,
    remove: plan.pruned,
    managed: [...plan.kept, ...add.map((entry) => fullFireworksResourceId(entry.id))],
  };
}

function applyPiModelOverride(base, override) {
  if (!override) {
    return { ...base };
  }
  const merged = { ...base, ...override };
  if (base.cost && override.cost) {
    merged.cost = { ...base.cost, ...override.cost };
  }
  return merged;
}

/**
 * Resolve the effective Pi fireworks model after applying models.json wiring.
 * Mirrors Pi's merge rules (model-registry.js): a `models` entry whose canonical
 * id matches replaces the built-in; otherwise limits/cost resolve from the
 * shared Fireworks specs (the same source the entries are built from).
 * @param {object | undefined} fireworksProvider
 * @param {string} modelId
 */
export function resolvePiEffectiveFireworksModel(fireworksProvider, modelId) {
  const canonicalId = fullFireworksResourceId(modelId);
  const custom = fireworksProvider?.models?.find(
    (model) => fullFireworksResourceId(model.id) === canonicalId,
  );
  if (custom) {
    return withPiModelDefaults(custom);
  }
  const limits = lookupFireworksModelLimits(canonicalId);
  const cost = lookupFireworksModelCost(modelId);
  return withPiModelDefaults({
    id: canonicalId,
    name: resolveManagedDisplayName(canonicalId),
    reasoning: true,
    input: fireworksInputModalities(limits),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    ...(cost ? { cost } : {}),
  });
}

export function mergePiFireworksRouterModels(config, resolvedModel, managedHeaders = {}, catalogModelIds = [], previousManagedIds = [], { firepass = false, modelRequested = false, catalogAvailable = false, catalogPlan = null } = {}) {
  const next = config && typeof config === "object"
    ? structuredClone(config)
    : { providers: {} };
  next.providers ??= {};
  const initialized = Boolean(next.providers[PI_PROVIDER]);
  const fireworks = { ...(next.providers[PI_PROVIDER] ?? {}) };
  let models = [...(fireworks.models ?? [])];
  const modelOverrides = { ...(fireworks.modelOverrides ?? {}) };

  const plan = catalogPlan ?? planPiCatalogUpdate(
    resolvedModel,
    catalogModelIds,
    previousManagedIds,
    {
      modelRequested,
      catalogAvailable,
      existingModelIds: models.map((model) => model.id),
      initialized,
    },
  );
  if (plan.remove.length) {
    const removed = new Set(plan.remove);
    models = models.filter(
      (model) => !removed.has(fullFireworksResourceId(model.id)),
    );
    for (const id of Object.keys(modelOverrides)) {
      if (removed.has(fullFireworksResourceId(id))) {
        delete modelOverrides[id];
      }
    }
  }

  // plan.refresh: managed rows re-rendered from the current spec/catalog
  // (name, context limits, cost drift over time); plan.add keeps the existing
  // row when one exists so an explicit --model never claims a user's own row.
  const refreshIds = new Set((plan.refresh ?? []).map((entry) => fullFireworksResourceId(entry.id)));
  for (const entry of [...plan.add, ...(plan.refresh ?? [])]) {
    const canonicalId = fullFireworksResourceId(entry.id);
    const customEntry = buildPiCustomFireworksModelEntry(
      entry.id,
      entry.name,
      entry.reasoning,
      { firepass },
    );
    const existing = models.find(
      (model) => fullFireworksResourceId(model.id) === canonicalId,
    );
    models = models.filter(
      (model) => fullFireworksResourceId(model.id) !== canonicalId,
    );
    const merged = refreshIds.has(canonicalId) ? customEntry : (existing ?? customEntry);
    if (firepass) {
      // Subscription: never inherit a metered cost from a previous row.
      delete merged.cost;
    }
    models.push(merged);
    for (const id of Object.keys(modelOverrides)) {
      if (fullFireworksResourceId(id) === canonicalId) {
        delete modelOverrides[id];
      }
    }
  }

  if (models.length) {
    fireworks.models = models;
  } else {
    delete fireworks.models;
  }
  if (Object.keys(modelOverrides).length) {
    fireworks.modelOverrides = modelOverrides;
  } else {
    delete fireworks.modelOverrides;
  }
  fireworks.compat = {
    ...(fireworks.compat ?? {}),
    sendSessionAffinityHeaders: true,
  };
  // FireRouter BYOK header (x-anthropic-api-key). Drop any stale one first so
  // switching firerouter → a direct model clears it; x-openai-api-key is dropped
  // too, to clean up configs written before OpenAI BYOK was removed.
  const byokHeaderNames = ["x-anthropic-api-key", "x-openai-api-key"];
  const headersWithoutByok = Object.fromEntries(
    Object.entries(fireworks.headers ?? {}).filter(
      ([name]) => !byokHeaderNames.includes(name.toLowerCase()),
    ),
  );
  const headers = mergeFireconnectTelemetryHeaders(
    headersWithoutByok,
    managedHeaders,
  );
  if (Object.keys(headers).length) {
    fireworks.headers = headers;
  } else {
    delete fireworks.headers;
  }
  next.providers[PI_PROVIDER] = fireworks;
  return next;
}

export const ONE_MILLION_CONTEXT = 1_000_000;
