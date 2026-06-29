import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_FIREPASS_PRESET,
  normalizeModelId,
  validateModelId,
} from "../lib/fireconnect-core.mjs";
import {
  claudeCodeModelId,
  applyClaudeCodeContextPolicy,
} from "../lib/claude-code-context.mjs";
import {
  fetchServerlessCatalog,
  filterCatalogForKeyType,
  FIREPASS_ROUTER_ID,
} from "../lib/fireworks-models.mjs";
import {
  FIREPASS_ROUTER,
  FIREPASS_DEFAULT_ROUTER,
  GLM_LATEST,
  K2P7_FAST,
  KIMI_FAST_LATEST,
} from "./helpers.mjs";

describe("Fire Pass defaults", () => {
  test("FIREPASS_ROUTER_ID is glm-latest", () => {
    assert.equal(FIREPASS_ROUTER_ID, FIREPASS_ROUTER);
  });

  test("DEFAULT_FIREPASS_PRESET routes all aliases to glm-latest", () => {
    const aliasKeys = [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ];
    for (const key of aliasKeys) {
      assert.equal(DEFAULT_FIREPASS_PRESET[key], FIREPASS_DEFAULT_ROUTER);
    }
  });

  test("built-in router catalog includes latest GLM and Kimi routers", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ models: [] }),
    });

    try {
      const { catalog } = await fetchServerlessCatalog("fw_test_key");
      const ids = catalog.map((entry) => entry.id);
      assert.ok(ids.includes("accounts/fireworks/routers/glm-latest"));
      assert.ok(ids.includes("accounts/fireworks/routers/glm-5p2-fast"));
      assert.ok(ids.includes("accounts/fireworks/routers/kimi-fast-latest"));
      assert.ok(ids.includes("accounts/fireworks/routers/kimi-latest"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("latest router short IDs normalize as routers", () => {
    assert.equal(normalizeModelId("glm-latest"), "accounts/fireworks/routers/glm-latest");
    assert.equal(normalizeModelId("glm-5p2-fast"), "accounts/fireworks/routers/glm-5p2-fast");
    assert.equal(normalizeModelId("kimi-fast-latest"), "accounts/fireworks/routers/kimi-fast-latest");
    assert.equal(normalizeModelId("kimi-latest"), "accounts/fireworks/routers/kimi-latest");
  });

  test("Fire Pass catalog includes all supported routers", () => {
    const catalog = [
      { id: "accounts/fireworks/routers/glm-latest", shortId: GLM_LATEST },
      { id: "accounts/fireworks/routers/glm-5p2-fast", shortId: "glm-5p2-fast" },
      { id: "accounts/fireworks/routers/kimi-fast-latest", shortId: KIMI_FAST_LATEST },
      { id: "accounts/fireworks/routers/kimi-k2p6-turbo", shortId: "kimi-k2p6-turbo" },
      { id: "accounts/fireworks/routers/kimi-k2p7-code-fast", shortId: K2P7_FAST },
      { id: "accounts/fireworks/routers/kimi-latest", shortId: "kimi-latest" },
    ];

    assert.deepEqual(
      filterCatalogForKeyType(catalog, "firepass").map((entry) => entry.shortId),
      [GLM_LATEST, "glm-5p2-fast", KIMI_FAST_LATEST, K2P7_FAST],
    );
  });

  test("model ID validation shows model and router examples", () => {
    assert.throws(
      () => validateModelId("bad/provider/path", "--main"),
      /--main must be a Fireworks model ID like deepseek-v4-flash or a router ID like glm-latest/,
    );
  });

  test("GLM latest and GLM 5P2 use Claude Code 1m context", () => {
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-latest"), "accounts/fireworks/routers/glm-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/glm-5p2"), "accounts/fireworks/models/glm-5p2[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-5p2-fast"), "accounts/fireworks/routers/glm-5p2-fast[1m]");

    const env = applyClaudeCodeContextPolicy(
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      { main: "accounts/fireworks/routers/glm-latest" },
    );
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
  });
});
