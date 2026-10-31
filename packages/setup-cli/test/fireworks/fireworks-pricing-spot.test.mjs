import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupFireworksPricing } from "../../lib/fireworks/pricing.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";

const KIMI = "accounts/fireworks/models/kimi-k3";
const KIMI_SPOT_ROUTER = "accounts/fireworks/routers/kimi-k3-spot";

// Same row shape as test/helpers.mjs mockServerlessModel, inlined so this spec
// loads only the pricing and catalog modules.
function mockServerlessModel(overrides = {}) {
  return {
    object: "model",
    context_length: 1_048_576,
    input_modalities: ["text"],
    ...overrides,
  };
}

function skuRows(input, cached, output) {
  return [
    { sku: "LLM input tokens (uncached)", amount: String(input), unit: "1M tokens" },
    { sku: "LLM input tokens (cached)", amount: String(cached), unit: "1M tokens" },
    { sku: "LLM output tokens", amount: String(output), unit: "1M tokens" },
  ];
}

// The flat catalog API returns one row per (model, serverless_mode) pair. The
// spot row carries the base model's own id, plus the spot router as its
// usage_identifier, and the discounted spot rates.
function standardRow() {
  return mockServerlessModel({
    id: KIMI,
    display_name: "Kimi K3",
    serverless_mode: "standard",
    pricing: skuRows(3.0, 0.3, 15.0),
  });
}

function spotRow() {
  return mockServerlessModel({
    id: KIMI,
    display_name: "Kimi K3",
    serverless_mode: "spot",
    usage_identifier: KIMI_SPOT_ROUTER,
    pricing: skuRows(2.1, 0.21, 10.5),
  });
}

function withCatalog(rows, body) {
  setServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(rows));
  try {
    body();
  } finally {
    setServerlessCatalogSnapshot(null);
  }
}

describe("fireworks-pricing: spot rows never price the standard model id", () => {
  for (const [order, rows] of [
    ["standard row first", () => [standardRow(), spotRow()]],
    ["spot row first", () => [spotRow(), standardRow()]],
  ]) {
    it(`prices kimi-k3 at the standard rates (${order})`, () => {
      withCatalog(rows(), () => {
        for (const ref of ["kimi-k3", KIMI]) {
          const pricing = lookupFireworksPricing(ref);
          assert.equal(pricing?.input, 3.0, `${ref} input`);
          assert.equal(pricing?.cachedInput, 0.3, `${ref} cached input`);
          assert.equal(pricing?.output, 15.0, `${ref} output`);
          assert.equal(pricing?.tier, "standard", `${ref} tier`);
        }
      });
    });

    it(`prices the spot router at the spot rates, tagged spot (${order})`, () => {
      withCatalog(rows(), () => {
        const pricing = lookupFireworksPricing(KIMI_SPOT_ROUTER);
        assert.equal(pricing?.input, 2.1);
        assert.equal(pricing?.cachedInput, 0.21);
        assert.equal(pricing?.output, 10.5);
        assert.equal(pricing?.tier, "spot");
      });
    });
  }

  it("treats any other non-standard mode the same way (synthetic rates)", () => {
    const ultrafastRouter = "accounts/fireworks/routers/kimi-k3-ultrafast";
    const ultrafastRow = mockServerlessModel({
      id: KIMI,
      display_name: "Kimi K3",
      serverless_mode: "ultrafast",
      usage_identifier: ultrafastRouter,
      pricing: skuRows(6.0, 0.6, 30.0),
    });
    withCatalog([standardRow(), ultrafastRow], () => {
      assert.equal(lookupFireworksPricing(KIMI)?.input, 3.0);
      assert.equal(lookupFireworksPricing(KIMI)?.output, 15.0);
      assert.equal(lookupFireworksPricing(ultrafastRouter)?.input, 6.0);
    });
  });

  it("does not let a catalog with only a spot row price the base model id", () => {
    withCatalog([spotRow()], () => {
      // No standard row was reported, so the static spec table is the only
      // honest source for the standard rate.
      const pricing = lookupFireworksPricing(KIMI);
      assert.equal(pricing?.input, 3.0);
      assert.equal(pricing?.output, 15.0);
    });
  });
});

// kimi-k3's standard rates equal its static spec, so the cases above cannot tell
// "read from the catalog's standard row" from "fell back to the static spec".
// This model has no static spec: a price for it can only come from the rows.
describe("fireworks-pricing: spot rows with a model that has no static spec", () => {
  const DEMO = "accounts/fireworks/models/spot-demo-1";
  const DEMO_SPOT_ROUTER = "accounts/fireworks/routers/spot-demo-1-spot";
  const DEMO_LATEST = "accounts/fireworks/routers/spot-demo-latest";

  function demoStandardRow() {
    return mockServerlessModel({
      id: DEMO,
      display_name: "Spot Demo 1",
      serverless_mode: "standard",
      aliases: [DEMO_LATEST],
      pricing: skuRows(4.0, 0.4, 20.0),
    });
  }

  function demoSpotRow() {
    return mockServerlessModel({
      id: DEMO,
      display_name: "Spot Demo 1",
      serverless_mode: "spot",
      usage_identifier: DEMO_SPOT_ROUTER,
      pricing: skuRows(2.8, 0.28, 14.0),
    });
  }

  for (const [order, rows] of [
    ["standard row first", () => [demoStandardRow(), demoSpotRow()]],
    ["spot row first", () => [demoSpotRow(), demoStandardRow()]],
  ]) {
    it(`prices the model and its -latest alias from the standard row (${order})`, () => {
      withCatalog(rows(), () => {
        for (const ref of [DEMO, DEMO_LATEST]) {
          const pricing = lookupFireworksPricing(ref);
          assert.equal(pricing?.input, 4.0, `${ref} input`);
          assert.equal(pricing?.cachedInput, 0.4, `${ref} cached input`);
          assert.equal(pricing?.output, 20.0, `${ref} output`);
          assert.equal(pricing?.tier, "standard", `${ref} tier`);
        }
      });
    });
  }

  it("has no price for the bare model id when only the spot row was reported", () => {
    withCatalog([demoSpotRow()], () => {
      assert.equal(lookupFireworksPricing(DEMO), null);
      assert.equal(lookupFireworksPricing(DEMO_SPOT_ROUTER)?.input, 2.8);
    });
  });
});
