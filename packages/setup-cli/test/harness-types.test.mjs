import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineHarness } from "../lib/harness-types.mjs";
import { HARNESS } from "../lib/harness.mjs";

describe("defineHarness", () => {
  it("accepts a complete adapter", () => {
    const adapter = defineHarness({
      id: HARNESS.CLAUDE,
      label: "Test",
      on: async () => {},
      off: async () => {},
      status: async () => {},
      modelList: async () => {},
      modelSelect: async () => {},
      modelReset: async () => {},
      resolveKey: async () => "",
    });
    assert.equal(adapter.id, HARNESS.CLAUDE);
  });

  it("rejects missing methods", () => {
    assert.throws(
      () => defineHarness({
        id: HARNESS.CLAUDE,
        label: "Test",
        on: async () => {},
      }),
      /missing method: off/,
    );
  });

  it("rejects unknown harness id", () => {
    assert.throws(
      () => defineHarness({
        id: "pi",
        label: "Pi",
        on: async () => {},
        off: async () => {},
        status: async () => {},
        modelList: async () => {},
        modelSelect: async () => {},
        modelReset: async () => {},
        resolveKey: async () => "",
      }),
      /Harness adapter id must be one of/,
    );
  });
});
