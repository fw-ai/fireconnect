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

  it("collects unique non-vision models from a mapping", () => {
    assert.deepEqual(
      uniqueNonVisionModelShortIds([
        "accounts/fireworks/routers/glm-fast-latest[1m]",
        "accounts/fireworks/routers/glm-fast-latest",
        "accounts/fireworks/routers/kimi-fast-latest",
        "accounts/fireworks/models/deepseek-v4-flash",
        "accounts/fireworks/routers/firerouter",
      ]),
      ["deepseek-v4-flash", "glm-fast-latest"],
    );
  });

  it("formats a warning for one or more text-only models", () => {
    assert.match(
      formatNonVisionModelsWarning(["glm-fast-latest"]),
      /glm-fast-latest is text-only/,
    );
    assert.match(
      formatNonVisionModelsWarning(["deepseek-v4-flash", "glm-fast-latest"]),
      /deepseek-v4-flash and glm-fast-latest are text-only/,
    );
    assert.match(
      formatNonVisionModelsWarning(["glm-fast-latest"]),
      /\/rewind/,
    );
    assert.equal(formatNonVisionModelsWarning([]), "");
  });

  it("exposes compact vision labels for status output", () => {
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/kimi-latest"), "vision");
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/glm-5p2-fast"), "text-only");
    assert.equal(visionCapabilityLabel("accounts/fireworks/routers/firerouter"), "");
  });
});
