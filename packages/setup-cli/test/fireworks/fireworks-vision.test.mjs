import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatNonVisionModelsWarning,
  modelSupportsVision,
  uniqueNonVisionModelShortIds,
  visionCapabilityLabel,
} from "../../lib/fireworks/vision.mjs";

describe("fireworks-vision", () => {
  it("detects vision support from model specs", () => {
    assert.equal(modelSupportsVision("accounts/fireworks/routers/kimi-latest"), true);
    assert.equal(modelSupportsVision("accounts/fireworks/routers/glm-fast-latest"), false);
    assert.equal(modelSupportsVision("accounts/fireworks/routers/firerouter"), true);
  });

  it("exposes compact vision labels for status output", () => {
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/kimi-latest"), "vision");
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/glm-5p2-fast"), "text-only");
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/firerouter"), "");
  });

  it("formats one compact warning for unique text-only models", () => {
    const shortIds = uniqueNonVisionModelShortIds([
      "glm-fast-latest[1m]",
      "accounts/fireworks/routers/deepseek-v4-flash",
      "glm-fast-latest",
      "kimi-latest",
      "firerouter",
    ]);
    assert.deepEqual(shortIds, ["deepseek-v4-flash", "glm-fast-latest"]);
    assert.equal(
      formatNonVisionModelsWarning(shortIds),
      "Text-only: deepseek-v4-flash, glm-fast-latest · Avoid images; recover with /rewind.",
    );
    assert.equal(formatNonVisionModelsWarning([]), "");
  });
});
