import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPiCustomFireworksModelEntry,
  mergePiFireworksRouterModels,
  ONE_MILLION_CONTEXT,
  PI_BUILTIN_FIREWORKS_MODEL_IDS,
  resolvePiEffectiveFireworksModel,
} from "../lib/pi-fireworks-models.mjs";

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
  it("uses modelOverrides for Pi catalog routers instead of replacing them in models", () => {
    const merged = mergePiFireworksRouterModels({}, GLM_5P2_FAST);
    const fireworks = merged.providers.fireworks;

    assert.ok(PI_BUILTIN_FIREWORKS_MODEL_IDS.has(GLM_5P2_FAST));
    assert.equal(fireworks.modelOverrides[GLM_5P2_FAST].name, "GLM 5.2 Fast via Fireworks");
    assert.equal(fireworks.modelOverrides[GLM_5P2_FAST].reasoning, true);
    assert.equal(fireworks.modelOverrides[GLM_5P2_FAST].contextWindow, undefined);
    assert.equal(
      fireworks.models?.some((model) => model.id === GLM_5P2_FAST),
      false,
    );
  });

  it("registers non-catalog routers in models with full context and pricing", () => {
    const merged = mergePiFireworksRouterModels({}, GLM_LATEST);
    const entry = merged.providers.fireworks.models.find((model) => model.id === GLM_LATEST);

    assert.ok(entry);
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.cost.input, 1.4);
    assert.equal(entry.cost.output, 4.4);
    assert.equal(merged.providers.fireworks.modelOverrides?.[GLM_LATEST], undefined);
  });

  it("migrates a stale catalog router from models into modelOverrides", () => {
    const merged = mergePiFireworksRouterModels({
      providers: {
        fireworks: {
          models: [{ id: GLM_5P2_FAST, name: "stale", reasoning: true, contextWindow: 128_000 }],
        },
      },
    }, GLM_5P2_FAST);

    const fireworks = merged.providers.fireworks;
    assert.equal(fireworks.models?.some((model) => model.id === GLM_5P2_FAST), false);
    assert.equal(fireworks.modelOverrides[GLM_5P2_FAST].name, "GLM 5.2 Fast via Fireworks");
  });

  it("does not register built-in direct models the user selected", () => {
    const modelId = "accounts/fireworks/models/glm-5p2";
    const merged = mergePiFireworksRouterModels({}, modelId);
    const fireworks = merged.providers.fireworks;

    assert.equal(fireworks.models?.some((model) => model.id === modelId), false);
    assert.equal(fireworks.modelOverrides?.[modelId], undefined);
  });
});

describe("resolvePiEffectiveFireworksModel", () => {
  it("preserves 1M context for Pi catalog glm-5p2-fast via modelOverrides merge", () => {
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
    const entry = buildPiCustomFireworksModelEntry(GLM_LATEST, "GLM Latest via Fireworks");
    assert.equal(entry.contextWindow, 1_048_575);
    assert.equal(entry.maxTokens, 131_072);
    assert.deepEqual(entry.input, ["text"]);
    assert.equal(entry.cost.output, 4.4);
  });
});
