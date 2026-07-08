import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dedupeClaudeModels, keepLatestClaudePerFamily } from "../lib/firerouter-catalog.mjs";

describe("dedupeClaudeModels", () => {
  it("collapses [1m] and dated variants onto the plain alias, preserving order", () => {
    // Mirrors the live provider.firerouter.models shape (order matters: the dated
    // haiku snapshot is advertised BEFORE its plain alias).
    const input = [
      { id: "claude-opus-4-8" },
      { id: "claude-opus-4-8[1m]" },
      { id: "claude-sonnet-4-6" },
      { id: "claude-sonnet-4-6[1m]" },
      { id: "claude-sonnet-5" },
      { id: "claude-haiku-4-5-20251001" },
      { id: "claude-haiku-4-5" },
    ];
    const ids = dedupeClaudeModels(input).map((m) => m.id);
    assert.deepEqual(ids, [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("keeps a model offered only as a variant (never drops it entirely)", () => {
    const ids = dedupeClaudeModels([
      { id: "claude-opus-4-8[1m]" }, // no plain alias present
      { id: "claude-weekly-20260101" }, // dated-only
    ]).map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-8[1m]", "claude-weekly-20260101"]);
  });

  it("prefers the plain alias even when a variant is seen first", () => {
    const picked = dedupeClaudeModels([
      { id: "claude-opus-4-8[1m]", name: "variant" },
      { id: "claude-opus-4-8", name: "plain" },
    ]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].id, "claude-opus-4-8");
    assert.equal(picked[0].name, "plain");
  });

  it("tolerates empty / nullish input and skips id-less entries", () => {
    assert.deepEqual(dedupeClaudeModels(), []);
    assert.deepEqual(dedupeClaudeModels([]), []);
    assert.deepEqual(dedupeClaudeModels([{}, { id: "" }, { id: "claude-x" }]).map((m) => m.id), ["claude-x"]);
  });
});

describe("keepLatestClaudePerFamily", () => {
  it("keeps only the newest model per family, preserving first-seen order", () => {
    // Mirrors the deduped live set (opus + sonnet each offered at two versions).
    const ids = keepLatestClaudePerFamily([
      { id: "claude-opus-4-8" },
      { id: "claude-opus-4-7" },
      { id: "claude-sonnet-4-6" },
      { id: "claude-sonnet-5" },
      { id: "claude-haiku-4-5" },
    ]).map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]);
  });

  it("compares version segments left-to-right so a single major beats an older major.minor", () => {
    const ids = keepLatestClaudePerFamily([
      { id: "claude-sonnet-4-6" },
      { id: "claude-sonnet-5" },
    ]).map((m) => m.id);
    assert.deepEqual(ids, ["claude-sonnet-5"]);
  });

  it("picks the newest even when the older version is advertised first", () => {
    const ids = keepLatestClaudePerFamily([
      { id: "claude-opus-4-7" },
      { id: "claude-opus-4-8" },
    ]).map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-8"]);
  });

  it("ignores [1m] and dated-snapshot suffixes when deriving family + version", () => {
    const ids = keepLatestClaudePerFamily([
      { id: "claude-opus-4-7" },
      { id: "claude-opus-4-8[1m]" },
    ]).map((m) => m.id);
    assert.deepEqual(ids, ["claude-opus-4-8[1m]"]);
  });

  it("tolerates empty / nullish input and skips id-less entries", () => {
    assert.deepEqual(keepLatestClaudePerFamily(), []);
    assert.deepEqual(keepLatestClaudePerFamily([{}, { id: "" }, { id: "claude-opus-4-8" }]).map((m) => m.id), ["claude-opus-4-8"]);
  });
});
