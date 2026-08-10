import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPiCustomFireworksModelEntry,
  mergePiFireworksRouterModels,
  ONE_MILLION_CONTEXT,
  PI_BUILTIN_FIREWORKS_MODEL_IDS,
  piFireworksRouterEntries,
  resolvePiEffectiveFireworksModel,
} from "../../../lib/harnesses/pi/fireworks-models.mjs";
import { FIREROUTER_ROUTER_ID } from "../../../lib/fireworks/model-id.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

const GLM_5P2_FAST = "accounts/fireworks/routers/glm-5p2-fast";
const GLM_LATEST = "accounts/fireworks/routers/glm-latest";
const GLM_FAST_LATEST = "accounts/fireworks/routers/glm-fast-latest";
const KIMI_LATEST = "accounts/fireworks/routers/kimi-latest";
const KIMI_K2P7_FAST = "accounts/fireworks/routers/kimi-k2p7-code-fast";

function effectiveAfterMerge(resolvedModel, modelId) {
  const merged = mergePiFireworksRouterModels({}, resolvedModel);
  return resolvePiEffectiveFireworksModel(merged.providers.fireworks, modelId);
}

describe("mergePiFireworksRouterModels", () => {
  it("rebuilds from the current catalog, dropping stale managed ids but keeping user entries", () => {
    // A prior `on` registered a model that's no longer in the catalog, plus the
    // user has their own custom entry in the provider.
    const userModel = { id: "accounts/fireworks/models/my-private-ft", name: "My FT" };
    const staleId = "accounts/fireworks/models/removed-from-catalog";
    const config = {
      providers: {
        fireworks: {
          models: [userModel, { id: staleId, name: "stale" }],
          modelOverrides: { [GLM_5P2_FAST]: { name: "old override" } },
        },
      },
    };

    const merged = mergePiFireworksRouterModels(
      config,
      GLM_FAST_LATEST,
      {},
      [GLM_FAST_LATEST, GLM_LATEST], // current catalog
      [staleId, GLM_5P2_FAST], // previously-managed ids to drop
    );
    const fireworks = merged.providers.fireworks;
    const modelIds = (fireworks.models ?? []).map((m) => m.id);

    // Stale managed entries are gone from both models[] and modelOverrides...
    assert.equal(modelIds.includes(staleId), false);
    assert.equal(fireworks.modelOverrides?.[GLM_5P2_FAST], undefined);
    // ...the user's own entry survives...
    assert.ok(modelIds.includes(userModel.id));
    // ...and the current catalog is registered.
    assert.ok(modelIds.includes("glm-fast-latest"));
    assert.ok(modelIds.includes("glm-latest"));
  });

  it("keeps existing models when offline (empty catalog) so the picker isn't wiped", () => {
    const config = {
      providers: { fireworks: { models: [{ id: GLM_LATEST, name: "GLM Latest" }] } },
    };
    // No catalog ids (offline) → merge keeps the existing entry rather than dropping it.
    const merged = mergePiFireworksRouterModels(config, GLM_FAST_LATEST, {}, [], [GLM_LATEST]);
    const modelIds = (merged.providers.fireworks.models ?? []).map((m) => m.id);
    assert.ok(modelIds.includes("glm-latest"));
  });

  it("uses live catalog labels for -latest router picker names", () => {
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
        ["accounts/fireworks/routers/glm-fast-latest", "accounts/fireworks/models/glm-5p2"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      const entry = piFireworksRouterEntries().find((row) => row.id.endsWith("glm-fast-latest"));
      assert.equal(entry?.name, "GLM 5.2 Fast (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes complete short-ID rows for Pi catalog routers", () => {
    const merged = mergePiFireworksRouterModels({}, GLM_5P2_FAST);
    const fireworks = merged.providers.fireworks;
    const entry = fireworks.models.find((model) => model.id === "glm-5p2-fast");

    assert.ok(PI_BUILTIN_FIREWORKS_MODEL_IDS.has(GLM_5P2_FAST));
    assert.equal(entry.name, "GLM 5.2 Fast");
    assert.equal(entry.reasoning, true);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.deepEqual(entry.input, ["text"]);
    assert.equal(entry.cost.input, 2.1);
    assert.equal(fireworks.modelOverrides?.[GLM_5P2_FAST], undefined);
  });

  it("registers non-catalog routers in models with full context and pricing", () => {
    const merged = mergePiFireworksRouterModels({}, GLM_LATEST);
    const entry = merged.providers.fireworks.models.find((model) => model.id === "glm-latest");

    assert.ok(entry);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.cost.input, 1.4);
    assert.equal(entry.cost.output, 4.4);
    assert.equal(merged.providers.fireworks.modelOverrides?.[GLM_LATEST], undefined);
  });

  it("migrates a stale canonical catalog row to a complete short-ID row", () => {
    const merged = mergePiFireworksRouterModels({
      providers: {
        fireworks: {
          models: [{ id: GLM_5P2_FAST, name: "stale", reasoning: true, contextWindow: 128_000 }],
        },
      },
    }, GLM_5P2_FAST);

    const fireworks = merged.providers.fireworks;
    assert.equal(fireworks.models?.some((model) => model.id === GLM_5P2_FAST), false);
    const entry = fireworks.models.find((model) => model.id === "glm-5p2-fast");
    assert.equal(entry.name, "GLM 5.2 Fast");
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(fireworks.modelOverrides?.[GLM_5P2_FAST], undefined);
  });

  it("registers a complete short-ID row for a selected built-in direct model", () => {
    const modelId = "accounts/fireworks/models/glm-5p2";
    const merged = mergePiFireworksRouterModels({}, modelId);
    const fireworks = merged.providers.fireworks;
    const entry = fireworks.models.find((model) => model.id === "glm-5p2");

    assert.ok(entry);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.cost.input, 1.4);
    assert.equal(entry.id, "glm-5p2");
    assert.equal(fireworks.modelOverrides?.[modelId], undefined);
  });
});

describe("resolvePiEffectiveFireworksModel", () => {
  it("preserves 1M context for Pi catalog glm-5p2-fast via a complete short row", () => {
    const effective = effectiveAfterMerge(GLM_5P2_FAST, GLM_5P2_FAST);
    assert.ok(effective);
    assert.ok(effective.contextWindow >= ONE_MILLION_CONTEXT);
    assert.equal(effective.cost.input, 2.1);
    assert.notEqual(effective.cost.input, 0);
  });

  it("preserves 1M context for non-catalog glm-latest via custom models entry", () => {
    const effective = effectiveAfterMerge(GLM_LATEST, GLM_LATEST);
    assert.ok(effective);
    assert.ok(effective.contextWindow >= ONE_MILLION_CONTEXT);
    assert.equal(effective.cost.input, 1.4);
  });

  it("preserves 1M context for non-catalog glm-fast-latest via custom models entry", () => {
    const effective = effectiveAfterMerge(GLM_FAST_LATEST, GLM_FAST_LATEST);
    assert.ok(effective);
    assert.ok(effective.contextWindow >= ONE_MILLION_CONTEXT);
    assert.equal(effective.cost.input, 2.1);
  });

  it("does not collapse catalog kimi-k2p7-code-fast to the 128K default", () => {
    const effective = effectiveAfterMerge(KIMI_K2P7_FAST, KIMI_K2P7_FAST);
    assert.ok(effective);
    assert.equal(effective.contextWindow, 262_000);
    assert.equal(effective.cost.input, 1.9);
  });

  it("gives non-catalog kimi-latest 262K context from shared limits, not 128K", () => {
    const effective = effectiveAfterMerge(KIMI_LATEST, KIMI_LATEST);
    assert.ok(effective);
    assert.equal(effective.contextWindow, 262_000);
    assert.equal(effective.cost.input, 0.95);
  });

  it("would regress to 128K if a catalog router were written only to models", () => {
    const stale = {
      models: [{ id: GLM_5P2_FAST, name: "stale", reasoning: true }],
    };
    const effective = resolvePiEffectiveFireworksModel(stale, GLM_5P2_FAST);
    assert.equal(effective.contextWindow, 128_000);
    assert.deepEqual(effective.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("buildPiCustomFireworksModelEntry uses shared limits, not vscode field names", () => {
    const entry = buildPiCustomFireworksModelEntry(GLM_LATEST, "GLM Latest");
    assert.equal(entry.id, "glm-latest");
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.maxTokens, 131_072);
    assert.deepEqual(entry.input, ["text"]);
    assert.equal(entry.cost.output, 4.4);
  });

  it("buildPiCustomFireworksModelEntry enables image input for firerouter", () => {
    const entry = buildPiCustomFireworksModelEntry(
      FIREROUTER_ROUTER_ID,
      "FireRouter",
    );
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.maxTokens, 131_072);
  });

  it("buildPiCustomFireworksModelEntry shares firerouter limits for firerouter* ids", () => {
    const entry = buildPiCustomFireworksModelEntry("firerouter/x", "X");
    assert.equal(entry.id, "firerouter/x");
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.maxTokens, 131_072);
  });

  it("registers only the selected firerouter* model", () => {
    const merged = mergePiFireworksRouterModels({}, "firerouter/x", {}, [
      "accounts/fireworks/routers/glm-latest",
    ]);
    const ids = merged.providers.fireworks.models.map((model) => model.id);
    assert.deepEqual(ids, ["firerouter/x"]);
    assert.equal(merged.providers.fireworks.models[0].contextWindow, 1_048_575);
  });

  it("registers a custom deployment ID (accounts/<user>/deployments/<id>) in models", () => {
    const deploymentId = "accounts/ahmadshahzad/deployments/ub9lvh50";
    const merged = mergePiFireworksRouterModels({}, deploymentId);
    const entry = merged.providers.fireworks.models.find((model) => model.id === deploymentId);

    assert.ok(entry, "custom deployment should be registered in models[]");
    assert.equal(entry.id, deploymentId);
    // Graceful defaults from lookupFireworksModelLimits when the ID isn't in specs.
    assert.equal(entry.contextWindow, 128_000);
    assert.equal(entry.maxTokens, 16_384);
    assert.equal(entry.cost, undefined);
    // Not in modelOverrides (it's not a Pi built-in).
    assert.equal(merged.providers.fireworks.modelOverrides?.[deploymentId], undefined);
  });

  it("resolvePiEffectiveFireworksModel resolves a custom deployment with defaults", () => {
    const deploymentId = "accounts/ahmadshahzad/deployments/ub9lvh50";
    const effective = effectiveAfterMerge(deploymentId, deploymentId);
    assert.ok(effective);
    assert.equal(effective.contextWindow, 128_000);
  });
});
