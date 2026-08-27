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
  modelQualifiesForClaudeCode1mContext,
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
  KIMI_FAST_LATEST,
  mockServerlessModel,
} from "../helpers.mjs";

describe("Fire Pass defaults", () => {
  test("FIREPASS_ROUTER_ID is kimi-fast-latest", () => {
    assert.equal(FIREPASS_ROUTER_ID, FIREPASS_ROUTER);
  });

  test("DEFAULT_FIREPASS_PRESET routes alias slots to kimi-fast-latest", () => {
    const aliasKeys = [
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

  test("resolveDefaultMainModel always uses kimi-fast-latest", () => {
    assert.equal(resolveDefaultMainModel(), KIMI_FAST_LATEST);
    assert.equal(defaultMainModel(), KIMI_FAST_LATEST);
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
      { id: "accounts/fireworks/routers/kimi-latest", shortId: "kimi-latest" },
    ];

    assert.deepEqual(
      filterCatalogForKeyType(catalog, "firepass").map((entry) => entry.shortId),
      [GLM_LATEST, GLM_FAST_LATEST, "glm-5p2-fast", KIMI_FAST_LATEST],
    );
  });

  test("model ID validation shows model and router examples", () => {
    assert.throws(
      () => validateModelId("bad/provider/path", "--model"),
      /--model must be a Fireworks model id — a stable -latest router alias like glm-fast-latest.*firerouter, or a specific id like glm-5p2/,
    );
  });

  test("model ID validation allows firerouter* gateway patterns", () => {
    assert.doesNotThrow(() => validateModelId("firerouter/x", "--model"));
    assert.doesNotThrow(() => validateModelId("firerouter/x[1m]", "--opus"));
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

  test("Kimi K3 family uses Claude Code 1m context", () => {
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/kimi-latest"), "accounts/fireworks/routers/kimi-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/kimi-fast-latest"), "accounts/fireworks/routers/kimi-fast-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/kimi-k3"), "accounts/fireworks/models/kimi-k3[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/kimi-k3-fast"), "accounts/fireworks/routers/kimi-k3-fast[1m]");

    const env = applyClaudeCodeContextPolicy(
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      { main: "accounts/fireworks/routers/kimi-fast-latest" },
    );
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
  });

  test("DeepSeek latest routers use Claude Code 1m context", () => {
    assert.equal(claudeCodeModelId("deepseek-flash-latest"), "deepseek-flash-latest[1m]");
    assert.equal(claudeCodeModelId("deepseek-pro-latest"), "deepseek-pro-latest[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-pro"), "accounts/fireworks/models/deepseek-v4-pro[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-flash"), "accounts/fireworks/models/deepseek-v4-flash[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-pro-0813"), "accounts/fireworks/models/deepseek-v4-pro-0813[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/models/deepseek-v4-flash-0731"), "accounts/fireworks/models/deepseek-v4-flash-0731[1m]");
  });

  test("firerouter* model patterns use Claude Code 1m context", () => {
    assert.equal(claudeCodeModelId("firerouter"), "firerouter[1m]");
    assert.equal(claudeCodeModelId("firerouter[1m]"), "firerouter[1m]");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/firerouter"), "accounts/fireworks/routers/firerouter[1m]");
    assert.equal(claudeCodeModelId("firerouter/x"), "firerouter/x[1m]");
    assert.equal(claudeCodeModelId("firerouter/x[1m]"), "firerouter/x[1m]");
    assert.equal(claudeCodeModelId("FireRouter/x"), "FireRouter/x[1m]");
    assert.equal(claudeCodeModelId("firerouterx"), "firerouterx[1m]");

    const env = applyClaudeCodeContextPolicy(
      { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" },
      { main: "firerouter/x" },
    );
    assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
  });

  test("models below 1M context omit the Claude Code [1m] suffix", () => {
    assert.equal(claudeCodeModelId("accounts/fireworks/models/gpt-oss-120b"), "accounts/fireworks/models/gpt-oss-120b");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/minimax-latest"), "accounts/fireworks/routers/minimax-latest");
    assert.equal(claudeCodeModelId("accounts/fireworks/routers/qwen-plus-latest"), "accounts/fireworks/routers/qwen-plus-latest");
    assert.equal(claudeCodeModelId("kimi-k2p6-fast"), "kimi-k2p6-fast");
    assert.equal(modelQualifiesForClaudeCode1mContext("gpt-oss-120b"), false);
  });

  test("deepseek-flash-latest qualifies via live router base context length", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/deepseek-v4-flash-0731",
        shortId: "deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash (0731)",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/deepseek-flash-latest", "accounts/fireworks/models/deepseek-v4-flash-0731"],
      ]),
      contextLengthById: new Map([
        ["accounts/fireworks/models/deepseek-v4-flash-0731", 1_048_576],
        ["accounts/fireworks/routers/deepseek-flash-latest", 1_048_576],
      ]),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(modelQualifiesForClaudeCode1mContext("deepseek-flash-latest"), true);
      assert.equal(claudeCodeModelId("deepseek-flash-latest"), "deepseek-flash-latest[1m]");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });
});
