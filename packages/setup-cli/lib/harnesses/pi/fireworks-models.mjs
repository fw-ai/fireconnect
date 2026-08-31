import {
  appendLatestRouterSuffix,
  fireworksInputModalities,
  isRouterShortId,
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
  lookupModelSpec,
  resolveFireworksModelLabel,
} from "../../fireworks/model-specs.mjs";
import {
  fireworksModelSlug,
  fullFireworksResourceId,
  isAutoModelId,
  isFirerouterModelPattern,
} from "../../fireworks/model-id.mjs";
import { autoDisplayName, firerouterDisplayName, prettyModelName, preferLatestAliases } from "../../fireworks/models.mjs";
import { getServerlessCatalogSnapshot } from "../../fireworks/serverless-catalog-cache.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";

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

const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_TOKENS = 16_384;
const PI_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function withPiModelDefaults(model) {
  return {
    reasoning: false,
    input: ["text"],
    contextWindow: PI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: PI_DEFAULT_MAX_TOKENS,
    cost: PI_DEFAULT_COST,
    ...model,
    cost: model.cost ?? PI_DEFAULT_COST,
  };
}

function piFireworksDisplayName(modelId) {
  if (isFirerouterModelPattern(modelId)) {
    return firerouterDisplayName(modelId);
  }
  if (isAutoModelId(modelId)) {
    return autoDisplayName(modelId);
  }
  const liveLabel = resolveFireworksModelLabel(modelId);
  if (liveLabel) {
    return liveLabel;
  }
  const spec = lookupModelSpec(modelId);
  if (spec?.label) {
    return appendLatestRouterSuffix(modelId, spec.label);
  }
  return prettyModelName(modelId);
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
  // Router aliases / suffixed router slugs, by the same heuristic
  // fullFireworksResourceId uses to pick routers/ vs models/.
  return isRouterShortId(fireworksModelSlug(id));
}

function piModelsToRegister(resolvedModel, catalogModelIds = []) {
  // Always register FireConnect's router catalog (-latest/-fast/-turbo aliases +
  // firerouter*) — not concrete models like gpt-oss-120b — so every router is
  // pickable in Pi's UI regardless of which one is active (firerouter included).
  // The picker is scoped to routers via `enabledModels` (see
  // PI_FIREWORKS_ROUTER_SCOPE), so Pi's built-in concrete models don't surface.
  // Offline, fall back to the cached serverless catalog, filtered the same way.
  const catalog = catalogModelIds.filter((id) => typeof id === "string" && id.startsWith("accounts/"));
  const routerCatalog = (catalog.length ? catalog : cachedFireworksModelIds())
    .filter(isRouterCatalogId);
  const entries = routerCatalog.map((id) => ({ id, name: piFireworksDisplayName(id), reasoning: true }));
  // Always include the active model so a `--model <id>` that isn't in the router
  // catalog (e.g. `auto`, a concrete direct model, or a custom deployment) is
  // still registered — it becomes defaultModel, and piEnabledModels adds it to
  // the scope so Pi actually uses it.
  const resolvedCanonical = fullFireworksResourceId(resolvedModel);
  if (resolvedCanonical
    && !entries.some((entry) => fullFireworksResourceId(entry.id) === resolvedCanonical)) {
    entries.push({
      id: resolvedModel,
      name: piFireworksDisplayName(resolvedModel),
      reasoning: true,
    });
  }
  return entries;
}

export function managedPiFireworksModelIds(resolvedModel, catalogModelIds = []) {
  return piModelsToRegister(resolvedModel, catalogModelIds)
    .map((entry) => fullFireworksResourceId(entry.id));
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
    name: piFireworksDisplayName(canonicalId),
    reasoning: true,
    input: fireworksInputModalities(limits),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    ...(cost ? { cost } : {}),
  });
}

export function mergePiFireworksRouterModels(config, resolvedModel, managedHeaders = {}, catalogModelIds = [], previousManagedIds = [], { firepass = false } = {}) {
  const next = config && typeof config === "object"
    ? structuredClone(config)
    : { providers: {} };
  next.providers ??= {};
  const fireworks = { ...(next.providers[PI_PROVIDER] ?? {}) };
  let models = [...(fireworks.models ?? [])];
  const modelOverrides = { ...(fireworks.modelOverrides ?? {}) };

  // When rebuilding from a fresh catalog (or switching to firerouter), drop the
  // ids FireConnect registered last time so the live config matches the current
  // catalog exactly — no accumulation. User-added entries are left untouched.
  // Offline (empty catalog, direct mode) we skip this and merge, so a transient
  // catalog fetch failure doesn't wipe the picker.
  const rebuilding = isFirerouterModelPattern(resolvedModel)
    || catalogModelIds.some((id) => typeof id === "string" && id.startsWith("accounts/"));
  if (rebuilding && previousManagedIds.length) {
    const prior = new Set(previousManagedIds.map(fullFireworksResourceId));
    models = models.filter(
      (model) => !prior.has(fullFireworksResourceId(model.id)),
    );
    for (const id of Object.keys(modelOverrides)) {
      if (prior.has(fullFireworksResourceId(id))) {
        delete modelOverrides[id];
      }
    }
  }

  for (const entry of piModelsToRegister(resolvedModel, catalogModelIds)) {
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
    const merged = { ...(existing ?? {}), ...customEntry };
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
