import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VSCODE_MODEL_METADATA,
  FIREWORKS_MODEL_SPECS,
  lookupFireworksModelCost,
  lookupFireworksModelLimits,
  lookupModelSpec,
  lookupVscodeModelMetadata,
  resolveFireworksModelLabel,
  resolveRouterSpecAliasTarget,
  resolveSpecSlug,
  isFireworksRoutedModelRef,
} from "../../lib/fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../lib/fireworks/pricing.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { PI_BUILTIN_FIREWORKS_CATALOG } from "../../lib/harnesses/pi/fireworks-models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";

describe("fireworks-model-specs", () => {
  it("every priced model has vscode metadata", () => {
    for (const [slug, spec] of Object.entries(FIREWORKS_MODEL_SPECS)) {
      if (!spec.pricing) {
        continue;
      }
      assert.ok(spec.vscode, `missing vscode metadata for ${slug}`);
      assert.equal(typeof spec.vscode.maxInputTokens, "number");
      assert.equal(typeof spec.vscode.maxOutputTokens, "number");
      assert.equal(typeof spec.vscode.vision, "boolean");
      assert.equal(typeof spec.vscode.toolCalling, "boolean");
    }
  });

  it("resolves router aliases for pricing and vscode metadata", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/glm-latest");
    const vscode = lookupVscodeModelMetadata("accounts/fireworks/routers/glm-latest");
    const limits = lookupFireworksModelLimits("accounts/fireworks/routers/glm-latest");
    assert.equal(pricing?.slug, "glm-5p2");
    assert.equal(vscode.maxInputTokens, limits.contextWindow);
    assert.equal(vscode.maxOutputTokens, limits.maxTokens);
    assert.equal(limits.contextWindow, 1_048_575);
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
      assert.equal(spec?.pricing?.input, 1.90);
      assert.equal(lookupFireworksPricing("kimi-fast-latest")?.output, 8.00);
      assert.equal(lookupFireworksModelCost("kimi-fast-latest")?.input, 1.90);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("falls back to static kimi-k2p7 fast pricing when Kimi K3 is listed without API rates", () => {
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
      assert.equal(pricing?.input, 1.90);
      assert.equal(pricing?.output, 8.00);
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
      assert.equal(pricing?.input, 1.90);
      assert.equal(pricing?.output, 8.00);
      assert.equal(lookupFireworksModelCost("kimi-fast-latest")?.input, 1.90);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
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
      assert.equal(lookupModelSpec("kimi-fast-latest")?.label, "Kimi K2.7 Code Fast");
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
    assert.equal(spec?.vscode.vision, true);
    assert.equal(lookupVscodeModelMetadata("firerouter").maxInputTokens, 1_048_575);
  });

  it("exposes shared limits and cost helpers for non-VS Code harnesses", () => {
    const limits = lookupFireworksModelLimits("accounts/fireworks/routers/glm-5p2-fast");
    const cost = lookupFireworksModelCost("accounts/fireworks/routers/glm-5p2-fast");
    assert.equal(limits.contextWindow, 1_048_575);
    assert.equal(cost.input, 2.1);
    assert.equal(cost.output, 6.6);
  });

  it("matches Pi built-in catalog limits for shared models", () => {
    for (const [modelId, catalog] of Object.entries(PI_BUILTIN_FIREWORKS_CATALOG)) {
      const limits = lookupFireworksModelLimits(modelId);
      assert.equal(limits.contextWindow, catalog.contextWindow, modelId);
      assert.equal(limits.maxTokens, catalog.maxTokens, modelId);
    }
  });

  it("resolves kimi vision models with image input enabled", () => {
    const vscode = lookupVscodeModelMetadata("accounts/fireworks/routers/kimi-latest");
    assert.equal(vscode.vision, true);
    assert.equal(vscode.toolCalling, true);
  });

  it("enables vision for firerouter across shared metadata helpers", () => {
    for (const modelRef of [
      "accounts/fireworks/routers/firerouter",
      "firerouter",
      "accounts/fireworks/routers/firerouter[1m]",
    ]) {
      const vscode = lookupVscodeModelMetadata(modelRef);
      const limits = lookupFireworksModelLimits(modelRef);
      assert.equal(vscode.vision, true, modelRef);
      assert.equal(limits.vision, true, modelRef);
      assert.equal(vscode.maxInputTokens, 1_048_575, modelRef);
      assert.equal(vscode.maxOutputTokens, 131_072, modelRef);
      assert.equal(limits.contextWindow, 1_048_575, modelRef);
      assert.equal(limits.maxTokens, 131_072, modelRef);
    }
  });

  it("marks gpt-oss-20b as non-tool-calling", () => {
    const vscode = lookupVscodeModelMetadata("accounts/fireworks/models/gpt-oss-20b");
    assert.equal(vscode.toolCalling, false);
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

  it("warm cache without an API tool signal does not flip static toolCalling:false", () => {
    // gpt-oss-20b has a static spec with toolCalling:false. The serverless API
    // omits supports_tools for it, which must NOT be cached as `true`.
    const snapshot = buildServerlessCatalogSnapshot([{
      name: "accounts/fireworks/models/gpt-oss-20b",
      displayName: "GPT-OSS 20B",
      contextLength: 131_072,
      serverlessModes: [],
    }]);
    setServerlessCatalogSnapshot(snapshot);
    try {
      const meta = lookupVscodeModelMetadata("accounts/fireworks/models/gpt-oss-20b");
      assert.equal(meta.toolCalling, false, "omitted API tool signal must not override the static spec");
      // Context still comes from the API cache.
      assert.equal(meta.maxInputTokens, 131_072);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("warm cache without an API modality signal does not flip static vision:true", () => {
    // kimi-k2p7-code's static spec is vision:true. An API entry that omits both
    // input_modalities and supportsImageInput must not be cached as text-only.
    const snapshot = buildServerlessCatalogSnapshot([{
      name: "accounts/fireworks/models/kimi-k2p7-code",
      displayName: "Kimi K2.7 Code",
      contextLength: 262_000,
      serverlessModes: [],
    }]);
    setServerlessCatalogSnapshot(snapshot);
    try {
      const meta = lookupVscodeModelMetadata("accounts/fireworks/models/kimi-k2p7-code");
      assert.equal(meta.vision, true, "omitted API modality signal must not override the static spec");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("explicit API supports_tools=false is honored as authoritative", () => {
    const snapshot = buildServerlessCatalogSnapshot([{
      name: "accounts/fireworks/models/some-new-model",
      displayName: "Some New Model",
      contextLength: 131_072,
      supportsTools: false,
      serverlessModes: [],
    }]);
    setServerlessCatalogSnapshot(snapshot);
    try {
      const meta = lookupVscodeModelMetadata("accounts/fireworks/models/some-new-model");
      assert.equal(meta.toolCalling, false);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("falls back to bool defaults for unknown models without token limits", () => {
    assert.deepEqual(
      lookupVscodeModelMetadata("accounts/fireworks/models/unknown-model"),
      DEFAULT_VSCODE_MODEL_METADATA,
    );
    assert.equal(lookupModelSpec("accounts/fireworks/models/unknown-model"), null);
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
      const vscode = lookupVscodeModelMetadata("kimi-fast-latest");
      assert.equal(limits.contextWindow, 262_000);
      assert.equal(limits.vision, true);
      assert.equal(vscode.maxInputTokens, 262_000);
      assert.equal(vscode.vision, true);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("isFireworksRoutedModelRef resolves specs, routers, and full ids", () => {
    assert.equal(isFireworksRoutedModelRef("deepseek-v4-flash"), true);
    assert.equal(isFireworksRoutedModelRef("kimi-fast-latest"), true);
    assert.equal(isFireworksRoutedModelRef("accounts/fireworks/models/glm-5p2"), true);
    assert.equal(isFireworksRoutedModelRef("firerouter"), true);
    assert.equal(isFireworksRoutedModelRef("claude-sonnet-5"), false);
    assert.equal(isFireworksRoutedModelRef("unknown-user-model"), false);
  });
});
