import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexCatalog,
  buildCodexCatalogEntry,
  buildCodexCatalogEntryForRouter,
  CODEX_CONSTANT_FIELDS,
  DEPRECATED_MODELS,
  MODEL_OVERRIDES,
  MODEL_REASONING,
  REASONING_DESCRIPTIONS,
  ROUTER_BASE_MODEL,
} from "../lib/codex-catalog.mjs";

function mockModel(overrides = {}) {
  return {
    name: "accounts/fireworks/models/glm-5p2",
    displayName: "GLM 5.2",
    description: "GLM 5.2 is a great model.",
    contextLength: 1048576,
    supportsImageInput: false,
    supportsTools: true,
    kind: "CHAT_COMPLETION_MODEL",
    baseModelDetails: { modelType: "glm_moe_dsa" },
    ...overrides,
  };
}

describe("codex-catalog buildCodexCatalogEntry", () => {
  it("maps fields correctly from a mock API model", () => {
    const entry = buildCodexCatalogEntry(mockModel());
    assert.equal(entry.slug, "accounts/fireworks/models/glm-5p2");
    assert.equal(entry.display_name, "GLM 5.2");
    assert.equal(entry.context_window, 1048576);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal(entry.auto_compact_token_limit, null);
    assert.deepEqual(entry.input_modalities, ["text"]);
    assert.equal(entry.supports_parallel_tool_calls, true);
    assert.equal(entry.shell_type, CODEX_CONSTANT_FIELDS.shell_type);
    assert.equal(entry.visibility, CODEX_CONSTANT_FIELDS.visibility);
    assert.equal(entry.supported_in_api, CODEX_CONSTANT_FIELDS.supported_in_api);
    assert.equal(entry.support_verbosity, CODEX_CONSTANT_FIELDS.support_verbosity);
    assert.equal(entry.supports_reasoning_summaries, CODEX_CONSTANT_FIELDS.supports_reasoning_summaries);
    assert.deepEqual(entry.experimental_supported_tools, CODEX_CONSTANT_FIELDS.experimental_supported_tools);
    assert.equal(entry.base_instructions, CODEX_CONSTANT_FIELDS.base_instructions);
    assert.equal(entry.priority, CODEX_CONSTANT_FIELDS.priority);
    assert.deepEqual(entry.truncation_policy, CODEX_CONSTANT_FIELDS.truncation_policy);
    assert.equal(entry.prefer_websockets, true);
    assert.equal(entry.default_verbosity, "low");
    assert.equal(entry.default_reasoning_summary, "none");
    assert.equal(entry.minimal_client_version, "0.0.1");
    assert.equal(entry.supports_search_tool, true);
    assert.equal(entry.reasoning_summary_format, "experimental");
    assert.equal(entry.web_search_tool_type, "text");
    assert.equal(entry.supports_image_detail_original, false);
    assert.equal(entry.description, "GLM 5.2 is a great model.");
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

  it("uses correct reasoning config for glm-5p2", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/glm-5p2" }));
    assert.equal(entry.default_reasoning_level, "max");
    const efforts = entry.supported_reasoning_levels.map((level) => level.effort);
    assert.deepEqual(efforts, ["high", "max"]);
  });

  it("uses correct reasoning config for glm-5p1", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/glm-5p1" }));
    assert.equal(entry.default_reasoning_level, "high");
    const efforts = entry.supported_reasoning_levels.map((level) => level.effort);
    assert.deepEqual(efforts, ["high"]);
  });

  it("uses correct reasoning config for minimax-m2p7", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/minimax-m2p7" }));
    assert.equal(entry.default_reasoning_level, "medium");
    const efforts = entry.supported_reasoning_levels.map((level) => level.effort);
    assert.deepEqual(efforts, ["low", "medium", "high"]);
  });

  it("sets auto_compact_token_limit to null", () => {
    const entry = buildCodexCatalogEntry(mockModel({ contextLength: 1048576 }));
    assert.equal(entry.auto_compact_token_limit, null);
  });

  it("builds input_modalities with image when supportsImageInput is true", () => {
    const entry = buildCodexCatalogEntry(mockModel({ supportsImageInput: true }));
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
    assert.equal(entry.web_search_tool_type, "text_and_image");
    assert.equal(entry.supports_image_detail_original, true);
  });

  it("sets reasoning_summary_format to experimental for multi-level models", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/glm-5p2" }));
    assert.equal(entry.reasoning_summary_format, "experimental");
  });

  it("sets reasoning_summary_format to none for single-level models", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/glm-5p1" }));
    assert.equal(entry.reasoning_summary_format, "none");
  });

  it("uses default reasoning config for an unknown model", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/unknown-model" }));
    assert.equal(entry.default_reasoning_level, "high");
    const efforts = entry.supported_reasoning_levels.map((level) => level.effort);
    assert.deepEqual(efforts, ["high"]);
  });
});

describe("codex-catalog buildCodexCatalogEntryForRouter", () => {
  it("overrides slug and display_name while inheriting base metadata", () => {
    const base = mockModel({ name: "accounts/fireworks/models/glm-5p2", contextLength: 1048576 });
    const entry = buildCodexCatalogEntryForRouter(
      "accounts/fireworks/routers/glm-latest",
      base,
      "GLM Latest via Fireworks",
    );
    assert.equal(entry.slug, "accounts/fireworks/routers/glm-latest");
    assert.equal(entry.display_name, "GLM Latest via Fireworks");
    assert.equal(entry.context_window, 1048576);
    assert.equal(entry.max_context_window, 1048576);
    assert.equal(entry.auto_compact_token_limit, null);
  });
});

describe("codex-catalog buildCodexCatalog", () => {
  it("filters out deprecated models", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/kimi-k2p5" }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(!slugs.includes("accounts/fireworks/models/kimi-k2p5"));
    assert.ok(slugs.includes("accounts/fireworks/models/glm-5p2"));
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
    assert.ok(slugs.includes("accounts/fireworks/models/glm-5p2"));
    assert.ok(!slugs.includes("accounts/fireworks/models/embedding-x"));
    assert.ok(!slugs.includes("accounts/fireworks/models/flux-x"));
    assert.ok(!slugs.includes("accounts/fireworks/models/no-tools"));
    assert.ok(!slugs.includes("accounts/fireworks/models/zero-ctx"));
  });

  it("includes router entries derived from base models", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/kimi-k2p6" }),
      mockModel({ name: "accounts/fireworks/models/kimi-k2p7-code" }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("accounts/fireworks/routers/glm-latest"));
    assert.ok(slugs.includes("accounts/fireworks/routers/kimi-fast-latest"));
    assert.ok(slugs.includes("accounts/fireworks/routers/kimi-k2p6-turbo"));
    assert.ok(slugs.includes("accounts/fireworks/routers/kimi-k2p7-code-fast"));
    assert.ok(slugs.includes("accounts/fireworks/routers/kimi-latest"));
  });

  it("router entries inherit base model's context window", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2", contextLength: 1048576 }),
    ]);
    const router = catalog.models.find((entry) => entry.slug === "accounts/fireworks/routers/glm-latest");
    assert.ok(router);
    assert.equal(router.context_window, 1048576);
    assert.equal(router.max_context_window, 1048576);
    assert.equal(router.auto_compact_token_limit, null);
  });

  it("skips a router if its base model is not in the API response", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
    ]);
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("accounts/fireworks/routers/glm-latest"));
    assert.ok(!slugs.includes("accounts/fireworks/routers/kimi-fast-latest"));
    assert.ok(!slugs.includes("accounts/fireworks/routers/kimi-latest"));
  });

  it("all 5 routers are present when all base models are in the API response", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
      mockModel({ name: "accounts/fireworks/models/kimi-k2p6" }),
      mockModel({ name: "accounts/fireworks/models/kimi-k2p7-code" }),
    ]);
    const routerSlugs = catalog.models
      .map((entry) => entry.slug)
      .filter((slug) => slug.startsWith("accounts/fireworks/routers/"));
    assert.equal(routerSlugs.length, 5);
    for (const routerId of Object.keys(ROUTER_BASE_MODEL)) {
      assert.ok(routerSlugs.includes(routerId), `missing router ${routerId}`);
    }
  });

  it("router entries use the display name from BUILTIN_ROUTERS", () => {
    const catalog = buildCodexCatalog([
      mockModel({ name: "accounts/fireworks/models/glm-5p2" }),
    ]);
    const router = catalog.models.find((entry) => entry.slug === "accounts/fireworks/routers/glm-latest");
    assert.equal(router.display_name, "GLM Latest via Fireworks");
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
    assert.ok(slugs.includes("accounts/fireworks/models/qwen3p7-plus"));
    const entry = catalog.models.find((entry) => entry.slug === "accounts/fireworks/models/qwen3p7-plus");
    assert.equal(entry.context_window, 262144);
    assert.deepEqual(entry.input_modalities, ["text", "image"]);
  });

  it("reasoning level descriptions match REASONING_DESCRIPTIONS", () => {
    const entry = buildCodexCatalogEntry(mockModel({ name: "accounts/fireworks/models/minimax-m2p7" }));
    for (const level of entry.supported_reasoning_levels) {
      assert.equal(level.description, REASONING_DESCRIPTIONS[level.effort]);
    }
  });
});

describe("codex-catalog metadata tables", () => {
  it("DEPRECATED_MODELS contains the expected ids", () => {
    assert.ok(DEPRECATED_MODELS.has("accounts/fireworks/models/kimi-k2p5"));
    assert.ok(DEPRECATED_MODELS.has("accounts/fireworks/models/qwen3p6-plus"));
    assert.ok(DEPRECATED_MODELS.has("accounts/fireworks/models/minimax-m2p5"));
  });

  it("ROUTER_BASE_MODEL maps each router to a base model", () => {
    assert.equal(ROUTER_BASE_MODEL["accounts/fireworks/routers/glm-latest"], "accounts/fireworks/models/glm-5p2");
    assert.equal(ROUTER_BASE_MODEL["accounts/fireworks/routers/kimi-fast-latest"], "accounts/fireworks/models/kimi-k2p6");
    assert.equal(ROUTER_BASE_MODEL["accounts/fireworks/routers/kimi-k2p6-turbo"], "accounts/fireworks/models/kimi-k2p6");
    assert.equal(ROUTER_BASE_MODEL["accounts/fireworks/routers/kimi-k2p7-code-fast"], "accounts/fireworks/models/kimi-k2p7-code");
    assert.equal(ROUTER_BASE_MODEL["accounts/fireworks/routers/kimi-latest"], "accounts/fireworks/models/kimi-k2p6");
  });

  it("MODEL_REASONING has entries for all documented models", () => {
    const expected = [
      "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/models/glm-5p1",
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
