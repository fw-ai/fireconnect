import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  autoCatalogEntry,
  buildPickerCatalogFromApiModels,
  buildServerlessCatalogSnapshot,
  fetchServerlessCatalogRaw,
  inputModalitiesFromModel,
  loadServerlessCatalog,
  moneyToUsd,
  parseSkuPricing,
  SERVERLESS_CODING_USE_CASE,
  warmServerlessPricingCache,
} from "../../lib/fireworks/models.mjs";
import {
  catalogWithAutoEntry,
  formatCatalogUpdatedAt,
  organizeCatalogForDisplay,
} from "../../lib/fireworks/model-list.mjs";
import {
  cacheServerlessCatalogSnapshot,
  readCatalogCache,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";

import { mockServerlessModel } from "../helpers.mjs";

describe("fireworks-models serverless catalog", () => {  test("fetchServerlessCatalogRaw uses the serverless models API with coding filter", async () => {
    const previousFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          models: [mockServerlessModel()],
        }),
      };
    };

    try {
      const models = await fetchServerlessCatalogRaw("fw_test_key");
      assert.equal(models.length, 1);
      assert.equal(models[0].name, "accounts/fireworks/models/glm-5p2");
      const parsed = new URL(requestedUrl);
      assert.equal(parsed.pathname, "/v1/serverless/models");
      assert.equal(parsed.searchParams.get("format"), "nested");
      assert.equal(parsed.searchParams.get("use_cases"), SERVERLESS_CODING_USE_CASE);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  /**
   * Run `fn` against a throwaway HOME (so the catalog cache file is isolated)
   * seeded with a fresh single-entry `stale` snapshot.
   */
  async function withSeededCatalogCache(fetchImpl, fn) {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-catalog-refresh-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const seededAt = cacheServerlessCatalogSnapshot({
        entries: [{
          id: "accounts/fireworks/models/stale",
          shortId: "stale",
          displayName: "Stale",
          kind: "serverless",
        }],
        pricingById: new Map(),
        inputModalitiesById: new Map(),
        routerBaseModelById: new Map(),
        contextLengthById: new Map(),
        supportsToolsById: new Map(),
      });
      await fn(seededAt);
    } finally {
      globalThis.fetch = previousFetch;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("loadServerlessCatalog refresh ignores a fresh cache and refetches", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return {
        ok: true,
        json: async () => ({ models: [mockServerlessModel()] }),
      };
    };

    await withSeededCatalogCache(fetchImpl, async (seededAt) => {
      const cached = await loadServerlessCatalog({ apiKey: "fw_test_key" });
      assert.equal(cached.source, "cache");
      assert.equal(cached.updatedAt, seededAt);
      assert.equal(fetches, 0);
      assert.equal(cached.catalog[0].shortId, "stale");

      const refreshed = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(refreshed.source, "network");
      assert.equal(refreshed.updatedAt, readCatalogCache()?.cachedAt);
      assert.equal(fetches, 1);
      assert.ok(refreshed.catalog.some((entry) => entry.shortId === "glm-5p2"));
      assert.equal(refreshed.catalog.some((entry) => entry.shortId === "stale"), false);
      assert.ok(
        readCatalogCache()?.snapshot.entries.some((entry) => entry.shortId === "glm-5p2"),
        "refetch replaces the persisted snapshot",
      );
    });
  });

  // An offline refresh must not leave the user worse off than before: the old
  // snapshot stays on disk so later commands (harness `on`, the picker) still
  // have a catalog instead of hard-failing as a cold start.
  test("loadServerlessCatalog refresh keeps the cached snapshot when the fetch fails", async () => {
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };

    await withSeededCatalogCache(fetchImpl, async (seededAt) => {
      const result = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(result.source, "stale");
      assert.equal(result.updatedAt, seededAt);
      assert.equal(result.catalog[0].shortId, "stale");
      assert.equal(
        readCatalogCache()?.snapshot.entries[0].shortId,
        "stale",
        "a failed refresh must not delete the cache file",
      );
    });
  });

  test("formatCatalogUpdatedAt uses the local timezone and includes its abbreviation", () => {
    assert.equal(
      formatCatalogUpdatedAt(Date.UTC(2026, 7, 29, 20, 28), "America/Los_Angeles"),
      "Aug 29, 2026, 1:28 PM PDT",
    );
    assert.equal(formatCatalogUpdatedAt(null), "bundled with FireConnect");
  });

  test("buildPickerCatalogFromApiModels derives routers from usage_identifier", () => {
    const catalog = buildPickerCatalogFromApiModels([
      mockServerlessModel(),
      mockServerlessModel({
        name: "accounts/fireworks/models/embedding-only",
        displayName: "Embedding Only",
        serverlessModes: [],
      }),
    ]);

    const ids = catalog.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/models/glm-5p2"));
    assert.ok(ids.includes("accounts/fireworks/routers/glm-5p2-fast"));
    assert.ok(ids.includes("accounts/fireworks/routers/glm-latest"));
    assert.equal(ids.filter((id) => id.includes("/models/")).length, 2);
  });

  test("buildPickerCatalogFromApiModels adds documented US-only routers", () => {
    const catalog = buildPickerCatalogFromApiModels([
      mockServerlessModel(),
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/glm-5p3-flash",
        displayName: "GLM 5.3 Flash",
        serverlessModes: [],
      }),
    ]);
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));

    assert.equal(
      byId.get("accounts/fireworks/routers/glm-5p2-fast-us")?.displayName,
      "GLM 5.2 Fast (US)",
    );
    assert.equal(
      byId.get("accounts/fireworks/routers/kimi-k3-us")?.displayName,
      "Kimi K3 (US)",
    );
    assert.equal(
      byId.get("accounts/fireworks/routers/glm-5p3-flash-us")?.displayName,
      "GLM 5.3 Flash (US)",
    );

    const sections = organizeCatalogForDisplay(catalog);
    const usOnly = sections.find((section) => section.title === "US-ONLY ROUTERS");
    assert.deepEqual(
      usOnly?.entries.map((entry) => entry.shortId),
      ["glm-5p2-fast-us", "glm-5p3-flash-us", "kimi-k3-us"],
    );
  });

  test("buildServerlessCatalogSnapshot captures API pricing and modalities", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        supportsImageInput: true,
      }),
    ]);

    assert.deepEqual(snapshot.inputModalitiesById.get("accounts/fireworks/models/glm-5p2"), ["text", "image"]);
    const pricing = snapshot.pricingById.get("accounts/fireworks/routers/glm-5p2-fast");
    assert.equal(pricing?.tier, "fast");
    assert.equal(pricing?.input, 2.1);
    assert.equal(pricing?.output, 6.6);
  });

  test("parseSkuPricing reads nested money amounts", () => {
    assert.equal(moneyToUsd({ units: "1", nanos: 500_000_000 }), 1.5);
    assert.deepEqual(parseSkuPricing([
      { sku: "LLM input tokens (uncached)", amount: { nanos: 950_000_000 } },
      { sku: "LLM input tokens (cached)", amount: { nanos: 160_000_000 } },
      { sku: "LLM output tokens", amount: { units: "4" } },
    ]), { input: 0.95, cachedInput: 0.16, output: 4 });
  });

  test("inputModalitiesFromModel prefers explicit API modalities", () => {
    assert.deepEqual(inputModalitiesFromModel({ input_modalities: ["text", "image"] }), ["text", "image"]);
    assert.deepEqual(inputModalitiesFromModel({ supportsImageInput: true }), ["text", "image"]);
  });

  test("snapshot routerBaseModelById uses model id when name is absent", () => {
    const snapshot = buildServerlessCatalogSnapshot([{
      id: "accounts/fireworks/models/glm-5p2",
      serverlessModes: [{
        usageIdentifier: "accounts/fireworks/routers/glm-5p2-fast",
      }],
    }]);
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/glm-5p2-fast"),
      "accounts/fireworks/models/glm-5p2",
    );
  });

  test("synthesizes kimi-latest routers from kimi-k3 when API exposes Kimi K3", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [],
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-latest"));
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-fast-latest"));
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/kimi-latest"),
      "accounts/fireworks/models/kimi-k3",
    );
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/kimi-fast-latest"),
      "accounts/fireworks/models/kimi-k3",
    );
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-fast-latest"), undefined);
    const kimiLatest = snapshot.entries.find((entry) => entry.shortId === "kimi-latest");
    const kimiFastLatest = snapshot.entries.find((entry) => entry.shortId === "kimi-fast-latest");
    assert.equal(kimiLatest?.displayName, "Kimi K3 (Latest)");
    assert.equal(kimiFastLatest?.displayName, "Kimi K3 Fast (Latest)");
  });

  test("preserves turbo router display names after catalog refresh", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k2p6",
        displayName: "Kimi K2.6",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k2p6/serverlessModes/default",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "0", nanos: 950_000_000 } },
              { sku: "LLM input tokens (cached)", amount: { nanos: 160_000_000 } },
              { sku: "LLM output tokens", amount: { units: "4" } },
            ],
          },
          {
            name: "accounts/fireworks/models/kimi-k2p6/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-k2p6-turbo",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "2" } },
              { sku: "LLM input tokens (cached)", amount: { nanos: 300_000_000 } },
              { sku: "LLM output tokens", amount: { units: "8" } },
            ],
          },
        ],
      }),
    ]);

    const turbo = snapshot.entries.find((entry) => entry.shortId === "kimi-k2p6-turbo");
    assert.equal(turbo?.displayName, "Kimi K2.6 Turbo");
    assert.equal(turbo?.baseModelId, "accounts/fireworks/models/kimi-k2p6");
  });

  test("kimi-k3 ignores priority mode for base model and -latest alias pricing", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-k3-fast",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "3" } },
              { sku: "LLM input tokens (cached)", amount: { nanos: 300_000_000 } },
              { sku: "LLM output tokens", amount: { units: "15" } },
            ],
          },
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/priority",
            serviceTier: "priority",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "3", nanos: 750_000_000 } },
              { sku: "LLM input tokens (cached)", amount: { nanos: 375_000_000 } },
              { sku: "LLM output tokens", amount: { units: "18", nanos: 750_000_000 } },
            ],
          },
        ],
      }),
    ]);

    assert.equal(snapshot.pricingById.get("accounts/fireworks/models/kimi-k3"), undefined);

    const fastRouterPricing = snapshot.pricingById.get("accounts/fireworks/routers/kimi-k3-fast");
    assert.equal(fastRouterPricing?.tier, "fast");
    assert.equal(fastRouterPricing?.input, 3);
    assert.equal(fastRouterPricing?.output, 15);

    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-latest"), undefined);

    const fastLatestPricing = snapshot.pricingById.get("accounts/fireworks/routers/kimi-fast-latest");
    assert.equal(fastLatestPricing?.tier, "fast");
    assert.equal(fastLatestPricing?.input, 3);
  });

  test("does not pick fast or priority mode for base model pricing when default is absent", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-k3-fast",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "3" } },
              { sku: "LLM output tokens", amount: { units: "15" } },
            ],
          },
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/priority",
            serviceTier: "priority",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "3", nanos: 750_000_000 } },
              { sku: "LLM output tokens", amount: { units: "18", nanos: 750_000_000 } },
            ],
          },
        ],
      }),
    ]);

    const modelPricing = snapshot.pricingById.get("accounts/fireworks/models/kimi-k3");
    assert.equal(modelPricing, undefined);
  });

  test("prefers default mode over priority for base model pricing", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/default",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { nanos: 950_000_000 } },
              { sku: "LLM output tokens", amount: { units: "4" } },
            ],
          },
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/priority",
            serviceTier: "priority",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "3", nanos: 750_000_000 } },
              { sku: "LLM output tokens", amount: { units: "18", nanos: 750_000_000 } },
            ],
          },
        ],
      }),
    ]);

    const modelPricing = snapshot.pricingById.get("accounts/fireworks/models/kimi-k3");
    assert.equal(modelPricing?.tier, "standard");
    assert.equal(modelPricing?.input, 0.95);
    assert.equal(modelPricing?.output, 4);
  });

  test("leaves base model unpriced when only fast mode exists", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [{
          name: "accounts/fireworks/models/kimi-k3/serverlessModes/fast",
          usageIdentifier: "accounts/fireworks/routers/kimi-k3-fast",
          skuInfos: [
            { sku: "LLM input tokens (uncached)", amount: { units: "3" } },
            { sku: "LLM output tokens", amount: { units: "15" } },
          ],
        }],
      }),
    ]);

    assert.equal(snapshot.pricingById.get("accounts/fireworks/models/kimi-k3"), undefined);
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-k3-fast")?.tier, "fast");
  });

  test("does not attach standard-tier model pricing to synthesized fast-latest routers", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3-fast",
        displayName: "Kimi K3 Fast",
        serverlessModes: [{
          name: "accounts/fireworks/models/kimi-k3-fast/serverlessModes/default",
          skuInfos: [
            { sku: "LLM input tokens (uncached)", amount: { nanos: 950_000_000 } },
            { sku: "LLM output tokens", amount: { units: "4" } },
          ],
        }],
      }),
    ]);
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-fast-latest"), undefined);
  });

  test("synthesizes kimi-latest and kimi-fast-latest when API exposes kimi-k3-fast", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/default",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { nanos: 950_000_000 } },
              { sku: "LLM output tokens", amount: { units: "4" } },
            ],
          },
          {
            name: "accounts/fireworks/models/kimi-k3/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-k3-fast",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "1", nanos: 900_000_000 } },
              { sku: "LLM output tokens", amount: { units: "8" } },
            ],
          },
        ],
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-k3-fast"));
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-fast-latest"));
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-latest"));
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-fast-latest")?.tier, "fast");
  });

  test("synthesizes minimax-latest and qwen-plus-latest", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/minimax-m2p7",
        displayName: "MiniMax 2.7",
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/minimax-m3",
        displayName: "MiniMax M3",
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/qwen3p6-plus",
        displayName: "Qwen 3.6 Plus",
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/qwen3p7-plus",
        displayName: "Qwen 3.7 Plus",
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/routers/minimax-latest"));
    assert.ok(ids.includes("accounts/fireworks/routers/qwen-plus-latest"));
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/minimax-latest"),
      "accounts/fireworks/models/minimax-m3",
    );
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/qwen-plus-latest"),
      "accounts/fireworks/models/qwen3p7-plus",
    );
  });

  test("synthesizes deepseek-flash-latest and deepseek-pro-latest", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash (0731)",
        serverlessModes: [],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/deepseek-v4-pro-0813",
        displayName: "DeepSeek V4 Pro (0813)",
        serverlessModes: [],
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/routers/deepseek-flash-latest"));
    assert.ok(ids.includes("accounts/fireworks/routers/deepseek-pro-latest"));
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/deepseek-flash-latest"),
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/deepseek-pro-latest"),
      "accounts/fireworks/models/deepseek-v4-pro-0813",
    );
  });

  test("exposes kimi-fast-latest directly when API uses it as usage_identifier", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k2p7-code",
        displayName: "Kimi K2.7 Code",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/default",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { nanos: 950_000_000 } },
              { sku: "LLM output tokens", amount: { units: "4" } },
            ],
          },
          {
            name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/fast",
            usageIdentifier: "accounts/fireworks/routers/kimi-fast-latest",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "1", nanos: 900_000_000 } },
              { sku: "LLM output tokens", amount: { units: "8" } },
            ],
          },
        ],
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-fast-latest"));
    assert.ok(!ids.includes("accounts/fireworks/routers/kimi-k3-fast"));
    assert.equal(snapshot.routerBaseModelById.get("accounts/fireworks/routers/kimi-fast-latest"),
      "accounts/fireworks/models/kimi-k2p7-code");
  });

  test("fast alias does not inherit standard pricing via -fast strip fallback", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k2p7-code",
        displayName: "Kimi K2.7 Code",
        serverlessModes: [
          {
            name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/default",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { nanos: 950_000_000 } },
              { sku: "LLM output tokens", amount: { units: "4" } },
            ],
          },
        ],
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    // The alias still surfaces because the base model is listed...
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-fast-latest"));
    // ...but must not carry the non-fast base model's standard pricing.
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-fast-latest"), undefined);
    // The standard alias legitimately inherits standard pricing.
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-latest")?.tier, "standard");
  });

  test("warmServerlessPricingCache never sends a non-Fireworks key to the gateway", async () => {
    const previousFetch = globalThis.fetch;
    const requestedKeys = [];
    globalThis.fetch = async (_url, options) => {
      requestedKeys.push(options?.headers?.Authorization ?? "");
      return { ok: true, json: async () => ({ models: [] }) };
    };
    try {
      await warmServerlessPricingCache("sk-ant-not-a-fireworks-key");
      await warmServerlessPricingCache("fpk_firepass_key_0000000000000000");
      assert.deepEqual(requestedKeys, [], "must not call the gateway with a foreign or Fire Pass key");

      await warmServerlessPricingCache("fw_real_fireworks_key");
      assert.deepEqual(requestedKeys, ["Bearer fw_real_fireworks_key"]);
    } finally {
      globalThis.fetch = previousFetch;
      setServerlessCatalogSnapshot(null);
    }
  });

  test("model list groups aliases and keeps only the newest pinned family versions", () => {
    const entry = (shortId, kind, baseModelId = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
    });
    const sections = organizeCatalogForDisplay([
      entry("firerouter", "routers"),
      autoCatalogEntry(),
      entry("glm-5p1", "models"),
      entry("glm-5p2", "models"),
      entry("glm-5p2-fast", "routers"),
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("glm-fast-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("kimi-k2p6", "models"),
      entry("kimi-k2p7-code", "models"),
      entry("kimi-k3", "models"),
      entry("kimi-k3-fast", "routers"),
      entry("kimi-latest", "routers", "accounts/fireworks/models/kimi-k3"),
      entry("kimi-fast-latest", "routers", "accounts/fireworks/models/kimi-k3"),
      entry("minimax-m2p7", "models"),
      entry("minimax-m3", "models"),
      entry("minimax-latest", "routers", "accounts/fireworks/models/minimax-m3"),
    ]);
    const idsBySection = Object.fromEntries(sections.map((section) => [
      section.title,
      section.entries.map(({ shortId }) => shortId),
    ]));

    assert.deepEqual(idsBySection, {
      // auto leads the section so the default recommendation is listed first.
      "SMART ROUTERS": ["auto", "firerouter"],
      "LATEST ROUTERS": ["glm-latest", "kimi-latest", "minimax-latest"],
      "FAST ROUTERS": ["glm-fast-latest", "kimi-fast-latest"],
      "INDIVIDUAL MODELS": ["glm-5p2", "kimi-k3", "minimax-m3"],
    });
  });

  test("model list synthesizes the auto rows, except on Fire Pass keys", () => {
    const catalog = [{
      id: "accounts/fireworks/routers/glm-latest",
      shortId: "glm-latest",
      displayName: "GLM 5.2 (Latest)",
      kind: "serverless",
    }];

    const listed = catalogWithAutoEntry(catalog, "fireworks");
    assert.deepEqual(listed.map((e) => e.shortId), ["auto", "auto-instant", "glm-latest"]);
    assert.equal(listed[0].displayName, "Auto");
    assert.equal(listed[1].displayName, "Auto Instant");

    assert.deepEqual(
      catalogWithAutoEntry(catalog, "firepass").map((e) => e.shortId),
      ["glm-latest"],
    );
    // A gateway-supplied auto row must not be duplicated by the synthesized one,
    // and it must not suppress the other auto routers either.
    const withGatewayRow = [autoCatalogEntry(), ...catalog];
    assert.deepEqual(
      catalogWithAutoEntry(withGatewayRow, "fireworks").map((e) => e.shortId),
      ["auto-instant", "auto", "glm-latest"],
    );
    const withAllGatewayRows = [autoCatalogEntry(), autoCatalogEntry("auto-instant"), ...catalog];
    assert.equal(catalogWithAutoEntry(withAllGatewayRows, "fireworks"), withAllGatewayRows);
  });

  test("individual models list the newest version of every catalog family", () => {
    const entry = (shortId, kind, baseModelId = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
    });
    const sections = organizeCatalogForDisplay([
      entry("deepseek-flash-latest", "routers", "accounts/fireworks/models/deepseek-v4-flash-0731"),
      entry("deepseek-pro-latest", "routers", "accounts/fireworks/models/deepseek-v4-pro-0813"),
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("deepseek-v4-flash-0731", "models"),
      entry("deepseek-v4-pro-0813", "models"),
      // Versioned flash with no base-model id: collapsed by the deepseek-flash
      // family alias, so it must not reappear.
      entry("deepseek-v4-flash", "models"),
      entry("glm-5p2", "models"),
      // Standalone model with no -latest alias: still listed, since harnesses
      // can be pinned to it.
      entry("gpt-oss-120b", "models"),
    ]);
    const individual = sections.find((section) => section.title === "INDIVIDUAL MODELS")?.entries
      .map(({ shortId }) => shortId);

    assert.deepEqual(individual, [
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro-0813",
      "glm-5p2",
      "gpt-oss-120b",
    ]);
  });

  test("a -latest router pinned to an older version cannot hide a newer model", () => {
    const entry = (shortId, kind, baseModelId = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
    });
    // glm-latest still resolves to 5p2 while the catalog already serves 5p3 —
    // the state a stale ROUTER_SPEC_ALIASES entry leaves behind.
    const sections = organizeCatalogForDisplay([
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("glm-5p2", "models"),
      entry("glm-5p3", "models"),
      // Family the CLI has never seen, with no alias of its own.
      entry("newfamily-2p1", "models"),
      entry("newfamily-3", "models"),
    ]);
    const individual = sections.find((section) => section.title === "INDIVIDUAL MODELS")?.entries
      .map(({ shortId }) => shortId);

    assert.deepEqual(individual, ["glm-5p3", "newfamily-3"]);
  });

  test("a -flash-latest alias keeps Flash a family of its own", () => {
    const entry = (shortId, kind, baseModelId = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
    });
    // Without glm-flash-latest, "glm-flash" prefix-collapses into "glm" and the
    // Flash model loses to the higher-versioned sibling.
    const withoutAlias = organizeCatalogForDisplay([
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p3"),
      entry("glm-5p3", "models"),
      entry("glm-5p2-flash", "models"),
    ]);
    assert.deepEqual(
      withoutAlias.find((s) => s.title === "INDIVIDUAL MODELS")?.entries.map((e) => e.shortId),
      ["glm-5p3"],
    );

    const withAlias = organizeCatalogForDisplay([
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p3"),
      entry("glm-flash-latest", "routers", "accounts/fireworks/models/glm-5p2-flash"),
      entry("glm-5p2", "models"),
      entry("glm-5p3", "models"),
      entry("glm-5p2-flash", "models"),
    ]);
    const bySection = Object.fromEntries(withAlias.map((s) => [
      s.title,
      s.entries.map((e) => e.shortId),
    ]));
    assert.deepEqual(bySection["LATEST ROUTERS"], ["glm-flash-latest", "glm-latest"]);
    // Flash is a distinct model, not a speed tier: it must not land in FAST ROUTERS.
    assert.equal(bySection["FAST ROUTERS"], undefined);
    assert.deepEqual(bySection["INDIVIDUAL MODELS"], ["glm-5p2-flash", "glm-5p3"]);
  });
});
