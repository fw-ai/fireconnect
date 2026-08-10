import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpencodeModelEntry,
  opencodeConfigModelRef,
  opencodeNeedsProviderModelOverride,
} from "../../../lib/harnesses/opencode/core.mjs";
import { lookupFireworksModelLimits } from "../../../lib/fireworks/model-specs.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

describe("opencode model entries", () => {
  it("adds image modalities for kimi latest router aliases", () => {
    for (const modelId of [
      "accounts/fireworks/routers/kimi-latest",
      "accounts/fireworks/routers/kimi-fast-latest",
      "kimi-latest",
      "kimi-fast-latest",
    ]) {
      const entry = buildOpencodeModelEntry(modelId);
      assert.deepEqual(
        entry.modalities,
        { input: ["text", "image"] },
        modelId,
      );
    }
  });

  it("omits modalities for text-only routers", () => {
    const entry = buildOpencodeModelEntry("accounts/fireworks/routers/glm-fast-latest");
    assert.equal(entry.modalities, undefined);
    assert.equal(entry.name, "GLM 5.2 Fast (Latest)");
  });

  it("sets OpenCode limit.context/output for latest router aliases absent from models.dev", () => {
    for (const modelId of [
      "glm-fast-latest",
      "glm-latest",
      "accounts/fireworks/routers/glm-fast-latest",
      "accounts/fireworks/routers/glm-latest",
    ]) {
      const limits = lookupFireworksModelLimits(modelId);
      const entry = buildOpencodeModelEntry(modelId);
      assert.deepEqual(entry.limit, {
        context: limits.contextWindow,
        output: limits.maxTokens,
      }, modelId);
      assert.ok(entry.limit.context >= 1_000_000, modelId);
    }
  });

  it("uses models.dev-compatible full ids for catalog models", () => {
    assert.equal(
      opencodeConfigModelRef("deepseek-v4-flash"),
      "accounts/fireworks/models/deepseek-v4-flash",
    );
    assert.equal(
      opencodeConfigModelRef("accounts/fireworks/routers/glm-5p2-fast"),
      "accounts/fireworks/routers/glm-5p2-fast",
    );
    assert.equal(opencodeConfigModelRef("glm-fast-latest"), "glm-fast-latest");
    assert.equal(opencodeConfigModelRef("kimi-fast-latest"), "kimi-fast-latest");
  });

  it("prefers live catalog labels for latest router overrides", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k3-fast",
        shortId: "kimi-k3-fast",
        displayName: "Kimi K3 Fast",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k3-fast"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const entry = buildOpencodeModelEntry("kimi-fast-latest");
      assert.equal(entry.name, "Kimi K3 Fast (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("adds image modalities for firerouter", () => {
    for (const modelId of [
      "accounts/fireworks/routers/firerouter",
      "firerouter",
      "firerouter/x",
    ]) {
      const entry = buildOpencodeModelEntry(modelId);
      assert.deepEqual(
        entry.modalities,
        { input: ["text", "image"] },
        modelId,
      );
      assert.equal(entry.limit.context, 1_048_575, modelId);
    }
  });

  it("requires a provider override for firerouter* ids", () => {
    assert.equal(opencodeNeedsProviderModelOverride("firerouter/x"), true);
  });

  it("adds image modalities for vision serverless models", () => {
    const entry = buildOpencodeModelEntry("accounts/fireworks/models/kimi-k2p7-code");
    assert.deepEqual(entry.modalities, { input: ["text", "image"] });
    assert.equal(entry.name, "Kimi K2.7 Code");
  });
});
