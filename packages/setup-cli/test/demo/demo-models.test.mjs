import test from "node:test";
import assert from "node:assert/strict";

import {
  demoModelCatalog,
  demoModelLabel,
  demoModelRates,
  demoFireworksPickerIdsFromCatalog,
  refreshDemoPickerFromServerlessCatalog,
  isAnthropicSlotModel,
  defaultLeftModel,
  defaultRightModel,
  demoSideDisplayLabel,
} from "../../lib/demo/demo-models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";

test("demoFireworksPickerIdsFromCatalog: keeps latest aliases, drops pinned glm-5p1", () => {
  const ids = demoFireworksPickerIdsFromCatalog([
    { id: "accounts/fireworks/models/glm-5p1", shortId: "glm-5p1", displayName: "GLM 5.1", kind: "serverless" },
    { id: "accounts/fireworks/models/glm-5p2", shortId: "glm-5p2", displayName: "GLM 5.2", kind: "serverless" },
    { id: "accounts/fireworks/routers/glm-latest", shortId: "glm-latest", displayName: "GLM Latest", kind: "serverless" },
    { id: "accounts/fireworks/routers/glm-fast-latest", shortId: "glm-fast-latest", displayName: "GLM Fast Latest", kind: "serverless" },
    { id: "accounts/fireworks/routers/glm-5p2-fast", shortId: "glm-5p2-fast", displayName: "GLM 5.2 Fast", kind: "serverless" },
  ]);
  assert.deepEqual(ids, ["firerouter", "glm-fast-latest", "glm-latest"]);
});

test("refreshDemoPickerFromServerlessCatalog: reads warmed snapshot", () => {
  setServerlessCatalogSnapshot({
    entries: [
      { id: "accounts/fireworks/routers/kimi-fast-latest", shortId: "kimi-fast-latest", displayName: "Kimi Fast Latest", kind: "serverless" },
    ],
    pricingById: new Map(),
    inputModalitiesById: new Map(),
    routerBaseModelById: new Map(),
    contextLengthById: new Map(),
    supportsToolsById: new Map(),
  });
  try {
    refreshDemoPickerFromServerlessCatalog();
    const catalog = demoModelCatalog();
    assert.ok(catalog.some((m) => m.id === "kimi-fast-latest"));
    assert.ok(!catalog.some((m) => m.id === "glm-5p1"));
  } finally {
    setServerlessCatalogSnapshot(null);
    refreshDemoPickerFromServerlessCatalog();
  }
});

test("demoModelCatalog: Anthropic slots first, then latest Fireworks picks", () => {
  const catalog = demoModelCatalog();
  const ids = catalog.map((m) => m.id);
  assert.equal(catalog[0].id, "opus");
  assert.ok(ids.includes("firerouter"));
  assert.ok(ids.includes("glm-fast-latest"));
  assert.ok(ids.includes("glm-latest"));
  assert.ok(ids.includes("kimi-fast-latest"));
  assert.ok(!ids.includes("glm-5p2-fast"));
  assert.ok(!ids.includes("kimi-k3-fast"));
  assert.ok(!ids.includes("deepseek-v4-flash"));
});

test("demoModelRates: resolves pricing for Fireworks, FireRouter, and Anthropic slots", () => {
  const fw = demoModelRates("glm-5p2-fast");
  assert.ok(fw);
  assert.ok(fw.inputPerMillion > 0);
  const fr = demoModelRates("firerouter");
  assert.ok(fr);
  const anth = demoModelRates("opus");
  assert.ok(anth);
  assert.match(anth.label, /via /);
  // Sonnet is native by default, so it prices off the Anthropic list table and
  // reads "(via Anthropic)" rather than repeating the model name.
  const sonnet = demoModelRates("sonnet");
  assert.ok(sonnet);
  assert.equal(sonnet.label, "Claude Sonnet (via Anthropic)");
  assert.equal(sonnet.inputPerMillion, 2);
  assert.equal(sonnet.outputPerMillion, 10);

  // Every Anthropic slot must price, whatever the mapping — a null here makes
  // resolveSideRates throw when that slot is picked in the demo.
  for (const slot of ["opus", "sonnet", "haiku", "fable"]) {
    const native = demoModelRates(slot, "fireworks", { [slot]: "claude-default" });
    assert.ok(native, `${slot} mapped to claude-default must resolve rates`);
    assert.ok(native.inputPerMillion > 0, `${slot} needs a real input rate`);
    assert.ok(demoModelRates(slot), `${slot} default mapping must resolve rates`);
    assert.ok(demoModelRates(slot, "firepass"), `${slot} firepass must resolve rates`);
  }
});

test("demoModelRates: uses live serverless catalog when warmed", () => {
  setServerlessCatalogSnapshot({
    entries: [],
    pricingById: new Map([
      ["accounts/fireworks/models/glm-5p2-fast", {
        slug: "glm-5p2-fast",
        label: "GLM 5.2 Fast",
        input: 0.55,
        cachedInput: 0.055,
        output: 2.19,
        tier: "fast",
        source: "https://fireworks.ai/pricing",
      }],
      ["accounts/fireworks/routers/firerouter", {
        slug: "firerouter",
        label: "FireRouter",
        input: 0.66,
        cachedInput: 0.066,
        output: 2.50,
        tier: "standard",
        source: "https://fireworks.ai/pricing",
      }],
    ]),
    inputModalitiesById: new Map(),
    routerBaseModelById: new Map(),
    contextLengthById: new Map(),
    supportsToolsById: new Map(),
  });
  try {
    const live = demoModelRates("glm-5p2-fast");
    assert.equal(live?.inputPerMillion, 0.55);
    assert.equal(live?.estimated, undefined);
    const router = demoModelRates("firerouter");
    assert.equal(router?.inputPerMillion, 0.66);
    assert.equal(router?.estimated, undefined);
  } finally {
    setServerlessCatalogSnapshot(null);
  }
});

test("demoModelRates: anthropic slot uses live mapping when provided", () => {
  const defaultRates = demoModelRates("opus");
  const mappedRates = demoModelRates("opus", "fireworks", { opus: "glm-fast-latest" });
  assert.ok(defaultRates);
  assert.ok(mappedRates);
  assert.notEqual(mappedRates.label, defaultRates.label);
});

test("defaults and display labels", () => {
  assert.equal(defaultLeftModel(), "opus");
  assert.equal(defaultRightModel(), "glm-fast-latest");
  assert.match(demoSideDisplayLabel("opus"), /^Anthropic · /);
  assert.match(demoSideDisplayLabel("glm-fast-latest"), /^Fireworks · /);
  assert.equal(demoModelLabel("opus"), "Claude Opus");
  assert.equal(isAnthropicSlotModel("fable"), true);
});
