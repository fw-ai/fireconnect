/**
 * OpenCode v2 reads providers from `providers` and migrates the v1 `provider`
 * key, but a native `providers[id]` in the same file replaces the migrated
 * `provider[id]` wholesale. While Nexus manages `provider[id]` it
 * therefore owns `providers[id]` too, and rebuilds it from `provider[id]`
 * exactly as OpenCode's own v1 migration would (`packages/core/src/v1/config/
 * migrate.ts` in OpenCode), so both keys describe the same provider.
 */

const AISDK_PREFIX = "aisdk:";
const DEFAULT_CAPABILITIES = { tools: true, input: ["text", "image"], output: ["text"] };

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutUndefined(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

function aisdkPackage(npm) {
  return npm.startsWith(AISDK_PREFIX) ? npm : `${AISDK_PREFIX}${npm}`;
}

function int(value) {
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)));
}

function costTier(cost, tier) {
  return withoutUndefined({
    tier,
    input: cost.input,
    output: cost.output,
    cache: withoutUndefined({ read: cost.cache_read, write: cost.cache_write }),
  });
}

/**
 * The v2 `capabilities.reasoning` for a v1 row, mirroring OpenCode's own
 * catalog conversion: `reasoning: false` (or options without the flag) is
 * unsupported, otherwise the row's `reasoning_options` supply the effort
 * values, toggle and token budget. OpenCode 2.x builds a model's variants
 * from this object and rejects a bare boolean; with no effort option it
 * generates none, so a flagged row falls back to the low/medium/high
 * ladder OpenCode 1.x generates for `@ai-sdk/openai-compatible`.
 * @param {Record<string, any>} model
 */
function reasoningCapability(model) {
  if (typeof model.reasoning !== "boolean" && !Array.isArray(model.reasoning_options)) {
    return undefined;
  }
  if (!model.reasoning) {
    return { supported: false };
  }
  const options = (model.reasoning_options ?? []).filter(isPlainObject);
  const effort = options.find((option) => option.type === "effort");
  const values = Array.isArray(effort?.values)
    ? effort.values.filter((value) => typeof value === "string")
    : [];
  const budget = options.find((option) => option.type === "budget_tokens");
  return withoutUndefined({
    supported: true,
    effort: values.length ? values : ["low", "medium", "high"],
    toggle: options.some((option) => option.type === "toggle") ? true : undefined,
    budget: budget && ["min", "max"].some((key) => Number.isFinite(budget[key]))
      ? withoutUndefined({
        min: Number.isFinite(budget.min) ? budget.min : undefined,
        max: Number.isFinite(budget.max) ? budget.max : undefined,
      })
      : undefined,
  });
}

function reasoningCompatibility(interleaved) {
  if (typeof interleaved === "string") return { reasoningField: interleaved };
  if (isPlainObject(interleaved) && typeof interleaved.field === "string") {
    return { reasoningField: interleaved.field };
  }
  return undefined;
}

/** Strip v1 `blockBinding: false` opt-outs from model options; reports whether any was set. */
function extractBlockBindingOptOut(options) {
  if (!isPlainObject(options)) return { options, optOut: false };
  const optOut = ["thinking", "reasoningConfig"].some((key) => options[key]?.blockBinding === false);
  if (!optOut) return { options, optOut };
  const next = { ...options };
  for (const key of ["thinking", "reasoningConfig"]) {
    if (next[key]?.blockBinding !== false) continue;
    const { blockBinding: _optOut, ...rest } = next[key];
    if (Object.keys(rest).length) {
      next[key] = rest;
    } else {
      delete next[key];
    }
  }
  return { options: next, optOut };
}

function v2Model(model) {
  const { options, optOut } = extractBlockBindingOptOut(model.options);
  const compatibility = reasoningCompatibility(model.interleaved);
  const reasoning = reasoningCapability(model);
  const hasCapabilities = model.tool_call !== undefined
    || model.modalities?.input !== undefined
    || model.modalities?.output !== undefined;
  return withoutUndefined({
    modelID: model.id,
    family: model.family,
    name: model.name,
    compatibility: optOut ? { ...compatibility, supportsThinkingBlockBinding: false } : compatibility,
    package: model.provider?.npm ? aisdkPackage(model.provider.npm) : undefined,
    settings: model.provider?.api ? { ...options, baseURL: model.provider.api } : options,
    capabilities: hasCapabilities
      ? {
        tools: model.tool_call ?? DEFAULT_CAPABILITIES.tools,
        input: model.modalities?.input ?? DEFAULT_CAPABILITIES.input,
        output: model.modalities?.output ?? DEFAULT_CAPABILITIES.output,
        ...(reasoning ? { reasoning } : {}),
      }
      // A reasoning-only override must inherit the catalog's other capabilities.
      : reasoning ? { reasoning } : undefined,
    headers: model.headers,
    variants: model.variants
      && Object.entries(model.variants).map(([id, settings]) => ({ id, settings: { ...settings } })),
    cost: model.cost && [
      costTier(model.cost),
      ...(model.cost.context_over_200k
        ? [costTier(model.cost.context_over_200k, { type: "context", size: 200_000 })]
        : []),
    ],
    disabled: model.status === "deprecated" ? true : undefined,
    limit: model.limit && withoutUndefined({
      context: int(model.limit.context),
      input: model.limit.input === undefined ? undefined : int(model.limit.input),
      output: int(model.limit.output),
    }),
  });
}

/**
 * The v2 `providers[id]` entry equivalent to a v1 `provider[id]` entry.
 * @param {Record<string, any>} provider
 */
export function opencodeV2ProviderEntry(provider) {
  const options = isPlainObject(provider.options) ? provider.options : undefined;
  const { headers, body, ...settings } = options ?? {};
  return withoutUndefined({
    name: provider.name,
    env: provider.env,
    package: provider.npm ? aisdkPackage(provider.npm) : undefined,
    settings: provider.api ? { ...settings, baseURL: provider.api } : options ? settings : undefined,
    headers: isPlainObject(headers)
      ? Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string"))
      : undefined,
    body: isPlainObject(body) ? { ...body } : undefined,
    // OpenCode rejects malformed v1 rows, so they have no v2 equivalent.
    models: isPlainObject(provider.models)
      ? Object.fromEntries(
        Object.entries(provider.models)
          .filter(([, model]) => isPlainObject(model))
          .map(([id, model]) => [id, v2Model(model)]),
      )
      : undefined,
  });
}

/**
 * Rebuild `providers[id]` from `provider[id]` for each owned id Nexus
 * manages. Configs without a `providers` map are returned unchanged: v1-only
 * setups never gain a key their OpenCode doesn't read.
 * @param {Record<string, any>} config
 * @param {readonly string[]} ownedIds
 */
export function mirrorOpencodeV2Providers(config, ownedIds) {
  if (!isPlainObject(config.providers)) {
    return config;
  }
  const providers = { ...config.providers };
  for (const id of ownedIds) {
    if (isPlainObject(config.provider?.[id])) {
      providers[id] = opencodeV2ProviderEntry(config.provider[id]);
    }
  }
  return { ...config, providers };
}

/**
 * Remove a managed provider from both maps. `providers[id]` is only ours
 * while `provider[id]` exists, so a native-only v2 entry is left alone.
 * @param {Record<string, any>} config
 * @param {string} id
 */
export function dropOpencodeProvider(config, id) {
  if (!isPlainObject(config.provider?.[id])) {
    return config;
  }
  const { [id]: _legacy, ...provider } = config.provider;
  const next = { ...config, provider };
  if (isPlainObject(config.providers)) {
    const { [id]: _native, ...providers } = config.providers;
    next.providers = providers;
  }
  return next;
}
