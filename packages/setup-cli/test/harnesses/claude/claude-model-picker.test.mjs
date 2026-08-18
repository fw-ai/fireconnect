import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterClaudeModelPicker,
  formatContextWindow,
  loadClaudeModelPickerCatalog,
  modelPickerBadges,
  rankClaudeModelsForSlot,
  suitableClaudeModelsForSlot,
} from "../../../lib/harnesses/claude/model-picker.mjs";

const MODELS = [
  { slug: "glm-latest", label: "GLM Latest", fast: false, contextWindow: 1_000_000, vision: false },
  { slug: "kimi-fast-latest", label: "Kimi Fast Latest", fast: true, contextWindow: 262_000, vision: true },
  { slug: "deepseek-v4-flash", label: "DeepSeek V4 Flash", fast: true, contextWindow: 1_000_000, vision: false },
  { slug: "gpt-oss-120b", label: "GPT OSS 120B", fast: false, contextWindow: 131_000, vision: false },
  { slug: "minimax-latest", label: "MiniMax Latest", fast: false, contextWindow: 512_000, vision: true },
  { slug: "qwen-plus-latest", label: "Qwen Plus Latest", fast: false, contextWindow: 262_000, vision: true },
];

describe("Claude slot-aware model picker", () => {
  it("pins current and recommended models before slot recommendations", () => {
    const ranked = rankClaudeModelsForSlot(MODELS, {
      slot: "haiku",
      currentModel: "glm-latest",
      recommendedModel: "deepseek-v4-flash",
    });
    assert.deepEqual(
      ranked.slice(0, 3).map((model) => model.slug),
      ["glm-latest", "deepseek-v4-flash", "kimi-fast-latest"],
    );
  });

  it("keeps the initial suitable list concise", () => {
    const suitable = suitableClaudeModelsForSlot(MODELS, {
      slot: "fable",
      currentModel: "kimi-fast-latest",
      recommendedModel: "kimi-fast-latest",
    });
    assert.equal(suitable.length, 5);
    assert.equal(suitable[0].slug, "kimi-fast-latest");
  });

  it("searches exact slugs and human labels", () => {
    assert.deepEqual(
      filterClaudeModelPicker(MODELS, "qwen plus").map((model) => model.slug),
      ["qwen-plus-latest"],
    );
    assert.deepEqual(
      filterClaudeModelPicker(MODELS, "deepseek-v4").map((model) => model.slug),
      ["deepseek-v4-flash"],
    );
  });

  it("formats concise capability badges", () => {
    assert.deepEqual(modelPickerBadges(MODELS[1], {
      currentModel: "kimi-fast-latest",
      recommendedModel: "kimi-fast-latest",
    }), ["Current", "Recommended", "Fast", "262K", "Vision"]);
    assert.deepEqual(modelPickerBadges(MODELS[0], {
      currentModel: "",
      recommendedModel: "",
    }), ["Standard", "1M", "Text-only"]);
    assert.equal(formatContextWindow(1_000_000), "1M");
    assert.equal(formatContextWindow(131_072), "131K");
  });

  it("uses only the Fire Pass-compatible catalog for fpk keys", async () => {
    const catalog = await loadClaudeModelPickerCatalog({
      apiKey: "fpk_test_firepass_key",
      keyType: "firepass",
      includeFirerouter: true,
    });
    assert.ok(catalog.some((model) => model.slug === "kimi-fast-latest"));
    assert.ok(catalog.every((model) => model.slug !== "firerouter"));
    assert.ok(catalog.every((model) => model.tools));
  });

  it("injects non-fast fallbacks when the live catalog is empty", async () => {
    const catalog = await loadClaudeModelPickerCatalog({
      apiKey: "fw_empty_catalog",
      keyType: "fireworks",
      includeFirerouter: false,
      extraModelIds: ["glm-latest", "deepseek-v4-pro", "kimi-latest"],
      loadCatalog: async () => ({ catalog: [] }),
    });
    assert.deepEqual(
      catalog.map((model) => model.slug).sort(),
      // fw_ keys always get the native "Claude default" choice alongside the
      // Fireworks fallbacks.
      ["claude-default", "deepseek-v4-pro", "glm-latest", "kimi-latest"],
    );
    assert.ok(catalog.every((model) => !model.fast));
  });
});
