import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { finalizeInstallOrUpgrade } from "../../lib/system/finalize-install.mjs";
import { withTempHome } from "../helpers.mjs";

describe("finalizeInstallOrUpgrade", () => {
  it("ensures deps, reprobes storage, and reconciles (injectable)", async () => {
    await withTempHome("finalize-install-", async (home) => {
      const calls = [];
      const result = await finalizeInstallOrUpgrade({
        home,
        installDir: `${home}/.fireconnect/cli`,
        setupDir: "/nonexistent-setup-for-test",
        log: (...args) => calls.push(["log", ...args]),
        ensureDeps: (dir) => {
          calls.push(["ensureDeps", dir]);
          return true;
        },
        reprobe: async (h) => {
          calls.push(["reprobe", h]);
          return { migrated: true, backend: { backend: "keychain" } };
        },
        reconcile: async (h) => {
          calls.push(["reconcile", h]);
          return ["Updated Claude websearch MCP auth (baked Bearer token) — restart Claude Code to pick it up."];
        },
      });

      assert.equal(result.migrated, true);
      assert.deepEqual(result.notes, [
        "Updated Claude websearch MCP auth (baked Bearer token) — restart Claude Code to pick it up.",
      ]);
      assert.deepEqual(
        calls.filter(([name]) => name !== "log").map(([name]) => name),
        ["reprobe", "reconcile"],
      );
      assert.ok(calls.some(([name, msg]) => name === "log" && /Moved Fireworks API key/.test(String(msg))));
      assert.ok(calls.some(([name, msg]) => name === "log" && /websearch MCP/.test(String(msg))));
    });
  });

  it("swallows reprobe and reconcile failures (best-effort)", async () => {
    await withTempHome("finalize-best-effort-", async (home) => {
      const result = await finalizeInstallOrUpgrade({
        home,
        setupDir: "/nonexistent-setup-for-test",
        log: () => {},
        ensureDeps: () => true,
        reprobe: async () => {
          throw new Error("probe boom");
        },
        reconcile: async () => {
          throw new Error("reconcile boom");
        },
      });
      assert.equal(result.migrated, false);
      assert.deepEqual(result.notes, []);
    });
  });

  it("skips home-side work when HOME is empty", async () => {
    const calls = [];
    const result = await finalizeInstallOrUpgrade({
      home: "",
      installDir: "",
      setupDir: "/nonexistent-setup-for-test",
      log: () => {},
      ensureDeps: () => {
        calls.push("ensureDeps");
        return true;
      },
      reprobe: async () => {
        calls.push("reprobe");
        return { migrated: false, backend: { backend: "plaintext" } };
      },
      reconcile: async () => {
        calls.push("reconcile");
        return ["should-not-run"];
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(result.migrated, false);
    assert.deepEqual(result.notes, []);
  });
});
