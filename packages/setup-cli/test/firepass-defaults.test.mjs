import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_FIREPASS_PRESET } from "../lib/fireconnect-core.mjs";
import { FIREPASS_ROUTER_ID } from "../lib/fireworks-models.mjs";
import { FIREPASS_ROUTER } from "./helpers.mjs";

describe("Fire Pass defaults", () => {
  test("FIREPASS_ROUTER_ID is kimi-k2p7-code-fast", () => {
    assert.equal(FIREPASS_ROUTER_ID, FIREPASS_ROUTER);
  });

  test("DEFAULT_FIREPASS_PRESET routes all aliases to kimi-k2p7-code-fast", () => {
    const aliasKeys = [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ];
    for (const key of aliasKeys) {
      assert.equal(DEFAULT_FIREPASS_PRESET[key], FIREPASS_ROUTER);
    }
  });
});
