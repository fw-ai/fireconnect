import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_FIREPASS_PRESET,
} from "../../lib/harnesses/claude/core.mjs";
import {
  fireworksModelSlug,
  fullFireworksResourceId,
  isFireworksModelId,
  normalizeModelId,
  resolveDefaultMainModel,
  defaultMainModel,
  shortFireworksModelRef,
  validateModelId,
} from "../../lib/fireworks/model-id.mjs";
import {
  claudeCodeModelId,
  applyClaudeCodeContextPolicy,
} from "../../lib/harnesses/claude/code-context.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  fetchServerlessCatalog,
  filterCatalogForKeyType,
  FIREPASS_ROUTER_ID,
} from "../../lib/fireworks/models.mjs";
import {
  FIREPASS_DEFAULT_ROUTER,
  FIREPASS_ROUTER,
  GLM_FAST_LATEST,
  GLM_LATEST,
  K2P7_FAST,
  KIMI_FAST_LATEST,
  mockServerlessModel,
} from "../helpers.mjs";

describe("Fire Pass defaults", () => {
  test("FIREPASS_ROUTER_ID is glm-fast-latest", () => {
    assert.equal(FIREPASS_ROUTER_ID, FIREPASS_ROUTER);
  });

  test("DEFAULT_FIREPASS_PRESET routes all aliases to glm-fast-latest", () => {
    const aliasKeys = [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ];
    for (const key of aliasKeys) {
      assert.equal(DEFAULT_FIREPASS_PRESET[key], FIREPASS_DEFAULT_ROUTER);
    }
  });

  test("serverless catalog derives fast routers from usage_identifier", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ models: [mockServerlessModel()] }),
    });

    try {
      const { catalog } = await fetchServerlessCatalog("fw_test_key");
      const ids = catalog.map((entry) => entry.id);
      assert.ok(ids.includes("accounts/fireworks/models/glm-5p2"));
      assert.ok(ids.includes("accounts/fireworks/routers/glm-5p2-fast"));
      assert.ok(ids.includes("accounts/fireworks/routers/glm-latest"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("resolveDefaultMainModel prefers kimi-fast-latest when Kimi K3 is serverless", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k3",
        shortId: "kimi-k3",
        displayName: "Kimi K3",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(resolveDefaultMainModel(), "kimi-fast-latest");
      assert.equal(defaultMainModel(), "kimi-fast-latest");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  test("latest router short IDs stay as gateway slugs", () => {
    assert.equal(normalizeModelId("glm-latest"), "glm-latest");
    assert.equal(normalizeModelId("glm-fast-latest"), "glm-fast-latest");
    assert.equal(normalizeModelId("glm-5p1-fast"), "glm-5p1-fast");
    assert.equal(normalizeModelId("glm-5p2-fast"), "glm-5p2-fast");
    assert.equal(normalizeModelId("kimi-fast-latest"), "kimi-fast-latest");
    assert.equal(normalizeModelId("kimi-k2p6-fast"), "kimi-k2p6-fast");
    assert.equal(normalizeModelId("kimi-latest"), "kimi-latest");
    assert.equal(normalizeModelId("minimax-latest"), "minimax-latest");
    assert.equal(normalizeModelId("qwen-plus-latest"), "qwen-plus-latest");
  });

  test("fullFireworksResourceId expands slugs for catalog lookups", () => {
    assert.equal(fullFireworksResourceId("glm-fast-latest"), "accounts/fireworks/routers/glm-fast-latest");
    assert.equal(fullFireworksResourceId("deepseek-v4-flash"), "accounts/fireworks/models/deepseek-v4-flash");
    assert.equal(shortFireworksModelRef(`${fullFireworksResourceId("glm-fast-latest")}[1m]`), "glm-fast-latest[1m]");
    assert.equal(fireworksModelSlug("glm-fast-latest[1m]"), "glm-fast-latest");
    assert.equal(
      shortFireworksModelRef("accounts/acme/models/private-model"),
      "accounts/acme/models/private-model",
    );
  });

  test("ownership accepts canonical legacy refs and known stored short refs", () => {
    assert.equal(isFireworksModelId("accounts/fireworks/models/deepseek-v4-flash"), true);
    assert.equal(isFireworksModelId("glm-fast-latest[1m]"), true);
    assert.equal(isFireworksModelId("deepseek-v4-flash"), true);
    assert.equal(isFireworksModelId("minimax-latest"), true);
    assert.equal(isFireworksModelId("claude-sonnet-5"), false);
    assert.equal(isFireworksModelId("unknown-user-model"), false);
  });

  test("Fire Pass catalog includes all supported routers", () => {
    const catalog = [
      { id: "accounts/fireworks/routers/glm-latest", shortId: GLM_LATEST },
      { id: "accounts/fireworks/routers/glm-fast-latest", shortId: GLM_FAST_LATEST },
      { id: "accounts/fireworks/routers/glm-5p2-fast", shortId: "glm-5p2-fast" },
      { id: "accounts/fireworks/routers/kimi-fast-latest", shortId: KIMI_FAST_LATEST },
      { id: "accounts/fireworks/routers/kimi-k2p6-turbo", shortId: "kimi-k2p6-turbo" },
      { id: "accounts/fireworks/routers/kimi-k2p7-code-fast", shortId: K2P7_FAST },
      { id: "accounts/fireworks/routers/kimi-latest", shortId: "kimi-latest" },
    ];

    assert.deepEqual(
      filterCatalogForKeyType(catalog, "firepass").map((entry) => entry.shortId),
      [GLM_LATEST, GLM_FAST_LATEST, "glm-5p2-fast", KIMI_FAST_LATEST, K2P7_FAST],
    );
  });

  test("model ID validation shows model and router examples", () => {
    assert.throws(
      () => validateModelId("bad/provider/path", "--model"),
      /--model must be a Fireworks model ID like deepseek-v4-flash or a router ID like glm-latest/,
    );
  });

  test("GLM fast routers and GLM 5P2 use Claude Code 1m context", () => {
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-latest"), "accounts/fireworks/routers/glm-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-fast-latest"), "accounts/fireworks/routers/glm-fast-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/glm-5p2"), "accounts/fireworks/models/glm-5p2[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/glm-5p2-fast"), "accounts/fireworks/routers/glm-5p2-fast[1m]");

    const env = applyClaudeCodeContextPolicy(
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      { main: "accounts/fireworks/routers/glm-fast-latest" },
    );
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
  });
});
