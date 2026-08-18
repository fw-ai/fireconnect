import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexCatalog,
  buildCodexCatalogFromSnapshot,
  buildCodexCatalogEntry,
  buildCodexCatalogEntryForRouter,
  CODEX_CONSTANT_FIELDS,
  CODEX_MINIMAX_UNSUPPORTED_NOTE,
  codexCatalogContainsModel,
  codexModelExclusionReason,
  DEPRECATED_MODELS,
  ensureCodexFirerouterPatternEntry,
  filterPickerCatalogForCodex,
  MODEL_OVERRIDES,
  MODEL_REASONING,
  REASONING_DESCRIPTIONS,
} from "../../../lib/harnesses/codex/catalog.mjs";
import {
  buildServerlessCatalogSnapshot,
  firerouterCatalogEntry,
} from "../../../lib/fireworks/models.mjs";
import { mockServerlessModel } from "../../helpers.mjs";

function mockModel(overrides = {}) {
  return mockServerlessModel({
    name: "accounts/fireworks/models/glm-5p2",
    displayName: "GLM 5.2",
    description: "GLM 5.2 is a great model.",
    contextLength: 1048576,
    supportsImageInput: false,
    supportsTools: true,
    kind: "CHAT_COMPLETION_MODEL",
    baseModelDetails: { modelType: "glm_moe_dsa" },
    ...overrides,
  });
}

describe("codex-catalog buildCodexCatalogEntry", () => {
  it("maps fields correctly from a mock API model", () => {
    const entry = buildCodexCatalogEntry(mockModel());
    assert.equal(entry.slug, "glm-5p2");
    assert.equal(entry.display_name, "GLM 5.2");
    assert.equal(entry.context_window, 1048576);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal(entry.auto_compact_token_limit, null);
    assert.deepEqual(entry.input_modalities, ["text"]);
    assert.equal(entry.supports_parallel_tool_calls, true);
    assert.equal(entry.reasoning_summary_format, "experimental");
    assert.equal(entry.web_search_tool_type, "text");
    assert.equal(entry.supports_image_detail_original, false);
    assert.equal(entry.description, "GLM 5.2 is a great model.");
    for (const [key, value] of Object.entries(CODEX_CONSTANT_FIELDS)) {
      assert.deepEqual(entry[key], value, `expected CODEX_CONSTANT_FIELDS.${key}`);
    }
  });

  it("applies MODEL_OVERRIDES for qwen3p7-plus", () => {
    const model = mockModel({
      name: "accounts/fireworks/models/qwen3p7-plus",
      displayName: "Qwen3.7 Plus",
      contextLength: 0,
      supportsImageInput: false,
    });
    const entry = buildCodexCatalogEntry(model);
    assert.equal(entry.context_window, MODEL_OVERRIDES["accounts/fireworks/models/qwen3p7-plus"].contextLength);
    assert.equal(entry.context_window, 262144);
    assert.equal(entry.max_context_window, 262144);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
  });

  for (const [modelName, defaultLevel, efforts, summaryFormat] of [
    ["accounts/fireworks/models/glm-5p2", "max", ["high", "max"], "experimental"],
    ["accounts/fireworks/models/minimax-m2p7", "medium", ["low", "medium", "high"], "experimental"],
  ]) {
    it(`uses correct reasoning config for ${modelName.split("/").pop()}`, () => {
      const entry = buildCodexCatalogEntry(mockModel({ name: modelName }));
      assert.equal(entry.default_reasoning_level, defaultLevel);
      assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), efforts);
      assert.equal(entry.reasoning_summary_format, summaryFormat);
    });
  }

  it("builds input_modalities with image when supportsImageInput is true", () => {
    const entry = buildCodexCatalogEntry(mockModel({ supportsImageInput: true }));
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.web_search_tool_type, "text_and_image");
    assert.equal(entry.supports_image_detail_original, true);
  });

  it("uses default reasoning config for an unknown model", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/unknown-model" }));
    assert.equal(entry.default_reasoning_level, "high");
    assert.deepEqual(entry.supported_reasoning_levels.map((level) => level.effort), ["high"]);
    assert.equal(entry.reasoning_summary_format, "none");
  });
});

describe("codex-catalog buildCodexCatalogEntryForRouter", () => {
  it("overrides slug and display_name while inheriting base metadata", () => {
    const base = mockModel({ name: "accounts/fireworks/models/glm-5p2", contextLength: 1048576 });
    const entry = buildCodexCatalogEntryForRouter(
      "accounts/fireworks/routers/glm-latest",
      base,
      "GLM Latest",
    );
    assert.equal(entry.slug, "glm-latest");
    assert.equal(entry.display_name, "GLM Latest");
    assert.equal(entry.context_window, 1048576);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal(entry.auto_compact_token_limit, null);
  });
});

describe("codex-catalog buildCodexCatalog", () => {
  it("builds standalone firerouter metadata when explicitly included", () => {
    const snapshot = buildServerlessCatalogSnapshot([]);
    snapshot.entries = [firerouterCatalogEntry()];
    const catalog = buildCodexCatalogFromSnapshot(snapshot, []);
    assert.equal(catalog.models[0].slug, "firerouter");
    assert.equal(
      catalog.models[0].description,
      "Picks a model for each request based on the task.",
    );
    assert.equal(catalog.models[0].context_window, 1_048_575);
    assert.equal(catalog.models[0].supports_parallel_tool_calls, true);
    assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
    assert.equal(catalog.models[0].supports_image_detail_original, true);
  });

  it("dynamically adds firerouter* entries with shared FireRouter metadata", () => {
    const base = buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot([]), []);
    const catalog = ensureCodexFirerouterPatternEntry(base, "firerouter/x");
    const entry = catalog.models.find((model) => model.slug === "firerouter/x");
    assert.ok(entry);
    assert.equal(entry.context_window, 1_048_575);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.supports_parallel_tool_calls, true);
    assert.equal(
      entry.description,
      "Picks a model for each request based on the task.",
    );
    assert.equal(codexCatalogContainsModel(catalog, "firerouter/x"), true);
    assert.equal(
      ensureCodexFirerouterPatternEntry(catalog, "firerouter/x"),
      catalog,
      "idempotent when already present",
    );
  });

  it("filters out deprecated models", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/glm-5p1" }),
      mockModel({ name: "accounts/fireworks/models/kimi-k2p5" }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(!slugs.includes("glm-5p1"));
    assert.ok(!slugs.includes("kimi-k2p5"));
    assert.ok(slugs.includes("glm-5p2"));
  });

  it("filters out minimax models and minimax-latest router", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/minimax-m2p5" }),
      mockModel({ name: "accounts/fireworks/models/minimax-m2p7" }),
      mockModel({
        name: "accounts/fireworks/models/minimax-m3",
        displayName: "MiniMax M3",
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("glm-5p2"));
    assert.ok(!slugs.includes("minimax-m2p5"));
    assert.ok(!slugs.includes("minimax-m2p7"));
    assert.ok(!slugs.includes("minimax-m3"));
    assert.ok(!slugs.includes("minimax-latest"));
  });

  it("documents why MiniMax is excluded from Codex", () => {
    assert.equal(codexModelExclusionReason("minimax-m3"), CODEX_MINIMAX_UNSUPPORTED_NOTE);
    assert.equal(codexModelExclusionReason("accounts/fireworks/routers/minimax-latest"), CODEX_MINIMAX_UNSUPPORTED_NOTE);
    assert.equal(codexModelExclusionReason("glm-5p2"), "");
  });

  it("filters out embedding, flux, no-tools, and zero-context models", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/embedding-x", kind: "EMBEDDING_MODEL" }),
      mockModel({ name: "accounts/fireworks/models/flux-x", kind: "FLUMINA_BASE_MODEL" }),
      mockModel({ name: "accounts/fireworks/models/no-tools", supportsTools: false }),
      mockModel({ name: "accounts/fireworks/models/zero-ctx", contextLength: 0 }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("glm-5p2"));
    assert.ok(!slugs.includes("embedding-x"));
    assert.ok(!slugs.includes("flux-x"));
    assert.ok(!slugs.includes("no-tools"));
    assert.ok(!slugs.includes("zero-ctx"));
  });

  it("includes router entries from usage_identifier when base models are present", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({
        name: "accounts/fireworks/models/kimi-k2p7-code",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/default",
            skuInfos: [],
          },
          {
            name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-fast-latest",
            skuInfos: [],
          },
        ],
      }),
    ]);
    const routerSlugs = catalog.models.map((entry) => entry.slug);
    assert.ok(routerSlugs.includes("glm-5p2-fast"));
    assert.ok(routerSlugs.includes("kimi-fast-latest"));
    const glmFast = catalog.models.find((entry) => entry.slug === "glm-5p2-fast");
    assert.equal(glmFast.context_window, 1048576);
    assert.equal(glmFast.display_name, "GLM 5.2 Fast");
  });

  it("synthesizes kimi-latest when API exposes kimi-k2p7-code", () => {
    const catalog = buildCodexCatalog([
      mockModel({
        name: "accounts/fireworks/models/kimi-k2p7-code",
        displayName: "Kimi K2.7 Code",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/default",
            skuInfos: [],
          },
          {
            name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-fast-latest",
            skuInfos: [],
          },
        ],
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("kimi-fast-latest"));
    assert.ok(slugs.includes("kimi-latest"));
  });

  it("still synthesizes kimi-fast-latest when API exposes kimi-k3-fast", () => {
    const catalog = buildCodexCatalog([
      mockModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/default",
            skuInfos: [],
          },
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-k3-fast",
            skuInfos: [],
          },
        ],
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("kimi-k3-fast"));
    assert.ok(slugs.includes("kimi-fast-latest"));
  });

  it("skips routers whose base models are missing from the API response", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("glm-5p2-fast"));
    assert.ok(!slugs.includes("kimi-fast-latest"));
  });

  it("qwen3p7-plus is included despite zero API contextLength via overrides", () => {
    const catalog = buildCodexCatalog([
      mockModel({
        name: "accounts/fireworks/models/qwen3p7-plus",
        contextLength: 0,
        supportsImageInput: false,
      }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("qwen3p7-plus"));
    const entry = catalog.models.find((entry) => entry.slug === "qwen3p7-plus");
    assert.equal(entry.context_window, 262144);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
  });

  it("reasoning level descriptions match REASONING_DESCRIPTIONS", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/minimax-m2p7" }));
    for (const level of entry.supported_reasoning_levels) {
      assert.equal(level.description, REASONING_DESCRIPTIONS[level.effort]);
    }
  });

  it("filterPickerCatalogForCodex keeps only picker entries present in codex catalog", () => {
    const codexCatalog = buildCodexCatalog([mockModel()]);
    const pickerCatalog = [
      { id: "accounts/fireworks/models/glm-5p2", shortId: "glm-5p2", displayName: "GLM 5.2", kind: "serverless" },
      { id: "accounts/fireworks/models/unknown-model", shortId: "unknown-model", displayName: "Unknown", kind: "serverless" },
    ];
    const filtered = filterPickerCatalogForCodex(pickerCatalog, codexCatalog);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].shortId, "glm-5p2");
  });

  it("filterPickerCatalogForCodex returns empty when codex catalog has no models", () => {
    const pickerCatalog = [
      { id: "accounts/fireworks/models/glm-5p2", shortId: "glm-5p2", displayName: "GLM 5.2", kind: "serverless" },
    ];
    const filtered = filterPickerCatalogForCodex(pickerCatalog, { models: [] });
    assert.deepEqual(filtered, []);
  });

  it("matches canonical and short model ids against old and new catalog slugs", () => {
    const shortCatalog = { models: [{ slug: "glm-5p2" }] };
    const canonicalCatalog = {
      models: [{ slug: "accounts/fireworks/models/glm-5p2" }],
    };
    assert.equal(
      codexCatalogContainsModel(shortCatalog, "accounts/fireworks/models/glm-5p2"),
      true,
    );
    assert.equal(codexCatalogContainsModel(canonicalCatalog, "glm-5p2"), true);
  });
});

describe("codex-catalog metadata tables", () => {
  it("DEPRECATED_MODELS contains the expected ids", () => {
    assert.ok(DEPRECATED_MODELS.has("accounts/fireworks/models/kimi-k2p5"));
    assert.ok(DEPRECATED_MODELS.has("accounts/fireworks/models/qwen3p6-plus"));
  });

  it("snapshot maps usage_identifier routers to base models", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
    ]);
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/glm-5p2-fast"),
      "accounts/fireworks/models/glm-5p2",
    );
  });

  it("MODEL_REASONING has entries for all documented models", () => {
    const expected = [
      "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/models/deepseek-v4-pro",
      "accounts/fireworks/models/kimi-k2p6",
      "accounts/fireworks/models/kimi-k2p7-code",
      "accounts/fireworks/models/minimax-m2p7",
      "accounts/fireworks/models/minimax-m3",
      "accounts/fireworks/models/gpt-oss-120b",
      "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
      "accounts/fireworks/models/qwen3p7-plus",
    ];
    for (const id of expected) {
      assert.ok(MODEL_REASONING[id], `missing reasoning config for ${id}`);
    }
  });
});
