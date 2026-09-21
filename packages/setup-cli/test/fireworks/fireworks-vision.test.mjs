import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatNonVisionModelsWarning,
  modelSupportsVision,
  rowSupportsImageInput,
  uniqueNonVisionModelShortIds,
  visionCapabilityLabel,
} from "../../lib/fireworks/vision.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../helpers.mjs";

// `kimi-latest` only resolves through the API's per-row `aliases` now, so warm a
// catalog snapshot binding it to its vision-capable base before the lookups.
function withKimiCatalog(fn) {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
    mockServerlessModel({
      name: "accounts/fireworks/models/kimi-k3",
      context_length: 1_040_000,
      input_modalities: ["text", "image"],
      aliases: ["accounts/fireworks/routers/kimi-latest"],
    }),
  ]));
  try {
    return fn();
  } finally {
    setServerlessCatalogSnapshot(null);
  }
}

describe("fireworks-vision", () => {
  it("detects vision support from model specs", () => withKimiCatalog(() => {
    assert.equal(modelSupportsVision("accounts/fireworks/routers/kimi-latest"), true);
    assert.equal(modelSupportsVision("accounts/fireworks/routers/glm-fast-latest"), false);
    assert.equal(modelSupportsVision("accounts/fireworks/routers/firerouter"), true);
  }));

  it("exposes compact vision labels for status output", () => withKimiCatalog(() => {
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/kimi-latest"), "vision");
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/glm-5p2-fast"), "text-only");
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/firerouter"), "");
  }));

  it("formats one compact warning for unique text-only models", () => withKimiCatalog(() => {
    const shortIds = uniqueNonVisionModelShortIds([
      "glm-5p2-fast[1m]",
      "accounts/fireworks/routers/deepseek-v4-flash",
      "glm-5p2-fast",
      "kimi-latest",
      "firerouter",
    ]);
    assert.deepEqual(shortIds, ["deepseek-v4-flash", "glm-5p2-fast"]);
    assert.equal(
      formatNonVisionModelsWarning(shortIds),
      "Text-only: deepseek-v4-flash, glm-5p2-fast · Avoid images; recover with /rewind.",
    );
    assert.equal(formatNonVisionModelsWarning([]), "");
  }));
});

describe("rowSupportsImageInput", () => {
  it("reads the camelCase boolean when defined", () => {
    assert.equal(rowSupportsImageInput({ supportsImageInput: true }), true);
    assert.equal(rowSupportsImageInput({ supportsImageInput: false }), false);
  });

  it("reads the snake_case boolean when defined", () => {
    assert.equal(rowSupportsImageInput({ supports_image_input: true }), true);
    assert.equal(rowSupportsImageInput({ supports_image_input: false }), false);
  });

  it("falls back to the modalities array when no boolean is present", () => {
    assert.equal(rowSupportsImageInput({ inputModalities: ["text", "image"] }), true);
    assert.equal(rowSupportsImageInput({ input_modalities: ["text", "image"] }), true);
    assert.equal(rowSupportsImageInput({ inputModalities: ["text"] }), false);
    assert.equal(rowSupportsImageInput({ input_modalities: ["text"] }), false);
  });

  it("keeps explicit boolean precedence over a contradicting array", () => {
    assert.equal(rowSupportsImageInput({ supportsImageInput: true, inputModalities: ["text"] }), true);
    assert.equal(rowSupportsImageInput({ supportsImageInput: false, inputModalities: ["text", "image"] }), false);
  });

  it("is text-only when no signal is present", () => {
    assert.equal(rowSupportsImageInput({}), false);
    assert.equal(rowSupportsImageInput({ inputModalities: [] }), false);
    assert.equal(rowSupportsImageInput(null), false);
    assert.equal(rowSupportsImageInput(undefined), false);
  });
});
