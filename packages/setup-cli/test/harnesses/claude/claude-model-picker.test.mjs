import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterClaudeModelPicker,
  formatContextWindow,
  loadClaudeModelPickerCatalog,
  modelPickerBadges,
  rankClaudeModelsForSlot,
  slotPickerRecommendations,
  suitableClaudeModelsForSlot,
} from "../../../lib/harnesses/claude/model-picker.mjs";
import {
  CLAUDE_FIREWORKS_PINNED_DEFAULTS,
  DEFAULT_FABLE_MODEL,
} from "../../../lib/harnesses/claude/model-profile.mjs";

const MODELS = [
  { slug: "auto", label: "Auto", fast: false, contextWindow: 1_048_575, vision: true, auto: true },
  { slug: "auto-instant", label: "Auto Instant", fast: false, contextWindow: 1_048_575, vision: true, auto: true },
  { slug: "glm-latest", label: "GLM Latest", fast: false, contextWindow: 1_000_000, vision: false },
  { slug: "glm-flash-latest", label: "GLM Flash Latest", fast: true, contextWindow: 1_000_000, vision: true },
  { slug: "kimi-latest", label: "Kimi Latest", fast: false, contextWindow: 1_000_000, vision: true },
  { slug: "kimi-fast-latest", label: "Kimi Fast Latest", fast: true, contextWindow: 262_000, vision: true },
  { slug: "deepseek-v4-flash", label: "DeepSeek V4 Flash", fast: true, contextWindow: 1_000_000, vision: false },
  { slug: "gpt-oss-120b", label: "GPT OSS 120B", fast: false, contextWindow: 131_000, vision: false },
  { slug: "minimax-latest", label: "MiniMax Latest", fast: false, contextWindow: 512_000, vision: true },
  { slug: "qwen-plus-latest", label: "Qwen Plus Latest", fast: false, contextWindow: 262_000, vision: true },
];

describe("Claude slot-aware model picker", () => {
  it("leads each slot list with the canonical default from model-profile", () => {
    assert.equal(slotPickerRecommendations("opus")[0], CLAUDE_FIREWORKS_PINNED_DEFAULTS.opus);
    assert.equal(slotPickerRecommendations("sonnet")[0], CLAUDE_FIREWORKS_PINNED_DEFAULTS.sonnet);
    assert.ok(slotPickerRecommendations("opus").includes("firerouter"));
    assert.ok(slotPickerRecommendations("sonnet").includes("auto"));
    assert.ok(slotPickerRecommendations("sonnet").includes("auto-instant"));
    assert.ok(!slotPickerRecommendations("opus").includes("auto-instant"));
  });

  it("shows auto-instant in the Sonnet picker only", () => {
    const sonnet = suitableClaudeModelsForSlot(MODELS, {
      slot: "sonnet",
      currentModel: CLAUDE_FIREWORKS_PINNED_DEFAULTS.sonnet,
      recommendedModel: CLAUDE_FIREWORKS_PINNED_DEFAULTS.sonnet,
    });
    const haiku = suitableClaudeModelsForSlot(MODELS, {
      slot: "haiku",
      currentModel: CLAUDE_FIREWORKS_PINNED_DEFAULTS.haiku,
      recommendedModel: CLAUDE_FIREWORKS_PINNED_DEFAULTS.haiku,
    });
    assert.ok(sonnet.some((model) => model.slug === "auto-instant"));
    assert.ok(haiku.every((model) => model.slug !== "auto-instant"));
  });

  it("ranks slot recommendations after current and recommended, with minimax last", () => {
    const ranked = rankClaudeModelsForSlot(MODELS, {
      slot: "haiku",
      currentModel: "",
      recommendedModel: "",
    });
    const recommended = [
      "auto",
      "gpt-oss-120b",
      "glm-flash-latest",
      "qwen-plus-latest",
      "minimax-latest",
    ];
    const rankedRecommendations = ranked
      .filter((model) => recommended.includes(model.slug))
      .map((model) => model.slug);
    assert.deepEqual(rankedRecommendations, recommended);
  });

  it("pins current and recommended models before slot recommendations", () => {
    const ranked = rankClaudeModelsForSlot(MODELS, {
      slot: "haiku",
      currentModel: "glm-latest",
      recommendedModel: "deepseek-v4-flash",
    });
    assert.deepEqual(
      ranked.slice(0, 4).map((model) => model.slug),
      ["glm-latest", "deepseek-v4-flash", "auto", "gpt-oss-120b"],
    );
  });

  it("shows every slot recommendation in the initial picker list", () => {
    const suitable = suitableClaudeModelsForSlot(MODELS, {
      slot: "fable",
      currentModel: DEFAULT_FABLE_MODEL,
      recommendedModel: DEFAULT_FABLE_MODEL,
    });
    assert.deepEqual(
      suitable.map((model) => model.slug),
      slotPickerRecommendations("fable").filter((slug) => (
        MODELS.some((model) => model.slug === slug)
      )),
    );
  });

  it("includes glm-latest on sonnet even when it is not the recommended default", () => {
    const catalog = [
      ...MODELS,
      { slug: "kimi-latest", label: "Kimi Latest", fast: false, contextWindow: 1_000_000, vision: true },
      { slug: "deepseek-flash-latest", label: "DeepSeek Flash", fast: false, contextWindow: 1_000_000, vision: false },
      { slug: "claude-default", label: "Claude default", fast: false, contextWindow: 1_000_000, vision: true },
    ];
    const suitable = suitableClaudeModelsForSlot(catalog, {
      slot: "sonnet",
      currentModel: "kimi-latest",
      recommendedModel: "kimi-latest",
    });
    assert.ok(suitable.some((model) => model.slug === "glm-latest"));
    assert.ok(suitable.some((model) => model.slug === "claude-default"));
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

  it("labels auto with an open-model mix badge", () => {
    assert.deepEqual(modelPickerBadges(MODELS[0], {
      currentModel: "",
      recommendedModel: "",
    }), ["Open-model mix", "1.0M"]);
  });

  it("formats concise capability badges", () => {
    const kimiFast = MODELS.find((model) => model.slug === "kimi-fast-latest");
    assert.deepEqual(modelPickerBadges(kimiFast, {
      currentModel: "kimi-fast-latest",
      recommendedModel: "kimi-fast-latest",
    }), ["Current", "Recommended", "Fast", "262K", "Vision"]);
    assert.deepEqual(modelPickerBadges(MODELS.find((model) => model.slug === "glm-latest"), {
      currentModel: "",
      recommendedModel: "",
    }), ["Standard", "1M", "Text-only"]);
    assert.equal(formatContextWindow(1_000_000), "1M");
    assert.equal(formatContextWindow(131_072), "131K");
  });

  it("includes auto on standard keys but not Fire Pass", async () => {
    const fireworks = await loadClaudeModelPickerCatalog({
      apiKey: "fw_test_key",
      keyType: "fireworks",
      includeFirerouter: false,
      loadCatalog: async () => ({ catalog: [] }),
    });
    assert.ok(fireworks.some((model) => model.slug === "auto"));
    assert.ok(fireworks.some((model) => model.slug === "auto-instant"));
    assert.ok(fireworks.every((model) => model.slug !== "firerouter"));

    const firepass = await loadClaudeModelPickerCatalog({
      apiKey: "fpk_test_firepass_key",
      keyType: "firepass",
      includeFirerouter: true,
    });
    assert.ok(firepass.every((model) => model.slug !== "auto"));
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

  it("injects offline fallbacks when the live catalog is empty", async () => {
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
      ["auto", "auto-instant", "claude-default", "deepseek-v4-pro", "glm-latest", "kimi-latest"],
    );
    assert.ok(catalog.every((model) => !model.fast));
  });
});
