import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planCatalogRefresh } from "../../lib/harness/catalog-refresh.mjs";

describe("planCatalogRefresh", () => {
  it("prunes delisted ids and adds newly served ones", () => {
    const plan = planCatalogRefresh({
      currentIds: ["kimi-latest", "delisted-model"],
      freshIds: ["kimi-latest", "glm-latest"],
    });
    assert.deepEqual(plan.kept, ["kimi-latest"]);
    assert.deepEqual(plan.pruned, ["delisted-model"]);
    assert.deepEqual(plan.added, ["glm-latest"]);
  });

  it("keeps unserved ids the caller exempts (auto mix, firerouter paths)", () => {
    const plan = planCatalogRefresh({
      currentIds: ["auto", "firerouter/astra", "gone"],
      freshIds: ["kimi-latest"],
      keepUnserved: (id) => id === "auto" || id.startsWith("firerouter"),
    });
    assert.deepEqual(plan.kept, ["auto", "firerouter/astra"]);
    assert.deepEqual(plan.pruned, ["gone"]);
    assert.deepEqual(plan.added, ["kimi-latest"]);
  });

  it("is idempotent: a refresh plan over the refreshed state is a no-op", () => {
    const first = planCatalogRefresh({
      currentIds: ["a", "delisted"],
      freshIds: ["a", "b"],
    });
    const after = [...first.kept, ...first.added];
    const second = planCatalogRefresh({ currentIds: after, freshIds: ["a", "b"] });
    assert.deepEqual(second.pruned, []);
    assert.deepEqual(second.added, []);
  });

  it("never duplicates an id the current side already carries (even twice)", () => {
    const plan = planCatalogRefresh({
      currentIds: ["a", "a"],
      freshIds: ["a", "b"],
    });
    assert.deepEqual(plan.kept, ["a"]);
    assert.deepEqual(plan.pruned, ["a"]);
    assert.deepEqual(plan.added, ["b"]);
  });

  it("drops empty current ids and empty fresh ids", () => {
    const plan = planCatalogRefresh({
      currentIds: ["", "a"],
      freshIds: ["a", ""],
    });
    assert.deepEqual(plan.kept, ["a"]);
    assert.deepEqual(plan.pruned, [""]);
    assert.deepEqual(plan.added, []);
  });
});
