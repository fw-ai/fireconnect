import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildPickerCatalogFromApiModels,
  buildServerlessCatalogSnapshot,
  fetchServerlessCatalogRaw,
  inputModalitiesFromModel,
  moneyToUsd,
  parseSkuPricing,
  SERVERLESS_CODING_USE_CASE,
  warmServerlessPricingCache,
} from "../../lib/fireworks/models.mjs";
import { organizeCatalogForDisplay } from "../../lib/fireworks/model-list.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";

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

  test("synthesizes kimi-latest and kimi-fast-latest when API exposes kimi-k2p7-code-fast", () => {
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
            usageIdentifier: "accounts/fireworks/routers/kimi-k2p7-code-fast",
            skuInfos: [
              { sku: "LLM input tokens (uncached)", amount: { units: "1", nanos: 900_000_000 } },
              { sku: "LLM output tokens", amount: { units: "8" } },
            ],
          },
        ],
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-k2p7-code-fast"));
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
    assert.ok(!ids.includes("accounts/fireworks/routers/kimi-k2p7-code-fast"));
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
    const entry = (shortId, kind) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
    });
    const sections = organizeCatalogForDisplay([
      entry("firerouter", "routers"),
      entry("glm-5p1", "models"),
      entry("glm-5p2", "models"),
      entry("glm-5p2-fast", "routers"),
      entry("glm-latest", "routers"),
      entry("glm-fast-latest", "routers"),
      entry("kimi-k2p6", "models"),
      entry("kimi-k2p7-code", "models"),
      entry("kimi-k2p7-code-fast", "routers"),
      entry("kimi-latest", "routers"),
      entry("kimi-fast-latest", "routers"),
      entry("minimax-m2p7", "models"),
      entry("minimax-m3", "models"),
      entry("minimax-latest", "routers"),
    ]);
    const idsBySection = Object.fromEntries(sections.map((section) => [
      section.title,
      section.entries.map(({ shortId }) => shortId),
    ]));

    assert.deepEqual(idsBySection, {
      "SMART ROUTER": ["firerouter"],
      "LATEST ROUTERS": ["glm-latest", "kimi-latest", "minimax-latest"],
      "FAST ROUTERS": ["glm-fast-latest", "kimi-fast-latest"],
      "INDIVIDUAL MODELS": ["glm-5p2", "kimi-k2p7-code", "minimax-m3"],
    });
  });
});
