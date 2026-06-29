import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VSCODE_MODEL_METADATA,
  FIREWORKS_MODEL_SPECS,
  lookupModelSpec,
  lookupVscodeModelMetadata,
} from "../lib/fireworks-model-specs.mjs";
import { lookupFireworksPricing } from "../lib/fireworks-pricing.mjs";

describe("fireworks-model-specs", () => {
  it("every priced model has vscode metadata", () => {
    for (const [slug, spec] of Object.entries(FIREWORKS_MODEL_SPECS)) {
      if (!spec.pricing) {
        continue;
      }
      assert.ok(spec.vscode, `missing vscode metadata for ${slug}`);
      assert.equal(typeof spec.vscode.maxInputTokens, "number");
      assert.equal(typeof spec.vscode.maxOutputTokens, "number");
      assert.equal(typeof spec.vscode.vision, "boolean");
      assert.equal(typeof spec.vscode.toolCalling, "boolean");
    }
  });

  it("resolves router aliases for pricing and vscode metadata", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/glm-latest");
    const vscode = lookupVscodeModelMetadata("accounts/fireworks/routers/glm-latest");
    assert.equal(pricing?.slug, "glm-5p2");
    assert.equal(vscode.maxInputTokens, FIREWORKS_MODEL_SPECS["glm-5p2"].vscode.maxInputTokens);
    assert.equal(vscode.maxOutputTokens, 131_072);
  });

  it("resolves kimi vision models with image input enabled", () => {
    const vscode = lookupVscodeModelMetadata("accounts/fireworks/routers/kimi-latest");
    assert.equal(vscode.vision, true);
    assert.equal(vscode.toolCalling, true);
  });

  it("marks gpt-oss-20b as non-tool-calling", () => {
    const vscode = lookupVscodeModelMetadata("accounts/fireworks/models/gpt-oss-20b");
    assert.equal(vscode.toolCalling, false);
  });

  it("falls back to bool defaults for unknown models without token limits", () => {
    assert.deepEqual(
      lookupVscodeModelMetadata("accounts/fireworks/models/unknown-model"),
      DEFAULT_VSCODE_MODEL_METADATA,
    );
    assert.equal(lookupModelSpec("accounts/fireworks/models/unknown-model"), null);
  });
});
