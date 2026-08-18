import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_DISPLAY_METADATA,
  resolveModelDisplayMetadata,
} from "../../lib/fireworks/model-display.mjs";
import { resolveFireworksCatalog } from "../../lib/fireworks/model-specs.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";

describe("model-display", () => {
  it("maps resolveFireworksCatalog limits to VS Code display fields", () => {
    const meta = resolveModelDisplayMetadata("firerouter");
    const catalog = resolveFireworksCatalog("firerouter");
    assert.equal(meta.maxInputTokens, catalog.limits.contextWindow);
    assert.equal(meta.vision, catalog.limits.vision);
  });

  it("resolves router aliases for display metadata", () => {
    const display = resolveModelDisplayMetadata("accounts/fireworks/routers/glm-latest");
    const catalog = resolveFireworksCatalog("accounts/fireworks/routers/glm-latest");
    assert.equal(display.maxInputTokens, catalog.limits.contextWindow);
    assert.equal(display.maxOutputTokens, catalog.limits.maxTokens);
    assert.equal(catalog.limits.contextWindow, 1_048_575);
  });

  it("resolves kimi vision models with image input enabled", () => {
    const display = resolveModelDisplayMetadata("accounts/fireworks/routers/kimi-latest");
    assert.equal(display.vision, true);
    assert.equal(display.toolCalling, true);
  });

  it("enables vision for firerouter across display metadata", () => {
    for (const modelRef of [
      "accounts/fireworks/routers/firerouter",
      "firerouter",
      "accounts/fireworks/routers/firerouter[1m]",
    ]) {
      const display = resolveModelDisplayMetadata(modelRef);
      const catalog = resolveFireworksCatalog(modelRef);
      assert.equal(display.vision, true, modelRef);
      assert.equal(catalog.limits.vision, true, modelRef);
      assert.equal(display.maxInputTokens, 1_048_575, modelRef);
      assert.equal(display.maxOutputTokens, 131_072, modelRef);
    }
  });

  it("marks gpt-oss-20b as non-tool-calling", () => {
    const display = resolveModelDisplayMetadata("accounts/fireworks/models/gpt-oss-20b");
    assert.equal(display.toolCalling, false);
  });

  it("warm cache without an API tool signal does not flip static toolCalling:false", () => {
    const snapshot = buildServerlessCatalogSnapshot([{
      name: "accounts/fireworks/models/gpt-oss-20b",
      displayName: "GPT-OSS 20B",
      contextLength: 131_072,
      serverlessModes: [],
    }]);
    setServerlessCatalogSnapshot(snapshot);
    try {
      const meta = resolveModelDisplayMetadata("accounts/fireworks/models/gpt-oss-20b");
      assert.equal(meta.toolCalling, false);
      assert.equal(meta.maxInputTokens, 131_072);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("warm cache without an API modality signal does not flip static vision:true", () => {
    const snapshot = buildServerlessCatalogSnapshot([{
      name: "accounts/fireworks/models/kimi-k2p7-code",
      displayName: "Kimi K2.7 Code",
      contextLength: 262_000,
      serverlessModes: [],
    }]);
    setServerlessCatalogSnapshot(snapshot);
    try {
      const meta = resolveModelDisplayMetadata("accounts/fireworks/models/kimi-k2p7-code");
      assert.equal(meta.vision, true);
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
      const meta = resolveModelDisplayMetadata("accounts/fireworks/models/some-new-model");
      assert.equal(meta.toolCalling, false);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("falls back to bool defaults for unknown models without token limits", () => {
    assert.deepEqual(
      resolveModelDisplayMetadata("accounts/fireworks/models/unknown-model"),
      DEFAULT_MODEL_DISPLAY_METADATA,
    );
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
      const display = resolveModelDisplayMetadata("kimi-fast-latest");
      assert.equal(display.maxInputTokens, 262_000);
      assert.equal(display.vision, true);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });
});
