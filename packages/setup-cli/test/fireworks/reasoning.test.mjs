import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_REASONING_EFFORTS,
  MODEL_REASONING,
  REASONING_DESCRIPTIONS,
  reasoningConfigFor,
  reasoningEffortNamesFor,
} from "../../lib/fireworks/reasoning.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";

describe("fireworks-reasoning", () => {
  it("exposes the full effort vocabulary in picker order", () => {
    assert.deepEqual([...ALL_REASONING_EFFORTS], ["low", "medium", "high", "max"]);
    for (const effort of ALL_REASONING_EFFORTS) {
      assert.equal(typeof REASONING_DESCRIPTIONS[effort], "string");
    }
  });

  it("advertises max for GLM and DeepSeek, standard ladder elsewhere", () => {
    for (const slug of ["glm-5p2", "glm-5p3", "glm-5p3-fast", "glm-5p3-flash", "deepseek-v4-flash", "deepseek-v4-pro"]) {
      const config = MODEL_REASONING[`accounts/fireworks/models/${slug}`];
      assert.deepEqual(config.levels.map((level) => level.effort), ["low", "medium", "high", "max"], slug);
      assert.equal(config.default, "high", slug);
    }
    assert.deepEqual(
      MODEL_REASONING["accounts/fireworks/models/kimi-k3"].levels.map((level) => level.effort),
      ["low", "medium", "high"],
    );
  });

  it("resolves exact refs and falls back to the default ladder", () => {
    assert.deepEqual(reasoningEffortNamesFor("accounts/fireworks/models/glm-5p3"), ["low", "medium", "high", "max"]);
    assert.deepEqual(reasoningEffortNamesFor("accounts/fireworks/models/unknown-model"), ["low", "medium", "high"]);
  });

  it("resolves versioned slugs to their unversioned base", () => {
    assert.deepEqual(
      reasoningEffortNamesFor("accounts/fireworks/models/deepseek-v4-flash-0731"),
      ["low", "medium", "high", "max"],
    );
  });

  it("inherits the ladder from the live router base-model mapping", () => {
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/glm-5p3-flash-us", "accounts/fireworks/models/glm-5p3-flash"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(reasoningConfigFor("accounts/fireworks/routers/glm-5p3-flash-us").default, "high");
      assert.deepEqual(
        reasoningEffortNamesFor("accounts/fireworks/routers/glm-5p3-flash-us"),
        ["low", "medium", "high", "max"],
      );
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });
});
