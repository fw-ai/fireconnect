import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineHarnessProfile } from "../../lib/harness/engine.mjs";
import { defineHarness } from "../../lib/harness/types.mjs";
import { HARNESS } from "../../lib/harness/id.mjs";

describe("defineHarness", () => {
  it("accepts a complete adapter", () => {
    const adapter = defineHarness({
      id: HARNESS.CLAUDE,
      label: "Test",
      on: async () => {},
      off: async () => {},
      status: async () => {},
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
        id: "unknown",
        label: "Pi",
        on: async () => {},
        off: async () => {},
        status: async () => {},
        resolveKey: async () => "",
      }),
      /Harness adapter id must be one of/,
    );
  });
});

describe("defineHarnessProfile", () => {
  it("rejects boolean FireRouter capabilities", () => {
    assert.throws(
      () => defineHarnessProfile({ id: HARNESS.CODEX, firerouter: true }),
      /must define firerouter as/,
    );
  });

  it("rejects partial Azure capabilities", () => {
    assert.throws(
      () => defineHarnessProfile({
        id: HARNESS.CODEX,
        azure: { read: async () => ({ active: false }) },
      }),
      /must define azure as/,
    );
  });
});
