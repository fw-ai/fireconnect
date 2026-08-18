import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enableOpencodeFireworks,
  opencodeNeedsProviderModelOverride,
  opencodeProviderModelKey,
} from "../../../lib/harnesses/opencode/core.mjs";
import {
  clearModelsDevFireworksRegistry,
  setModelsDevFireworksRegistry,
} from "../../../lib/fireworks/models-dev-registry.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

process.env.FIRECONNECT_TEST ??= "1";

describe("opencode catalog model handling", () => {
  it("identifies router overrides vs models.dev catalog entries", () => {
    setModelsDevFireworksRegistry([
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/routers/glm-5p2-fast",
      "accounts/fireworks/routers/kimi-k3-fast",
    ]);
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/inkling",
        shortId: "inkling",
        displayName: "Inkling",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([["accounts/fireworks/models/inkling", 1_048_576]]),
      supportsToolsById: new Map(),
    });
    try {
      for (const alias of [
        "glm-fast-latest",
        "glm-latest",
        "kimi-fast-latest",
        "kimi-latest",
        "minimax-latest",
        "qwen-plus-latest",
      ]) {
        assert.equal(opencodeNeedsProviderModelOverride(alias), true, alias);
        assert.equal(
          opencodeNeedsProviderModelOverride(`accounts/fireworks/routers/${alias}`),
          true,
          alias,
        );
      }
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/deepseek-v4-flash"), false);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/routers/glm-5p2-fast"), false);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/routers/kimi-k3-fast"), false);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/inkling"), true);
      assert.equal(opencodeNeedsProviderModelOverride("firerouter"), true);
    } finally {
      clearModelsDevFireworksRegistry();
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes provider model overrides only for routers, not catalog models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-models-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    const catalogModelIds = [
      "accounts/fireworks/routers/glm-fast-latest",
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/kimi-fast-latest",
      "accounts/fireworks/routers/minimax-latest",
      "accounts/fireworks/routers/qwen-plus-latest",
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/routers/glm-5p2-fast",
    ];

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      modelId: "deepseek-v4-flash",
      catalogModelIds,
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/accounts/fireworks/models/deepseek-v4-flash");
    const models = config.provider["fireworks-ai"].models;
    assert.equal(models["deepseek-v4-flash"], undefined);
    assert.equal(models["glm-5p2-fast"], undefined);
    assert.ok(models["glm-fast-latest"]);
    assert.ok(models["glm-latest"]);
    assert.ok(models["kimi-fast-latest"]);
    assert.ok(models["minimax-latest"]);
    assert.ok(models["qwen-plus-latest"]);
  });

  it("collapses legacy provider.models keys to one canonical slug", () => {
    assert.equal(opencodeProviderModelKey("glm-fast-latest"), "glm-fast-latest");
    assert.equal(
      opencodeProviderModelKey("accounts/fireworks/routers/glm-fast-latest"),
      "glm-fast-latest",
    );
    assert.equal(opencodeProviderModelKey("fireworks-ai/glm-fast-latest"), "glm-fast-latest");
  });

  it("keeps path-shaped firerouter* keys intact", () => {
    assert.equal(opencodeProviderModelKey("firerouter/x"), "firerouter/x");
    assert.equal(opencodeProviderModelKey("firerouter"), "firerouter");
  });

  it("writes firerouter* provider overrides under the full short ref", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-firerouter-path-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      modelId: "firerouter/x",
      catalogModelIds: ["accounts/fireworks/routers/glm-latest"],
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/firerouter/x");
    const models = config.provider?.["fireworks-ai"]?.models ?? {};
    assert.ok(models["firerouter/x"], "override keyed by full short ref");
    assert.equal(models.x, undefined, "must not collapse to last path segment");
    assert.equal(models["firerouter/x"].limit.context, 1_048_575);
  });

  it("re-on with catalog rebuilds idempotently and drops duplicate legacy keys", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-reon-idempotent-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    const catalogModelIds = [
      "accounts/fireworks/routers/glm-fast-latest",
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/kimi-fast-latest",
    ];

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fpk_test_firepass_key",
      effectiveApiKey: "fpk_test_firepass_key",
      catalogModelIds,
    });

    // Legacy builds wrote catalog models and mixed full-id keys alongside short slugs.
    const stale = JSON.parse(await readFile(configPath, "utf8"));
    stale.provider["fireworks-ai"].models = {
      ...stale.provider["fireworks-ai"].models,
      "accounts/fireworks/routers/glm-fast-latest": { name: "legacy full id" },
      "fireworks-ai/glm-fast-latest": { name: "legacy provider prefix" },
      "deepseek-v4-flash": { name: "stale catalog model" },
    };
    await writeFile(configPath, `${JSON.stringify(stale, null, 2)}\n`);

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fpk_test_firepass_key",
      effectiveApiKey: "fpk_test_firepass_key",
      catalogModelIds,
    });

    const models = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models;
    assert.deepEqual(Object.keys(models).sort(), [
      "glm-fast-latest",
      "glm-latest",
      "kimi-fast-latest",
    ]);
    assert.equal(models["accounts/fireworks/routers/glm-fast-latest"], undefined);
    assert.equal(models["fireworks-ai/glm-fast-latest"], undefined);
    assert.equal(models["deepseek-v4-flash"], undefined);
  });

  it("firepass re-on drops metered cost inherited from a previous row", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-firepass-cost-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    const catalogModelIds = ["accounts/fireworks/routers/glm-latest"];

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      catalogModelIds,
    });

    const withCost = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models["glm-latest"];
    assert.ok(withCost?.cost?.input, "standard key registers metered cost");

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fpk_test_firepass_key",
      effectiveApiKey: "fpk_test_firepass_key",
      catalogModelIds,
    });

    const entry = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models["glm-latest"];
    assert.equal(entry.cost, undefined, "firepass row carries no metered cost");
    assert.ok(entry.limit.context >= 1_000_000, "limits still resolved");
  });

  it("offline re-on collapses legacy provider-prefixed provider.models keys", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-offline-legacy-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      model: "fireworks-ai/glm-fast-latest",
      provider: {
        "fireworks-ai": {
          options: { apiKey: "fw_test_key_12345" },
          models: {
            "fireworks-ai/glm-fast-latest": { name: "legacy provider prefix" },
            "accounts/fireworks/routers/kimi-fast-latest": { name: "legacy full id" },
          },
        },
      },
    })}\n`);

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      catalogModelIds: [],
    });

    const models = JSON.parse(await readFile(configPath, "utf8")).provider["fireworks-ai"].models;
    assert.deepEqual(Object.keys(models).sort(), ["glm-fast-latest", "kimi-fast-latest"]);
    assert.equal(models["fireworks-ai/glm-fast-latest"], undefined);
    assert.equal(models["accounts/fireworks/routers/kimi-fast-latest"], undefined);
  });

  it("rebuilds router overrides offline instead of copying stale provider.models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-offline-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      model: "fireworks-ai/kimi-latest",
      provider: {
        "fireworks-ai": {
          options: { apiKey: "fw_test_key_12345" },
          models: {
            "kimi-latest": { name: "kimi-latest" },
            "glm-fast-latest": { name: "glm-fast-latest" },
          },
        },
      },
    })}\n`);

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      modelId: "kimi-latest",
      catalogModelIds: [],
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const models = config.provider["fireworks-ai"].models;
    assert.deepEqual(models["kimi-latest"].modalities, { input: ["text", "image"] });
    assert.equal(models["glm-fast-latest"].modalities, undefined);
    assert.equal(models["glm-fast-latest"].limit.context, 1_048_575);
    assert.equal(models["glm-fast-latest"].limit.output, 131_072);
    assert.equal(models["kimi-latest"].limit.context, 1_040_000);
  });

  it("requires inkling override when models.dev registry is unknown", () => {
    clearModelsDevFireworksRegistry();
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/inkling",
        shortId: "inkling",
        displayName: "Inkling",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([["accounts/fireworks/models/inkling", 1_048_576]]),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/inkling"), true);
      assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/glm-5p2"), false);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes provider overrides for catalog models absent from models.dev", async () => {
    setModelsDevFireworksRegistry([
      "accounts/fireworks/models/deepseek-v4-flash",
    ]);
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/inkling",
        shortId: "inkling",
        displayName: "Inkling",
        kind: "serverless",
      }],
      pricingById: new Map(),
      inputModalitiesById: new Map([["accounts/fireworks/models/inkling", ["text", "image"]]]),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([["accounts/fireworks/models/inkling", 1_048_576]]),
      supportsToolsById: new Map(),
    });
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-inkling-"));
      const configPath = path.join(home, "opencode.json");
      const dataDir = path.join(home, "data");
      await mkdir(dataDir, { recursive: true });

      await enableOpencodeFireworks({
        configPath,
        dataDir,
        apiKey: "fw_test_key_12345",
        effectiveApiKey: "fw_test_key_12345",
        modelId: "inkling",
        catalogModelIds: [
          "accounts/fireworks/models/inkling",
          "accounts/fireworks/models/deepseek-v4-flash",
        ],
      });

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.model, "fireworks-ai/inkling");
      const inkling = config.provider["fireworks-ai"].models.inkling;
      assert.equal(inkling.limit.context, 1_048_576);
      assert.equal(inkling.limit.output, 131_072);
      assert.deepEqual(inkling.modalities, { input: ["text", "image"] });
      assert.equal(config.provider["fireworks-ai"].models["deepseek-v4-flash"], undefined);
    } finally {
      clearModelsDevFireworksRegistry();
      setServerlessCatalogSnapshot(null);
    }
  });
});
