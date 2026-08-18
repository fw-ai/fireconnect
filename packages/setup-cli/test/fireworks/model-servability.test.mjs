import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertRequestedModelsServable,
  assertRequestedModelServable,
  isModelIdValidationApplicable,
} from "../../lib/fireworks/model-servability.mjs";
import { cacheServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../helpers.mjs";

// Each subtest must start cache-clean: the TTL-aware loader persists the mocked
// fetch on success, so a leftover fresh cache would serve a later subtest
// instead of exercising the fetch path.
function clearCatalogCache() {
  cacheServerlessCatalogSnapshot(null);
}

describe("model-servability isModelIdValidationApplicable", () => {
  it("is false for empty / no model", () => {
    assert.equal(isModelIdValidationApplicable(""), false);
    assert.equal(isModelIdValidationApplicable(undefined), false);
  });

  it("is false for firerouter gateway ids", () => {
    assert.equal(isModelIdValidationApplicable("firerouter"), false);
    assert.equal(isModelIdValidationApplicable("firerouter/balanced"), false);
  });

  it("is false for custom deployment ids", () => {
    assert.equal(
      isModelIdValidationApplicable("accounts/ahmadshahzad/deployments/ub9lvh50"),
      false,
    );
  });

  it("is true for ordinary slugs and full ids", () => {
    assert.equal(isModelIdValidationApplicable("glm-5p2"), true);
    assert.equal(isModelIdValidationApplicable("not-a-real-model"), true);
    assert.equal(
      isModelIdValidationApplicable("accounts/fireworks/models/glm-5p2"),
      true,
    );
  });
});

describe("model-servability assertRequestedModelsServable", () => {
  // Catalog mock containing glm-5p2 (buildServerlessCatalogSnapshot synthesizes
  // the glm-latest alias from ROUTER_SPEC_ALIASES).
  function withFetchMock(models, fn) {
    clearCatalogCache();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ models }),
    });
    return fn().finally(() => {
      globalThis.fetch = previousFetch;
    });
  }

  it("throws for an id not in the catalog", async () => {
    await withFetchMock([mockServerlessModel()], async () => {
      await assert.rejects(
        () => assertRequestedModelServable("not-a-real-model", {
          apiKey: "fw_test_key",
          keyType: "fireworks",
        }),
        /not available on Fireworks/,
      );
    });
  });

  it("allows a pinned version present in the catalog", async () => {
    await withFetchMock([mockServerlessModel()], async () => {
      await assert.doesNotReject(() =>
        assertRequestedModelServable("glm-5p2", {
          apiKey: "fw_test_key",
          keyType: "fireworks",
        }),
      );
    });
  });

  it("allows a -latest alias resolved in the catalog", async () => {
    await withFetchMock([mockServerlessModel()], async () => {
      await assert.doesNotReject(() =>
        assertRequestedModelServable("glm-latest", {
          apiKey: "fw_test_key",
          keyType: "fireworks",
        }),
      );
    });
  });

  it("matches by full accounts/fireworks resource id", async () => {
    await withFetchMock([mockServerlessModel()], async () => {
      await assert.doesNotReject(() =>
        assertRequestedModelServable("accounts/fireworks/models/glm-5p2", {
          apiKey: "fw_test_key",
          keyType: "fireworks",
        }),
      );
    });
  });

  it("always allows firerouter and custom deployments without fetching", async () => {
    clearCatalogCache();
    let fetched = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({ models: [] }) }; };
    try {
      await assertRequestedModelServable("firerouter", { apiKey: "fw_test_key", keyType: "fireworks" });
      await assertRequestedModelServable("accounts/u/deployments/x", { apiKey: "fw_test_key", keyType: "fireworks" });
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("skips validation when no model is selected", async () => {
    await assert.doesNotReject(() =>
      assertRequestedModelsServable(["", undefined], { apiKey: "fw_test_key", keyType: "fireworks" }),
    );
  });

  it("skips validation for Fire Pass keys", async () => {
    clearCatalogCache();
    let fetched = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({ models: [] }) }; };
    try {
      // A bogus model with a Fire Pass key must not throw (can't enumerate).
      await assertRequestedModelServable("not-a-real-model", { apiKey: "fpk_test", keyType: "firepass" });
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("skips validation when the catalog fetch fails (offline)", async () => {
    clearCatalogCache();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    try {
      await assertRequestedModelServable("not-a-real-model", { apiKey: "fw_test_key", keyType: "fireworks" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("validates every applicable id in one fetch", async () => {
    clearCatalogCache();
    let fetchCount = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return { ok: true, json: async () => ({ models: [mockServerlessModel()] }) };
    };
    try {
      // glm-5p2 + glm-latest are in the catalog; the bogus one must surface.
      await assert.rejects(
        () => assertRequestedModelsServable(
          ["glm-5p2", "glm-latest", "firerouter", "", "not-a-real-model"],
          { apiKey: "fw_test_key", keyType: "fireworks" },
        ),
        /not available on Fireworks/,
      );
      assert.equal(fetchCount, 1, "catalog fetched once for the whole batch");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
