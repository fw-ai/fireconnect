import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheServerlessCatalogSnapshot,
  getServerlessCatalogSnapshot,
  isCatalogCacheFresh,
  readCatalogCache,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";

const CACHE_MODULE = fileURLToPath(
  new URL("../../lib/fireworks/serverless-catalog-cache.mjs", import.meta.url),
);

function sampleSnapshot() {
  return {
    entries: [
      { id: "accounts/fireworks/routers/glm-latest", shortId: "glm-latest", displayName: "GLM 5.2 (Latest)", kind: "serverless" },
      { id: "accounts/fireworks/models/kimi-k3", shortId: "kimi-k3", displayName: "Kimi K3", kind: "serverless" },
    ],
    pricingById: new Map([["glm-latest", { input: 1.4, output: 4.4, tier: "standard" }]]),
    inputModalitiesById: new Map([["glm-latest", ["text"]], ["kimi-k3", ["text", "image"]]]),
    routerBaseModelById: new Map([["accounts/fireworks/routers/glm-latest", "accounts/fireworks/models/glm-5p2"]]),
    contextLengthById: new Map([["glm-latest", 1048576]]),
    supportsToolsById: new Map([["glm-latest", true]]),
  };
}

function withTempHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "fc-cache-test-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function spawnFreshGet(home) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { getServerlessCatalogSnapshot } from ${JSON.stringify(`file://${CACHE_MODULE}`)};
    const s = getServerlessCatalogSnapshot();
    if (!s) { console.log("null"); process.exit(0); }
    console.log(JSON.stringify({
      entries: (s.entries ?? []).map((e) => e.id),
      mods: s.inputModalitiesById?.get("kimi-k3"),
      pricing: s.pricingById?.get("glm-latest")?.input,
      context: s.contextLengthById?.get("glm-latest"),
      tools: s.supportsToolsById?.get("glm-latest"),
    }));
  `], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

describe("serverless-catalog-cache disk persistence", () => {
  it("persists Maps as JSON and a fresh process lazy-loads the snapshot", () => {
    withTempHome((home) => {
      cacheServerlessCatalogSnapshot(sampleSnapshot());
      // Persisted file exists: a { cachedAt, snapshot } envelope with map pairs as arrays.
      const disk = JSON.parse(
        readFileSync(path.join(home, ".fireconnect", "catalog-cache.json"), "utf8"),
      );
      assert.equal(disk.snapshot.entries.length, 2);
      assert.ok(Number.isFinite(disk.cachedAt), "cachedAt written for TTL");
      assert.deepEqual(
        disk.snapshot.inputModalitiesById,
        [["glm-latest", ["text"]], ["kimi-k3", ["text", "image"]]],
      );
      // A fresh process (this module isn't loaded there) recovers the catalog.
      const out = spawnFreshGet(home);
      const loaded = JSON.parse(out);
      assert.equal(loaded.entries.length, 2);
      assert.deepEqual(loaded.mods, ["text", "image"]);
      assert.equal(loaded.pricing, 1.4);
      assert.equal(loaded.context, 1048576);
      assert.equal(loaded.tools, true);
    });
  });

  it("set(null) marks the in-memory snapshot authoritative and never resurrects disk", () => {
    withTempHome((home) => {
      cacheServerlessCatalogSnapshot(sampleSnapshot());
      setServerlessCatalogSnapshot(null);
      assert.equal(getServerlessCatalogSnapshot(), null);
    });
  });

  it("a missing or corrupt cache file is treated as no cache", () => {
    withTempHome((home) => {
      const file = path.join(home, ".fireconnect", "catalog-cache.json");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "{ not json");
      const out = spawnFreshGet(home);
      assert.equal(out, "null");
    });
  });

  it("isCatalogCacheFresh respects the persisted cachedAt within the TTL", () => {
    withTempHome((home) => {
      cacheServerlessCatalogSnapshot(sampleSnapshot());
      assert.equal(isCatalogCacheFresh(), true);

      // Age the write past the default TTL → stale (but still readable).
      const file = path.join(home, ".fireconnect", "catalog-cache.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.cachedAt = Date.now() - 2 * 60 * 60 * 1000;
      writeFileSync(file, JSON.stringify(raw));
      assert.equal(isCatalogCacheFresh(), false);
      assert.ok(readCatalogCache()?.snapshot, "stale snapshot is still recoverable");
    });
  });

  it("reads a legacy pre-TTL cache file as stale but usable", () => {
    withTempHome((home) => {
      const file = path.join(home, ".fireconnect", "catalog-cache.json");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({
        entries: [{ id: "accounts/fireworks/models/kimi-k3", shortId: "kimi-k3", displayName: "Kimi K3", kind: "serverless" }],
        pricingById: [], inputModalitiesById: [], routerBaseModelById: [],
        contextLengthById: [], supportsToolsById: [],
      }));
      const cache = readCatalogCache();
      assert.equal(cache.snapshot.entries.length, 1);
      assert.equal(cache.cachedAt, 0, "legacy has no timestamp");
      assert.equal(isCatalogCacheFresh(), false, "legacy reads as stale → refreshed");
    });
  });
});
