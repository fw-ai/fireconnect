import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addUsage,
  sumCosts,
  sumUsage,
} from "../../../../lib/harnesses/claude/usage/cost.mjs";

describe("usage totals", () => {
  it("adds every usage field in one canonical operation", () => {
    assert.deepEqual(
      addUsage(
        { input: 1, cacheRead: 2, output: 3, cost: 0.1 },
        { input: 4, cacheWrite5m: 5, cacheWrite1h: 6, webSearches: 7, cost: 0.2 },
      ),
      {
        input: 5,
        cacheWrite5m: 5,
        cacheWrite1h: 6,
        cacheRead: 2,
        output: 3,
        webSearches: 7,
        cost: 0.30000000000000004,
      },
    );
  });

  it("keeps a total unknown when any item is unpriced", () => {
    const totals = sumUsage([
      { input: 10, output: 1, cost: 0.01 },
      { input: 20, output: 2, cost: null },
    ]);
    assert.equal(totals.input, 30);
    assert.equal(totals.output, 3);
    assert.equal(totals.cost, null);
    assert.equal(sumCosts([0.01, null, 0.02]), null);
  });

  it("treats an omitted cost as absent, not unpriced", () => {
    assert.equal(sumUsage([{ input: 10 }]).cost, 0);
    assert.equal(sumCosts([]), 0);
  });
});
