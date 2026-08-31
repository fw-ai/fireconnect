import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPiCustomFireworksModelEntry,
  cachedFireworksModelIds,
  managedPiFireworksModelIds,
  mergePiFireworksRouterModels,
  ONE_MILLION_CONTEXT,
  piEnabledModels,
  resolvePiEffectiveFireworksModel,
} from "../../../lib/harnesses/pi/fireworks-models.mjs";
import {
  FIREROUTER_ROUTER_ID,
  fullFireworksResourceId,
  shortFireworksModelRef,
} from "../../../lib/fireworks/model-id.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

const GLM_5P2_FAST = "accounts/fireworks/routers/glm-5p2-fast";
const GLM_LATEST = "accounts/fireworks/routers/glm-latest";
const GLM_FAST_LATEST = "accounts/fireworks/routers/glm-fast-latest";
const KIMI_LATEST = "accounts/fireworks/routers/kimi-latest";
const KIMI_K2P6_FAST = "accounts/fireworks/routers/kimi-k2p6-fast";

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
    // ...and the current catalog is registered (canonical ids override Pi built-ins).
    assert.ok(modelIds.includes(GLM_FAST_LATEST));
    assert.ok(modelIds.includes(GLM_LATEST));
  });

  it("keeps existing models when offline (empty catalog) so the picker isn't wiped", () => {
    // Hermetic: no cached catalog — the offline fallback reads the serverless
    // cache, so clear any snapshot a prior test left behind.
    setServerlessCatalogSnapshot(null);
    const config = {
      providers: { fireworks: { models: [{ id: GLM_LATEST, name: "GLM Latest" }] } },
    };
    // No catalog ids and no cached snapshot (offline) → merge keeps the existing
    // entry rather than dropping it (only the active model is re-registered).
    const merged = mergePiFireworksRouterModels(config, GLM_FAST_LATEST, {}, [], [GLM_LATEST]);
    const modelIds = (merged.providers.fireworks.models ?? []).map((m) => m.id);
    assert.ok(modelIds.includes(GLM_LATEST), "existing full-id entry survives offline");
  });

  it("firepass re-on drops metered cost inherited from a previous row", () => {
    setServerlessCatalogSnapshot(null);
    // A prior (standard-key) run registered glm-latest WITH a cost block.
    const config = {
      providers: {
        fireworks: {
          models: [{
            id: "accounts/fireworks/routers/glm-latest",
            name: "GLM Latest",
            cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
          }],
        },
      },
    };
    // Fire Pass is a subscription: re-registering glm-latest (the active model,
    // which has a previous row with cost) must not inherit that metered cost.
    const merged = mergePiFireworksRouterModels(config, GLM_LATEST, {}, [], [], {
      firepass: true,
    });
    const entry = (merged.providers.fireworks.models ?? []).find(
      (model) => shortFireworksModelRef(model.id) === shortFireworksModelRef(GLM_LATEST),
    );
    assert.ok(entry, "glm-latest re-registered");
    assert.equal(entry.cost, undefined, "firepass row carries no metered cost");
    assert.equal(entry.contextWindow, 1_048_576, "limits still resolved");
  });

  it("uses live catalog labels for -latest router picker names", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/routers/glm-fast-latest",
        shortId: "glm-fast-latest",
        displayName: "GLM 5.2 Fast (Latest)",
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
      // Offline (empty catalogModelIds): registration is driven by the cached
      // snapshot, and the picker name comes from the cached entry's displayName.
      assert.deepEqual(cachedFireworksModelIds(), [
        "accounts/fireworks/routers/glm-fast-latest",
      ]);
      const merged = mergePiFireworksRouterModels({}, GLM_FAST_LATEST, {}, [], []);
      const entry = (merged.providers.fireworks.models ?? []).find(
        (m) => m.id === GLM_FAST_LATEST,
      );
      assert.equal(entry?.name, "GLM 5.2 Fast (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes complete canonical-id rows for Pi catalog routers", () => {
    const merged = mergePiFireworksRouterModels({}, GLM_5P2_FAST);
    const fireworks = merged.providers.fireworks;
    const entry = fireworks.models.find((model) => model.id === GLM_5P2_FAST);

    assert.equal(entry.name, "GLM 5.2 Fast");
    assert.equal(entry.reasoning, true);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.deepEqual(entry.input, ["text"]);
    assert.equal(entry.cost.input, 2.1);
    assert.equal(fireworks.modelOverrides?.[GLM_5P2_FAST], undefined);
  });

  it("registers non-catalog routers in models with full context and pricing", () => {
    const merged = mergePiFireworksRouterModels({}, GLM_LATEST);
    const entry = merged.providers.fireworks.models.find((model) => model.id === GLM_LATEST);

    assert.ok(entry);
    assert.equal(entry.contextWindow, 1_048_576);
    assert.equal(entry.cost.input, 1.4);
    assert.equal(entry.cost.output, 4.4);
    assert.equal(merged.providers.fireworks.modelOverrides?.[GLM_LATEST], undefined);
  });

  it("rebuilds a stale canonical catalog row into a complete canonical row", () => {
    const merged = mergePiFireworksRouterModels({
      providers: {
        fireworks: {
          models: [{ id: GLM_5P2_FAST, name: "stale", reasoning: true, contextWindow: 128_000 }],
        },
      },
    }, GLM_5P2_FAST);

    const fireworks = merged.providers.fireworks;
    const entry = fireworks.models.find((model) => model.id === GLM_5P2_FAST);
    assert.ok(entry, "canonical row present (overridden in place)");
    assert.equal(entry.name, "GLM 5.2 Fast");
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(fireworks.modelOverrides?.[GLM_5P2_FAST], undefined);
  });

  it("registers a complete canonical-id row for a selected built-in direct model", () => {
    const modelId = "accounts/fireworks/models/glm-5p2";
    const merged = mergePiFireworksRouterModels({}, modelId);
    const fireworks = merged.providers.fireworks;
    const entry = fireworks.models.find((model) => model.id === modelId);

    assert.ok(entry);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.cost.input, 1.4);
    assert.equal(entry.id, modelId);
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

  it("does not collapse catalog kimi-k2p6-fast to the 128K default", () => {
    const effective = effectiveAfterMerge(KIMI_K2P6_FAST, KIMI_K2P6_FAST);
    assert.ok(effective);
    assert.equal(effective.contextWindow, 262_000);
    assert.equal(effective.cost.input, 2);
  });

  it("gives non-catalog kimi-latest 1M context from shared limits, not 128K", () => {
    const effective = effectiveAfterMerge(KIMI_LATEST, KIMI_LATEST);
    assert.ok(effective);
    assert.equal(effective.contextWindow, 1_040_000);
    assert.equal(effective.cost.input, 3);
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
    assert.equal(entry.id, GLM_LATEST);
    assert.equal(entry.contextWindow, 1_048_576);
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

  it("registers a selected auto model with its spec limits", () => {
    const entry = buildPiCustomFireworksModelEntry("auto", "Auto");
    assert.equal(entry.id, "auto");
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.maxTokens, 131_072);

    const merged = mergePiFireworksRouterModels({}, "auto", {}, [
      "accounts/fireworks/routers/glm-latest",
    ]);
    const ids = merged.providers.fireworks.models.map((model) => model.id);
    assert.ok(ids.includes("auto"), "active auto model registered");
    assert.ok(
      piEnabledModels("auto").includes("fireworks/auto"),
      "and enabled, so Pi doesn't swap in its own default",
    );
  });

  it("registers a selected auto-* model with shared spec limits and keeps the slug", () => {
    const entry = buildPiCustomFireworksModelEntry("auto-instant", "Auto Instant");
    assert.equal(entry.id, "auto-instant");
    assert.deepEqual(entry.input, ["text", "image"]);
    assert.equal(entry.contextWindow, 1_048_575);

    const merged = mergePiFireworksRouterModels({}, "auto-instant", {}, [
      "accounts/fireworks/routers/glm-latest",
    ]);
    const ids = merged.providers.fireworks.models.map((model) => model.id);
    assert.ok(ids.includes("auto-instant"), "active auto-instant model registered");
  });

  it("registers the router catalog alongside a selected firerouter* model", () => {
    // firerouter-selected now registers the full router catalog (not just
    // firerouter) so every router stays pickable in Pi's UI. The active
    // firerouter* gateway pattern is included too.
    const merged = mergePiFireworksRouterModels({}, "firerouter/x", {}, [
      "accounts/fireworks/routers/glm-latest",
    ]);
    const ids = merged.providers.fireworks.models.map((model) => model.id);
    assert.ok(ids.includes("firerouter/x"), "active firerouter* model registered");
    assert.ok(ids.includes("accounts/fireworks/routers/glm-latest"), "router catalog registered");
    const fr = merged.providers.fireworks.models.find((m) => m.id === "firerouter/x");
    assert.equal(fr.contextWindow, 1_048_575);
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

describe("fullFireworksResourceId router classification", () => {
  // Regression: router slugs not in a hand-maintained list (e.g. kimi-k3-fast,
  // any new *-fast/*-latest/*-turbo) must still expand to routers/, not models/.
  // A mis-expanded active model failed to match its catalog row in
  // mergePiFireworksRouterModels, yielding a duplicate models[] entry.
  it("expands router-suffixed slugs to routers/ even when not in a static list", () => {
    assert.equal(
      fullFireworksResourceId("kimi-k3-fast"),
      "accounts/fireworks/routers/kimi-k3-fast",
    );
    assert.equal(
      fullFireworksResourceId("glm-5p2-fast"),
      "accounts/fireworks/routers/glm-5p2-fast",
    );
    assert.equal(
      fullFireworksResourceId("deepseek-v4-flash"),
      "accounts/fireworks/models/deepseek-v4-flash",
    );
  });

  it("expands documented US-only slugs to routers/", () => {
    assert.equal(
      fullFireworksResourceId("kimi-k3-us"),
      "accounts/fireworks/routers/kimi-k3-us",
    );
    assert.equal(
      fullFireworksResourceId("glm-5p2-fast-us"),
      "accounts/fireworks/routers/glm-5p2-fast-us",
    );
    assert.equal(
      fullFireworksResourceId("glm-5p3-flash-us"),
      "accounts/fireworks/routers/glm-5p3-flash-us",
    );
  });

  it("classifies firerouter* variants as routers, not just the bare firerouter slug", () => {
    assert.equal(
      fullFireworksResourceId("firerouter"),
      "accounts/fireworks/routers/firerouter",
    );
    assert.equal(
      fullFireworksResourceId("firerouter-1m"),
      "accounts/fireworks/routers/firerouter-1m",
    );
    assert.equal(
      fullFireworksResourceId("firerouter-fast-latest"),
      "accounts/fireworks/routers/firerouter-fast-latest",
    );
    // A slash-bearing firerouter gateway pattern passes through unchanged and is
    // handled by isFirerouterModelPattern at the spec layer.
    assert.equal(fullFireworksResourceId("firerouter/x"), "firerouter/x");
  });

  it("leaves the auto model id unexpanded (no accounts/fireworks path exists)", () => {
    assert.equal(fullFireworksResourceId("auto"), "auto");
    assert.equal(fullFireworksResourceId("Auto"), "auto");
    assert.equal(fullFireworksResourceId("auto[1m]"), "auto");
    assert.equal(fullFireworksResourceId("auto-instant"), "auto-instant");
  });

  it("registers a router-slug active model as a single canonical row (no duplicate)", () => {
    setServerlessCatalogSnapshot(null);
    try {
      // kimi-k3-fast is a real router but absent from the static short-id list,
      // so it previously expanded to models/kimi-k3-fast and duplicated its own
      // routers/kimi-k3-fast catalog row.
      const merged = mergePiFireworksRouterModels({}, "kimi-k3-fast");
      const ids = (merged.providers.fireworks.models ?? []).map((m) => m.id);
      const canonical = ids.filter(
        (id) => shortFireworksModelRef(id) === "kimi-k3-fast",
      );
      assert.equal(canonical.length, 1, "no duplicate rows for the active router");
      assert.equal(canonical[0], "accounts/fireworks/routers/kimi-k3-fast");
      // managed ids are the canonical router id, not a models/ path.
      assert.deepEqual(
        managedPiFireworksModelIds("kimi-k3-fast", []),
        ["accounts/fireworks/routers/kimi-k3-fast"],
      );
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("registers only router aliases + firerouter from the catalog, not concrete models", () => {
    setServerlessCatalogSnapshot(null);
    try {
      // A mixed registerable catalog: router aliases, a concrete model
      // (gpt-oss-120b), and firerouter. Only the router entries should register.
      const catalog = [
        "accounts/fireworks/routers/firerouter",
        "accounts/fireworks/routers/glm-fast-latest",
        "accounts/fireworks/routers/kimi-fast-latest",
        "accounts/fireworks/models/gpt-oss-120b",
        "accounts/fireworks/models/deepseek-v4-flash",
      ];
      const merged = mergePiFireworksRouterModels({}, "kimi-fast-latest", {}, catalog);
      const ids = (merged.providers.fireworks.models ?? []).map((m) => m.id);
      // Routers are registered…
      assert.ok(ids.includes("accounts/fireworks/routers/firerouter"));
      assert.ok(ids.includes("accounts/fireworks/routers/glm-fast-latest"));
      assert.ok(ids.includes("accounts/fireworks/routers/kimi-fast-latest"));
      // …concrete catalog models are NOT.
      assert.equal(ids.includes("accounts/fireworks/models/gpt-oss-120b"), false);
      assert.equal(ids.includes("accounts/fireworks/models/deepseek-v4-flash"), false);
      // managed ids are routers only.
      const managed = managedPiFireworksModelIds("kimi-fast-latest", catalog);
      assert.equal(managed.some((id) => id.includes("/models/")), false);
      assert.ok(managed.includes("accounts/fireworks/routers/firerouter"));
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("piEnabledModels scopes the picker and still enables an off-scope active model", () => {
    // Pi substitutes its own (long-dead) built-in default for any defaultModel
    // outside enabledModels, so the active model must join the scope.
    assert.deepEqual(
      piEnabledModels("accounts/fireworks/routers/glm-latest"),
      ["fireworks/accounts/fireworks/routers/*"],
    );
    assert.deepEqual(
      piEnabledModels("auto"),
      ["fireworks/accounts/fireworks/routers/*", "fireworks/auto"],
    );
    assert.deepEqual(
      piEnabledModels("glm-5p2"),
      [
        "fireworks/accounts/fireworks/routers/*",
        "fireworks/accounts/fireworks/models/glm-5p2",
      ],
    );
    assert.deepEqual(
      piEnabledModels("accounts/me/deployments/abc"),
      ["fireworks/accounts/fireworks/routers/*", "fireworks/accounts/me/deployments/abc"],
    );
    assert.deepEqual(piEnabledModels(""), ["fireworks/accounts/fireworks/routers/*"]);
  });

  it("registers a concrete --model selection even though it's hidden from the picker", () => {
    setServerlessCatalogSnapshot(null);
    try {
      // A concrete direct model selected via --model must still register so Pi can
      // use it as defaultModel, even though the picker scope (enabledModels) hides it.
      const catalog = ["accounts/fireworks/routers/glm-fast-latest"];
      const merged = mergePiFireworksRouterModels(
        {},
        "accounts/fireworks/models/deepseek-v4-flash",
        {},
        catalog,
      );
      const ids = (merged.providers.fireworks.models ?? []).map((m) => m.id);
      assert.ok(
        ids.includes("accounts/fireworks/models/deepseek-v4-flash"),
        "concrete active model registered",
      );
      // Routers from the catalog still register too.
      assert.ok(ids.includes("accounts/fireworks/routers/glm-fast-latest"));
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });
});
