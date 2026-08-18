import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FIREWORKS_MODEL_SPECS,
  isUsableCachedServerlessPricing,
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
  lookupModelSpec,
  pricingMatchesModelRefTier,
  requiresFastTierPricing,
  resolveFireworksCatalog,
  resolveFireworksModelLabel,
  resolveRouterEntryDisplayName,
  resolveRouterSpecAliasTarget,
  resolveSpecSlug,
  isFireworksRoutedModelRef,
} from "../../lib/fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../lib/fireworks/pricing.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { buildOpencodeModelEntry } from "../../lib/harnesses/opencode/core.mjs";
import { buildPiCustomFireworksModelEntry } from "../../lib/harnesses/pi/fireworks-models.mjs";
import { buildDeepseekFireworksModelEntry } from "../../lib/harnesses/deepseek/core.mjs";
import { assumedModelsDevListed } from "../../lib/harnesses/opencode/catalog-policy.mjs";

describe("fireworks-model-specs", () => {
  it("every priced model has capabilities metadata", () => {
    for (const [slug, spec] of Object.entries(FIREWORKS_MODEL_SPECS)) {
      if (!spec.pricing) {
        continue;
      }
      assert.ok(spec.capabilities, `missing capabilities for ${slug}`);
      assert.equal(typeof spec.capabilities.contextWindow, "number");
      assert.equal(typeof spec.capabilities.maxOutputTokens, "number");
      assert.equal(typeof spec.capabilities.vision, "boolean");
      assert.equal(typeof spec.capabilities.toolCalling, "boolean");
    }
  });

  it("does not append Fast to turbo router display names", () => {
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "Kimi K2.6 Turbo",
      ),
      "Kimi K2.6 Turbo",
    );
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "Kimi K2.6 Turbo",
        { pricingTier: "fast" },
      ),
      "Kimi K2.6 Turbo",
    );
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "Kimi K2.6",
        { pricingTier: "fast" },
      ),
      "Kimi K2.6",
    );
    assert.equal(
      resolveRouterEntryDisplayName(
        "accounts/fireworks/routers/kimi-fast-latest",
        "Kimi K3 Fast",
      ),
      "Kimi K3 Fast (Latest)",
    );
  });

  it("prefers kimi-k3 over static kimi-latest aliases when catalog lists Kimi K3", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k3",
        shortId: "kimi-k3",
        displayName: "Kimi K3",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("kimi-latest"), "kimi-k3");
      assert.equal(resolveSpecSlug("kimi-fast-latest"), "kimi-k3-fast");
      assert.equal(resolveRouterSpecAliasTarget("kimi-latest"), "kimi-k3");
      assert.equal(resolveRouterSpecAliasTarget("kimi-fast-latest"), "kimi-k3-fast");
      assert.equal(resolveFireworksModelLabel("kimi-latest"), "Kimi K3 (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("maps kimi-fast-latest to kimi-k3-fast when catalog lists both Kimi K3 variants", () => {
    setServerlessCatalogSnapshot({
      entries: [
        {
          id: "accounts/fireworks/models/kimi-k3",
          shortId: "kimi-k3",
          displayName: "Kimi K3",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/models/kimi-k3-fast",
          shortId: "kimi-k3-fast",
          displayName: "Kimi K3 Fast",
          kind: "serverless",
        },
      ],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k3-fast"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("kimi-fast-latest"), "kimi-k3-fast");
      assert.equal(resolveRouterSpecAliasTarget("kimi-fast-latest"), "kimi-k3-fast");
      assert.equal(resolveFireworksModelLabel("kimi-fast-latest"), "Kimi K3 Fast (Latest)");
      const spec = lookupModelSpec("kimi-fast-latest");
      assert.equal(spec?.label, "Kimi K3 Fast");
      assert.equal(spec?.pricing?.tier, "fast");
      assert.equal(spec?.pricing?.input, 6.00);
      assert.equal(lookupFireworksPricing("kimi-fast-latest")?.output, 30.00);
      assert.equal(lookupFireworksModelCost("kimi-fast-latest")?.input, 6.00);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("falls back to static kimi-k3-fast pricing when Kimi K3 is listed without API rates", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k3",
        shortId: "kimi-k3",
        displayName: "Kimi K3",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k3"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const pricing = lookupFireworksPricing("kimi-fast-latest");
      assert.equal(pricing?.tier, "fast");
      assert.equal(pricing?.input, 6.00);
      assert.equal(pricing?.output, 30.00);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("prefers catalog-listed minimax and qwen-plus models for -latest aliases", () => {
    setServerlessCatalogSnapshot({
      entries: [
        {
          id: "accounts/fireworks/models/minimax-m2p7",
          shortId: "minimax-m2p7",
          displayName: "MiniMax 2.7",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/models/minimax-m3",
          shortId: "minimax-m3",
          displayName: "MiniMax M3",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/models/qwen3p6-plus",
          shortId: "qwen3p6-plus",
          displayName: "Qwen 3.6 Plus",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/models/qwen3p7-plus",
          shortId: "qwen3p7-plus",
          displayName: "Qwen 3.7 Plus",
          kind: "serverless",
        },
      ],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveRouterSpecAliasTarget("minimax-latest"), "minimax-m3");
      assert.equal(resolveRouterSpecAliasTarget("qwen-plus-latest"), "qwen3p7-plus");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("falls back to static minimax-latest and qwen-plus-latest targets without catalog context", () => {
    setServerlessCatalogSnapshot(null);
    assert.equal(resolveRouterSpecAliasTarget("minimax-latest"), "minimax-m3");
    assert.equal(resolveRouterSpecAliasTarget("qwen-plus-latest"), "qwen3p7-plus");
    assert.equal(resolveRouterSpecAliasTarget("deepseek-flash-latest"), "deepseek-v4-flash-0731");
    assert.equal(resolveRouterSpecAliasTarget("deepseek-pro-latest"), "deepseek-v4-pro-0813");
  });

  it("maps deepseek-flash-latest to deepseek-v4-flash-0731 metadata", () => {
    const flashPricing = {
      slug: "deepseek-v4-flash-0731",
      label: "DeepSeek V4 Flash (0731)",
      input: 0.14,
      cachedInput: 0.028,
      output: 0.28,
      tier: "standard",
      source: "api",
    };
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/deepseek-v4-flash-0731",
        shortId: "deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash (0731)",
        kind: "serverless",
      }],
      pricingById: new Map([
        ["accounts/fireworks/models/deepseek-v4-flash-0731", flashPricing],
        ["accounts/fireworks/routers/deepseek-flash-latest", flashPricing],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/deepseek-flash-latest", "accounts/fireworks/models/deepseek-v4-flash-0731"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("deepseek-flash-latest"), "deepseek-v4-flash-0731");
      assert.equal(resolveRouterSpecAliasTarget("deepseek-flash-latest"), "deepseek-v4-flash-0731");
      assert.equal(resolveFireworksModelLabel("deepseek-flash-latest"), "DeepSeek V4 Flash (0731) (Latest)");
      const spec = lookupModelSpec("deepseek-flash-latest");
      assert.equal(spec?.label, "DeepSeek V4 Flash (0731)");
      // The dated pin carries the documented sibling rates as an offline
      // fallback; live catalog pricing still wins below.
      assert.deepEqual(spec?.pricing, { input: 0.14, cachedInput: 0.028, output: 0.28 });
      assert.equal(lookupFireworksPricing("deepseek-flash-latest")?.output, 0.28);
      assert.equal(lookupFireworksPricing("deepseek-flash-latest")?.source, "api");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("maps deepseek-pro-latest to deepseek-v4-pro-0813 metadata", () => {
    const proPricing = {
      slug: "deepseek-v4-pro-0813",
      label: "DeepSeek V4 Pro (0813)",
      input: 1.32,
      cachedInput: 0.044,
      output: 3.96,
      tier: "standard",
      source: "api",
    };
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/deepseek-v4-pro-0813",
        shortId: "deepseek-v4-pro-0813",
        displayName: "DeepSeek V4 Pro (0813)",
        kind: "serverless",
      }],
      pricingById: new Map([
        ["accounts/fireworks/models/deepseek-v4-pro-0813", proPricing],
        ["accounts/fireworks/routers/deepseek-pro-latest", proPricing],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/deepseek-pro-latest", "accounts/fireworks/models/deepseek-v4-pro-0813"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("deepseek-pro-latest"), "deepseek-v4-pro-0813");
      assert.equal(resolveRouterSpecAliasTarget("deepseek-pro-latest"), "deepseek-v4-pro-0813");
      assert.equal(resolveFireworksModelLabel("deepseek-pro-latest"), "DeepSeek V4 Pro (0813) (Latest)");
      const spec = lookupModelSpec("deepseek-pro-latest");
      assert.equal(spec?.label, "DeepSeek V4 Pro (0813)");
      // The dated pin carries the documented sibling rates as an offline
      // fallback; live catalog pricing still wins below.
      assert.deepEqual(spec?.pricing, { input: 1.74, cachedInput: 0.145, output: 3.48 });
      assert.equal(lookupFireworksPricing("deepseek-pro-latest")?.output, 3.96);
      assert.equal(lookupFireworksPricing("deepseek-pro-latest")?.source, "api");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("prefers deepseek-v4-pro-0813 over deepseek-v4-pro for deepseek-pro-latest", () => {
    setServerlessCatalogSnapshot({
      entries: [
        {
          id: "accounts/fireworks/models/deepseek-v4-pro",
          shortId: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/models/deepseek-v4-pro-0813",
          shortId: "deepseek-v4-pro-0813",
          displayName: "DeepSeek V4 Pro (0813)",
          kind: "serverless",
        },
      ],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveRouterSpecAliasTarget("deepseek-pro-latest"), "deepseek-v4-pro-0813");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("prefers deepseek-v4-flash-0731 over deepseek-v4-flash for deepseek-flash-latest", () => {
    setServerlessCatalogSnapshot({
      entries: [
        {
          id: "accounts/fireworks/models/deepseek-v4-flash",
          shortId: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          kind: "serverless",
        },
        {
          id: "accounts/fireworks/models/deepseek-v4-flash-0731",
          shortId: "deepseek-v4-flash-0731",
          displayName: "DeepSeek V4 Flash (0731)",
          kind: "serverless",
        },
      ],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveRouterSpecAliasTarget("deepseek-flash-latest"), "deepseek-v4-flash-0731");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("ignores standard-tier cache on resolved fast slugs for fast-latest routers", () => {
    setServerlessCatalogSnapshot({
      entries: [
        {
          id: "accounts/fireworks/models/kimi-k3-fast",
          shortId: "kimi-k3-fast",
          displayName: "Kimi K3 Fast",
          kind: "serverless",
        },
      ],
      pricingById: new Map([
        ["accounts/fireworks/models/kimi-k3-fast", {
          slug: "kimi-k3-fast",
          label: "Kimi K3 Fast",
          input: 0.95,
          cachedInput: 0.19,
          output: 4.00,
          tier: "standard",
          source: "https://docs.fireworks.ai/serverless/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k3-fast"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const pricing = lookupFireworksPricing("kimi-fast-latest");
      assert.equal(pricing?.tier, "fast");
      assert.equal(pricing?.input, 6.00);
      assert.equal(pricing?.output, 30.00);
      assert.equal(lookupFireworksModelCost("kimi-fast-latest")?.input, 6.00);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("rejects priority-tier cache for -latest router aliases at lookup", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/routers/kimi-latest",
        shortId: "kimi-latest",
        displayName: "Kimi Latest",
        baseModelId: "accounts/fireworks/models/kimi-k3",
        kind: "serverless",
      }],
      pricingById: new Map([
        ["accounts/fireworks/routers/kimi-latest", {
          slug: "kimi-latest",
          label: "Kimi K3",
          input: 3.75,
          cachedInput: 0.375,
          output: 18.75,
          tier: "priority",
          source: "https://docs.fireworks.ai/serverless/pricing",
        }],
        ["accounts/fireworks/models/kimi-k3", {
          slug: "kimi-k3",
          label: "Kimi K3",
          input: 3.75,
          cachedInput: 0.375,
          output: 18.75,
          tier: "priority",
          source: "https://docs.fireworks.ai/serverless/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-latest", "accounts/fireworks/models/kimi-k3"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const pricing = lookupFireworksPricing("kimi-latest");
      assert.equal(pricing?.tier, "standard");
      assert.equal(pricing?.input, 3);
      assert.equal(pricing?.output, 15);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("pricingMatchesModelRefTier enforces bidirectional tier expectations", () => {
    const fastPricing = { input: 3, cachedInput: 0.3, output: 15, tier: "fast" };
    const standardPricing = { input: 0.95, cachedInput: 0.19, output: 4, tier: "standard" };
    const priorityPricing = { input: 3.75, cachedInput: 0.375, output: 18.75, tier: "priority" };

    assert.equal(requiresFastTierPricing("kimi-fast-latest"), true);
    assert.equal(requiresFastTierPricing("kimi-k2p6-turbo"), true);
    assert.equal(requiresFastTierPricing("kimi-latest"), false);

    assert.equal(pricingMatchesModelRefTier("kimi-fast-latest", fastPricing), true);
    assert.equal(pricingMatchesModelRefTier("kimi-fast-latest", standardPricing), false);
    assert.equal(pricingMatchesModelRefTier("kimi-latest", fastPricing), false);
    assert.equal(pricingMatchesModelRefTier("kimi-latest", standardPricing), true);
    assert.equal(pricingMatchesModelRefTier("kimi-latest", priorityPricing), false);
    assert.equal(isUsableCachedServerlessPricing("kimi-latest", fastPricing), false);
    assert.equal(isUsableCachedServerlessPricing("kimi-latest", standardPricing), true);
    assert.equal(isUsableCachedServerlessPricing("kimi-latest", priorityPricing), false);
  });

  it("prefers live router base models over static alias slugs when catalog cache is warm", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k2p8-code",
        shortId: "kimi-k2p8-code",
        displayName: "Kimi K2.8 Code",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k2p8-code"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveSpecSlug("kimi-fast-latest"), "kimi-k2p8-code-fast");
      assert.equal(resolveFireworksModelLabel("kimi-fast-latest"), "Kimi K2.8 Code Fast (Latest)");
      assert.equal(lookupModelSpec("kimi-fast-latest")?.label, "Kimi K3 Fast");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("keeps Fast in live labels for known -fast router specs", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/glm-5p2",
        shortId: "glm-5p2",
        displayName: "GLM 5.2",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/glm-5p2-fast", "accounts/fireworks/models/glm-5p2"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveFireworksModelLabel("glm-5p2-fast"), "GLM 5.2 Fast");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("resolves firerouter from the shared model spec like other routers", () => {
    const spec = lookupModelSpec("accounts/fireworks/routers/firerouter");
    assert.equal(spec?.label, "FireRouter");
    assert.equal(spec?.capabilities.vision, true);
    assert.equal(lookupFireworksModelLimits("firerouter").contextWindow, 1_048_575);
  });

  it("shares firerouter spec metadata for firerouter* model ids", () => {
    const spec = lookupModelSpec("firerouter/x");
    assert.equal(spec?.label, "FireRouter");
    assert.equal(spec?.capabilities.vision, true);
    const limits = lookupFireworksModelLimits("firerouter/x");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(limits.vision, true);
  });

  it("exposes shared limits and cost helpers", () => {
    const limits = lookupFireworksModelLimits("accounts/fireworks/routers/glm-5p2-fast");
    const cost = lookupFireworksModelCost("accounts/fireworks/routers/glm-5p2-fast");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(cost.input, 2.1);
    assert.equal(cost.output, 6.6);
  });

  it("resolveFireworksCatalog is the canonical merge of limits, cost, and input", () => {
    const catalog = resolveFireworksCatalog("firerouter");
    assert.equal(catalog.limits.contextWindow, 1_048_575);
    assert.equal(catalog.limits.maxTokens, 131_072);
    assert.equal(catalog.limits.vision, true);
    assert.equal(catalog.toolCalling, true);
    assert.deepEqual(catalog.input, ["text", "image"]);
    assert.deepEqual(lookupFireworksModelLimits("firerouter"), catalog.limits);
    assert.deepEqual(lookupFireworksModelCost("firerouter"), catalog.cost);
  });

  it("harness builders consume resolveFireworksCatalog locally", () => {
    const catalog = resolveFireworksCatalog("firerouter");
    const opencode = buildOpencodeModelEntry("firerouter");
    const pi = buildPiCustomFireworksModelEntry("firerouter", "FireRouter");
    const deepseek = buildDeepseekFireworksModelEntry("firerouter", "FireRouter");
    assert.equal(opencode.limit.context, catalog.limits.contextWindow);
    assert.equal(opencode.limit.output, catalog.limits.maxTokens);
    assert.deepEqual(opencode.modalities?.input, catalog.input);
    assert.equal(pi.contextWindow, catalog.limits.contextWindow);
    assert.equal(pi.maxTokens, catalog.limits.maxTokens);
    assert.equal(deepseek.contextWindow, catalog.limits.contextWindow);
    assert.equal(deepseek.maxTokens, catalog.limits.maxTokens);
  });

  it("resolves inkling limits, pricing, and vision from the static spec", () => {
    const limits = lookupFireworksModelLimits("accounts/fireworks/models/inkling");
    const cost = lookupFireworksModelCost("inkling");
    assert.equal(limits.contextWindow, 1_048_576);
    assert.equal(limits.maxTokens, 131_072);
    assert.equal(limits.vision, true);
    assert.equal(cost.input, 1.00);
    assert.equal(cost.output, 4.05);
    assert.equal(lookupModelSpec("inkling")?.label, "Inkling");
    assert.equal(lookupModelSpec("inkling")?.modelsDev, false);
    assert.equal(assumedModelsDevListed("inkling"), false);
    assert.equal(assumedModelsDevListed("glm-5p2"), true);
  });

  it("lookupFireworksModelCost ignores zero-rate cache and falls back to static spec", () => {
    const ref = "accounts/fireworks/routers/glm-5p2-fast";
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map([[ref, {
        slug: "glm-5p2-fast", label: "GLM 5.2 Fast",
        input: 0, cachedInput: 0, output: 0, tier: "fast", source: "",
      }]]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const cost = lookupFireworksModelCost(ref);
      assert.ok(cost.input > 0, "zero-rate cache must not shadow documented static rates");
      assert.equal(cost.input, 2.10);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("resolves short router slugs against the warmed capability cache", () => {
    const canonical = "accounts/fireworks/routers/kimi-fast-latest";
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map(),
      inputModalitiesById: new Map([[canonical, ["text", "image"]]]),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([[canonical, 262_000]]),
      supportsToolsById: new Map([[canonical, true]]),
    });
    try {
      const limits = lookupFireworksModelLimits("kimi-fast-latest");
      assert.equal(limits.contextWindow, 262_000);
      assert.equal(limits.vision, true);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("isFireworksRoutedModelRef resolves specs, routers, and full ids", () => {
    assert.equal(isFireworksRoutedModelRef("deepseek-v4-flash"), true);
    assert.equal(isFireworksRoutedModelRef("deepseek-flash-latest"), true);
    assert.equal(isFireworksRoutedModelRef("deepseek-pro-latest"), true);
    assert.equal(isFireworksRoutedModelRef("kimi-fast-latest"), true);
    assert.equal(isFireworksRoutedModelRef("accounts/fireworks/models/glm-5p2"), true);
    assert.equal(isFireworksRoutedModelRef("firerouter"), true);
    assert.equal(isFireworksRoutedModelRef("claude-sonnet-5"), false);
    assert.equal(isFireworksRoutedModelRef("unknown-user-model"), false);
  });
});
