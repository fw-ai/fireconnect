import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  autoCatalogEntry,
  buildPickerCatalogFromApiModels,
  buildServerlessCatalogSnapshot,
  catalogWithAutomaticAuto,
  fetchServerlessCatalogRaw,
  inputModalitiesFromModel,
  isAutoCatalogEntry,
  loadRegisterableModels,
  loadServerlessCatalog,
  moneyToUsd,
  parseSkuPricing,
  SERVERLESS_CODING_USE_CASE,
  warmServerlessPricingCache,
} from "../../lib/fireworks/models.mjs";
import {
  catalogWithAutoEntry,
  formatCatalogSections,
  formatCatalogUpdatedAt,
  organizeCatalogForDisplay,
} from "../../lib/fireworks/model-list.mjs";
import {
  cacheServerlessCatalogSnapshot,
  catalogKeyFingerprint,
  getServerlessCatalogSnapshot,
  expireCatalogCache,
  readCatalogCache,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";

import { mockServerlessModel, mockServerlessModelRows } from "../helpers.mjs";

describe("fireworks-models serverless catalog", () => {  test("fetchServerlessCatalogRaw uses the flat serverless models API with coding filter", async () => {
    const previousFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          object: "list",
          data: [mockServerlessModel()],
        }),
      };
    };

    try {
      const models = await fetchServerlessCatalogRaw("fw_test_key");
      assert.equal(models.length, 1);
      assert.equal(models[0].id, "accounts/fireworks/models/glm-5p2");
      const parsed = new URL(requestedUrl);
      assert.equal(parsed.pathname, "/v1/serverless/models");
      assert.equal(parsed.searchParams.get("format"), null);
      assert.equal(parsed.searchParams.get("use_cases"), SERVERLESS_CODING_USE_CASE);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("fetchServerlessCatalogRaw retries once on a transient 500", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "Error listing serverless models",
        };
      }
      return {
        ok: true,
        json: async () => ({
          object: "list",
          data: [mockServerlessModel()],
        }),
      };
    };

    try {
      const models = await fetchServerlessCatalogRaw("fw_test_key");
      assert.equal(models.length, 1);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("fetchServerlessCatalogRaw throws after a persistent 500 without extra attempts", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "Error listing serverless models",
      };
    };

    try {
      await assert.rejects(
        fetchServerlessCatalogRaw("fw_test_key"),
        /Fireworks API 500/,
      );
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("fetchServerlessCatalogRaw does not retry client errors", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "nope",
      };
    };

    try {
      await assert.rejects(
        fetchServerlessCatalogRaw("fw_test_key"),
        /Fireworks API 404/,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("fetchServerlessCatalogRaw propagates network errors without retrying", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    const failure = new Error("socket hang up");
    globalThis.fetch = async () => {
      calls += 1;
      throw failure;
    };

    try {
      await assert.rejects(
        fetchServerlessCatalogRaw("fw_test_key"),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  /**
   * Run `fn` against a throwaway HOME (so the catalog cache file is isolated)
   * seeded with a fresh single-entry `stale` snapshot.
   */
  async function withSeededCatalogCache(fetchImpl, fn) {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-catalog-refresh-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const seededAt = cacheServerlessCatalogSnapshot({
        entries: [{
          id: "accounts/fireworks/models/stale",
          shortId: "stale",
          displayName: "Stale",
          kind: "serverless",
        }],
        pricingById: new Map(),
        inputModalitiesById: new Map(),
        routerBaseModelById: new Map(),
        contextLengthById: new Map(),
        supportsToolsById: new Map(),
      });
      await fn(seededAt);
    } finally {
      globalThis.fetch = previousFetch;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  }

  /** Assert a cold-cache load rejects, and return the rejection's message. */
  async function coldStartError(fetchImpl) {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-catalog-cold-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    let message = "";
    try {
      await assert.rejects(loadServerlessCatalog({ apiKey: "fw_test_key" }), (error) => {
        message = error.message;
        return true;
      });
      return message;
    } finally {
      globalThis.fetch = previousFetch;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  }

  const httpFailure = (status, statusText, body) => async () => ({
    ok: false,
    status,
    statusText,
    text: async () => body,
  });

  test("cold-start catalog error reports the gateway's answer instead of blaming the network", async () => {
    const message = await coldStartError(
      httpFailure(500, "Internal Server Error", "Error listing serverless models\n"),
    );
    assert.equal(
      message,
      "Couldn't fetch the Fireworks model catalog and no cached copy exists yet. "
        + "Fireworks API 500 Internal Server Error: Error listing serverless models. "
        + "Retry once the Fireworks API recovers. "
        + "Once `nexus model list` succeeds, the catalog is cached for offline use.",
    );
  });

  test("cold-start catalog error keeps the gateway's 401/403 reason without retry advice", async () => {
    const forbidden = await coldStartError(
      httpFailure(403, "Forbidden", "access requires an approved network\n"),
    );
    assert.match(forbidden, /rejected the request \(403: access requires an approved network\)\. /);
    assert.doesNotMatch(forbidden, /Check your network|Retry once/);
    const unauthorized = await coldStartError(httpFailure(401, "Unauthorized", ""));
    assert.match(unauthorized, /rejected the API key \(401\)\. Check FIREWORKS_API_KEY/);
    assert.doesNotMatch(unauthorized, /Retry once/);
  });

  test("cold-start catalog error points at the network when the request never landed", async () => {
    const message = await coldStartError(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.fireworks.ai");
    });
    assert.match(message, /Couldn't reach Fireworks \(getaddrinfo ENOTFOUND api\.fireworks\.ai\)\. Check your network connection\./);
  });

  test("loadServerlessCatalog refresh ignores a fresh cache and refetches", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return {
        ok: true,
        json: async () => ({ object: "list", data: mockServerlessModelRows() }),
      };
    };

    await withSeededCatalogCache(fetchImpl, async (seededAt) => {
      const cached = await loadServerlessCatalog({ apiKey: "fw_test_key" });
      assert.equal(cached.source, "cache");
      assert.equal(cached.updatedAt, seededAt);
      assert.equal(fetches, 0);
      assert.equal(cached.catalog[0].shortId, "auto");
      assert.ok(cached.catalog.some((entry) => entry.shortId === "stale"));

      const refreshed = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(refreshed.source, "network");
      assert.equal(refreshed.updatedAt, readCatalogCache()?.cachedAt);
      assert.equal(fetches, 1);
      assert.ok(refreshed.catalog.some((entry) => entry.shortId === "glm-5p2"));
      assert.equal(refreshed.catalog.some((entry) => entry.shortId === "stale"), false);
      assert.ok(
        readCatalogCache()?.snapshot.entries.some((entry) => entry.shortId === "glm-5p2"),
        "refetch replaces the persisted snapshot",
      );
    });
  });

  // An offline refresh must not leave the user worse off than before: the old
  // snapshot stays on disk so later commands (harness `on`, the picker) still
  // have a catalog instead of hard-failing as a cold start.
  test("loadServerlessCatalog refresh keeps the cached snapshot when the fetch fails", async () => {
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };

    await withSeededCatalogCache(fetchImpl, async (seededAt) => {
      const result = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(result.source, "stale");
      assert.match(result.staleReason, /Couldn't reach Fireworks \(network unreachable\)/);
      assert.equal(result.updatedAt, seededAt);
      assert.equal(result.catalog[0].shortId, "auto");
      assert.ok(result.catalog.some((entry) => entry.shortId === "stale"));
      assert.equal(
        readCatalogCache()?.snapshot.entries[0].shortId,
        "stale",
        "a failed refresh must not delete the cache file",
      );
    });
  });

  /**
   * A fetch that never answers on its own, only rejecting when aborted. The
   * interval stands in for a real request's open socket: AbortSignal.timeout's
   * timer is unref'd, so without a ref'd handle Node 22 sees an empty event
   * loop and cancels the test before the abort fires.
   */
  const hangingResponse = (signal) => new Promise((_, reject) => {
    const socket = setInterval(() => {}, 1_000);
    signal?.addEventListener("abort", () => {
      clearInterval(socket);
      reject(signal.reason);
    }, { once: true });
  });

  /** Run `fn` with the cached-catalog fetch budget shrunk to `ms`. */
  async function withCachedFetchTimeout(ms, fn) {
    const previous = process.env.NEXUS_CATALOG_CACHED_FETCH_TIMEOUT_MS;
    process.env.NEXUS_CATALOG_CACHED_FETCH_TIMEOUT_MS = String(ms);
    try {
      await fn();
    } finally {
      if (previous === undefined) {
        delete process.env.NEXUS_CATALOG_CACHED_FETCH_TIMEOUT_MS;
      } else {
        process.env.NEXUS_CATALOG_CACHED_FETCH_TIMEOUT_MS = previous;
      }
    }
  }

  // The listing intermittently hangs to the 30s gateway timeout. With a cached
  // snapshot to stand in, `on`/`status` must not wait that out.
  test("loadServerlessCatalog falls back to the cache quickly when the listing hangs", async () => {
    let fetches = 0;
    const fetchImpl = async (_url, init) => {
      fetches += 1;
      return hangingResponse(init?.signal);
    };

    await withCachedFetchTimeout(50, () => withSeededCatalogCache(fetchImpl, async (seededAt) => {
      const started = Date.now();
      const result = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.ok(Date.now() - started < 2_000, "served the cache within the short budget");
      assert.equal(fetches, 1);
      assert.equal(result.source, "stale");
      assert.equal(result.staleReason, "Fireworks didn't return the model catalog in time.");
      assert.equal(result.updatedAt, seededAt);
      assert.ok(result.catalog.some((entry) => entry.shortId === "stale"));
    }));
  });

  // A 5xx then a hung retry used to cost the 300ms backoff plus a full 30s
  // timeout; the short budget covers the retry too.
  test("loadServerlessCatalog bounds a 5xx-then-hung retry by the cached budget", async () => {
    let fetches = 0;
    const fetchImpl = async (_url, init) => {
      fetches += 1;
      if (fetches === 1) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "upstream unavailable",
        };
      }
      return hangingResponse(init?.signal);
    };

    await withCachedFetchTimeout(500, () => withSeededCatalogCache(fetchImpl, async () => {
      const started = Date.now();
      const result = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.ok(Date.now() - started < 2_000, "the retry shares the short budget");
      assert.equal(fetches, 2);
      assert.equal(result.source, "stale");
      assert.ok(result.catalog.some((entry) => entry.shortId === "stale"));
    }));
  });

  test("loadServerlessCatalog serves the cache when the listing keeps 5xx-ing", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "",
      };
    };

    await withSeededCatalogCache(fetchImpl, async () => {
      const result = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(fetches, 2);
      assert.equal(result.source, "stale");
      assert.match(result.staleReason, /Fireworks API 503/);
      assert.ok(result.catalog.some((entry) => entry.shortId === "stale"));
    });
  });

  // First run: nothing to fall back to, so a slow listing is waited for (up to
  // the standard gateway budget) rather than failing after the short one.
  test("loadServerlessCatalog keeps waiting past the cached budget on a cold start", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-catalog-cold-slow-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const previousFetch = globalThis.fetch;
    let sawSignal = false;
    globalThis.fetch = async (_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (init?.signal?.aborted) {
        throw init.signal.reason;
      }
      return {
        ok: true,
        json: async () => ({ object: "list", data: mockServerlessModelRows() }),
      };
    };
    try {
      await withCachedFetchTimeout(20, async () => {
        const result = await loadServerlessCatalog({ apiKey: "fw_test_key" });
        assert.ok(sawSignal, "cold starts still carry the 30s gateway timeout");
        assert.equal(result.source, "network");
        assert.ok(result.catalog.length > 0);
      });
    } finally {
      globalThis.fetch = previousFetch;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a cold-start hang still ends in the cold-start error, not a short timeout", async () => {
    // Abort from the test instead of waiting out 30s, and confirm the abort
    // came from the per-request gateway signal rather than the cached budget.
    let signal = null;
    await withCachedFetchTimeout(20, async () => {
      const message = await coldStartError(async (_url, init) => {
        signal = init?.signal;
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(signal.aborted, false, "the cached budget must not apply without a cache");
        throw new Error("socket hang up");
      });
      assert.match(message, /no cached copy exists yet/);
    });
  });

  test("warmServerlessPricingCache returns quickly on a hung listing when a cache exists", async () => {
    const fetchImpl = async (_url, init) => hangingResponse(init?.signal);
    await withCachedFetchTimeout(50, () => withSeededCatalogCache(fetchImpl, async () => {
      const started = Date.now();
      await warmServerlessPricingCache("fw_test_key");
      assert.ok(Date.now() - started < 2_000);
      assert.equal(readCatalogCache()?.snapshot.entries[0].shortId, "stale");
    }));
  });

  // `claude status` only reads prices, so it reuses a TTL-fresh catalog
  // instead of waiting on the listing every run.
  test("warmServerlessPricingCache reuseFreshCache skips the listing while the cache is fresh", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return {
        ok: true,
        json: async () => ({ object: "list", data: mockServerlessModelRows() }),
      };
    };

    await withSeededCatalogCache(fetchImpl, async (seededAt) => {
      setServerlessCatalogSnapshot(null);
      await warmServerlessPricingCache("fw_test_key", { reuseFreshCache: true });
      assert.equal(fetches, 0);
      assert.equal(readCatalogCache()?.cachedAt, seededAt);
      assert.equal(
        getServerlessCatalogSnapshot()?.entries[0].shortId,
        "stale",
        "hydrates the in-memory snapshot from the fresh cache",
      );

      await warmServerlessPricingCache("fw_test_key");
      assert.equal(fetches, 1, "callers without the option still refetch");
    });
  });

  test("warmServerlessPricingCache reuseFreshCache refetches once the cache is past its TTL", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return {
        ok: true,
        json: async () => ({ object: "list", data: mockServerlessModelRows() }),
      };
    };
    const previousTtl = process.env.NEXUS_CATALOG_TTL_MS;
    process.env.NEXUS_CATALOG_TTL_MS = "1";
    try {
      await withSeededCatalogCache(fetchImpl, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await warmServerlessPricingCache("fw_test_key", { reuseFreshCache: true });
        assert.equal(fetches, 1);
        assert.equal(readCatalogCache()?.snapshot.entries.some((entry) => entry.shortId === "stale"), false);
      });
    } finally {
      if (previousTtl === undefined) {
        delete process.env.NEXUS_CATALOG_TTL_MS;
      } else {
        process.env.NEXUS_CATALOG_TTL_MS = previousTtl;
      }
    }
  });

  test("warmServerlessPricingCache reuseFreshCache still never sends a non-Fireworks key", async () => {
    let fetches = 0;
    await withSeededCatalogCache(async () => {
      fetches += 1;
      return { ok: true, json: async () => ({ data: [] }) };
    }, async () => {
      await warmServerlessPricingCache("sk-ant-not-a-fireworks-key", { reuseFreshCache: true });
      assert.equal(fetches, 0);
    });
  });

  test("loadServerlessCatalog serves auto like a serverless list member", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ object: "list", data: mockServerlessModelRows() }),
    });

    await withSeededCatalogCache(fetchImpl, async () => {
      const loaded = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(loaded.source, "network");
      assert.equal(loaded.catalog[0].shortId, "auto");
      assert.ok(loaded.catalog.some((entry) => entry.shortId === "glm-5p2"));
    });
  });

  test("loadServerlessCatalog keeps one auto row however the gateway lists it", async () => {
    const rows = [
      ...mockServerlessModelRows({
        aliases: [
          "accounts/fireworks/routers/example-latest",
          "accounts/fireworks/routers/auto",
          "accounts/fireworks/routers/auto-instant",
        ],
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/example-member",
        display_name: "Example Member",
        usage_identifier: "accounts/fireworks/routers/auto",
        aliases: ["accounts/fireworks/routers/auto"],
      }),
      mockServerlessModel({ id: "accounts/fireworks/models/auto", display_name: "Auto mix" }),
    ];
    const fetchImpl = async () => ({ ok: true, json: async () => ({ object: "list", data: rows }) });
    const autoIds = (catalog) => catalog.filter(isAutoCatalogEntry).map((entry) => entry.id);

    await withSeededCatalogCache(fetchImpl, async () => {
      const loaded = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.deepEqual(autoIds(loaded.catalog).sort(), ["auto"], "the retired auto-instant row is dropped");
      assert.deepEqual(loaded.catalog.find((entry) => entry.id === "auto"), autoCatalogEntry());
      const persisted = readCatalogCache()?.snapshot;
      assert.deepEqual(
        autoIds(persisted?.entries ?? []).sort(),
        ["auto"],
        "the persisted snapshot holds one canonical row for the auto mix",
      );
      for (const id of ["accounts/fireworks/routers/auto", "accounts/fireworks/models/auto"]) {
        assert.equal(persisted.pricingById.get(id), undefined, `${id} borrows no member's pricing`);
        assert.equal(persisted.routerBaseModelById.get(id), undefined, `${id} has no single base model`);
        assert.equal(persisted.contextLengthById.get(id), undefined, `${id} borrows no member's context`);
      }

      const sections = organizeCatalogForDisplay(catalogWithAutoEntry(loaded.catalog));
      const ids = (title) => sections.find((section) => section.title === title)?.entries.map((e) => e.shortId);
      assert.deepEqual(ids("SMART ROUTERS"), ["auto"]);
      assert.ok(!ids("INDIVIDUAL MODELS").some((id) => id.startsWith("auto")));
    });
  });

  // A router row names its mix through usage_identifier; its id is not a model path.
  const autoRouterRow = {
    id: "example-router/auto",
    object: "model",
    kind: "router",
    usage_identifier: "auto",
    aliases: ["example-router/auto"],
    display_name: "Example Router",
  };

  test("loadServerlessCatalog serves a router-only catalog as the auto mix", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ object: "list", data: [autoRouterRow] }) });

    await withSeededCatalogCache(fetchImpl, async () => {
      const loaded = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(loaded.source, "network");
      assert.deepEqual(loaded.catalog, [autoCatalogEntry()], "a router-only catalog is not read as unavailable");
      const persisted = readCatalogCache()?.snapshot;
      assert.deepEqual(persisted?.entries, [autoCatalogEntry()]);
      for (const byId of ["pricingById", "routerBaseModelById", "contextLengthById"]) {
        assert.equal(persisted[byId].size, 0, `the router row adds nothing to ${byId}`);
      }
    });
  });

  test("buildServerlessCatalogSnapshot maps auto router rows to one auto entry and skips other routers", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      autoRouterRow,
      ...mockServerlessModelRows(),
      { ...autoRouterRow, id: "example-router/other", usage_identifier: "example-other" },
      { ...autoRouterRow },
    ]);

    assert.deepEqual(snapshot.entries.filter(isAutoCatalogEntry), [autoCatalogEntry()]);
    assert.ok(snapshot.entries.some((entry) => entry.shortId === "glm-5p2"), "model rows are kept");
    assert.ok(!snapshot.entries.some((entry) => entry.id.startsWith("example-router/")));
    assert.deepEqual(catalogWithAutomaticAuto(snapshot.entries).filter(isAutoCatalogEntry), [autoCatalogEntry()]);
  });

  test("buildServerlessCatalogSnapshot matches router rows by kind case-insensitively and by a path usage identifier", () => {
    for (const row of [
      { ...autoRouterRow, kind: "ROUTER" },
      { ...autoRouterRow, usage_identifier: "accounts/example-account/routers/auto" },
      { ...autoRouterRow, usage_identifier: undefined, usageIdentifier: "auto" },
    ]) {
      assert.deepEqual(buildServerlessCatalogSnapshot([row]).entries, [autoCatalogEntry()], JSON.stringify(row));
    }
  });

  async function withPlanTier(tier, fn) {
    const previous = process.env.NEXUS_TEST_PLAN_TIER;
    process.env.NEXUS_TEST_PLAN_TIER = tier;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.NEXUS_TEST_PLAN_TIER;
      else process.env.NEXUS_TEST_PLAN_TIER = previous;
    }
  }

  test("loadServerlessCatalog refetches a fresh cache that another key fetched", async () => {
    const rows = mockServerlessModelRows();
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return { ok: true, json: async () => ({ object: "list", data: rows }) };
    };
    await withSeededCatalogCache(fetchImpl, async () => {
      await loadServerlessCatalog({ apiKey: "fw_first_key", refresh: true });
      assert.equal(readCatalogCache().keyFingerprint, catalogKeyFingerprint("fw_first_key"));
      assert.ok(!JSON.stringify(readCatalogCache()).includes("fw_first_key"), "the cache never stores the key");

      fetches = 0;
      assert.equal((await loadServerlessCatalog({ apiKey: "fw_first_key" })).source, "cache");
      assert.equal(fetches, 0, "the same key reuses the fresh cache");

      const switched = await loadServerlessCatalog({ apiKey: "fw_second_key" });
      assert.equal(switched.source, "network", "another key refetches");
      assert.equal(readCatalogCache().keyFingerprint, catalogKeyFingerprint("fw_second_key"));
    });
  });

  test("loadServerlessCatalog never serves another key's cache as a stale fallback", async () => {
    const rows = mockServerlessModelRows();
    let offline = false;
    const fetchImpl = async () => {
      if (offline) throw new Error("network unreachable");
      return { ok: true, json: async () => ({ object: "list", data: rows }) };
    };
    await withSeededCatalogCache(fetchImpl, async () => {
      await loadServerlessCatalog({ apiKey: "fw_first_key", refresh: true });
      offline = true;
      const switched = await loadServerlessCatalog({ apiKey: "fw_second_key" });
      assert.equal(switched.source, "stale");
      assert.deepEqual(switched.catalog, [], "the other account's models are not served");
      assert.match(switched.staleReason, /fetched with another key/);
      assert.equal(getServerlessCatalogSnapshot(), null, "the other account's snapshot is not left active");
      assert.equal(readCatalogCache().keyFingerprint, catalogKeyFingerprint("fw_first_key"), "the other key's cache stays for its owner");
      assert.equal((await loadServerlessCatalog({ apiKey: "fw_first_key", refresh: true })).source, "stale");
    });
  });

  test("loadServerlessCatalog keeps only auto for an account whose plan allows only auto", async () => {
    const rows = mockServerlessModelRows();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ object: "list", data: rows }) });
    await withPlanTier("PRO", () => withSeededCatalogCache(fetchImpl, async () => {
      const loaded = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.deepEqual(loaded.catalog, [autoCatalogEntry()]);
      const persisted = readCatalogCache()?.snapshot;
      assert.deepEqual(persisted?.entries, [autoCatalogEntry()], "the cached catalog holds only auto too");
      assert.equal(persisted.pricingById.size, 0);
      assert.deepEqual(await loadRegisterableModels({ apiKey: "fw_test_key" }), { ids: ["auto"], available: true, served: true });
    }));
    await withPlanTier("ENTERPRISE", () => withSeededCatalogCache(fetchImpl, async () => {
      const loaded = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.ok(loaded.catalog.some((entry) => entry.shortId === "glm-5p2"), "other plans keep the full catalog");
    }));
  });

  test("loadServerlessCatalog keeps the cached catalog when the plan lookup fails", async () => {
    const rows = mockServerlessModelRows();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ object: "list", data: rows }) });
    await withPlanTier("UNAVAILABLE", () => withSeededCatalogCache(fetchImpl, async (seededAt) => {
      const loaded = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(loaded.source, "stale");
      assert.match(loaded.staleReason, /Nexus plan/);
      assert.ok(loaded.catalog.some((entry) => entry.shortId === "stale"), "the cached catalog is served");
      assert.equal(readCatalogCache().cachedAt, seededAt, "the full catalog is not cached");
      expireCatalogCache();
      assert.equal((await loadRegisterableModels({ apiKey: "fw_test_key" })).served, false);
    }));
  });

  test("loadServerlessCatalog serves a cold fetch uncached when the plan lookup fails", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-catalog-plan-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ object: "list", data: mockServerlessModelRows() }) });
    try {
      await withPlanTier("UNAVAILABLE", async () => {
        const loaded = await loadServerlessCatalog({ apiKey: "fw_test_key" });
        assert.equal(loaded.source, "network");
        assert.ok(loaded.catalog.some((entry) => entry.shortId === "glm-5p2"), "this command still gets a catalog");
        assert.equal(readCatalogCache(), null, "nothing is cached, so the next command checks the plan again");
      });
    } finally {
      globalThis.fetch = previousFetch;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("loadRegisterableModels serves a fresh cache without fetching", async () => {
    const fetchImpl = async () => { throw new Error("a fresh cache must not be refetched"); };
    await withSeededCatalogCache(fetchImpl, async () => {
      const loaded = await loadRegisterableModels({ apiKey: "fw_test_key" });
      assert.ok(loaded.ids.includes("accounts/fireworks/models/stale"));
      assert.equal(loaded.served, true);
    });
  });

  test("loadRegisterableModels marks only a fresh non-empty catalog as served", async () => {
    // Every case below starts from an expired cache, so it refetches.
    const served = async () => ({ ok: true, json: async () => ({ object: "list", data: [autoRouterRow] }) });
    await withSeededCatalogCache(served, async () => {
      expireCatalogCache();
      assert.deepEqual(await loadRegisterableModels({ apiKey: "fw_test_key" }), { ids: ["auto"], available: true, served: true });
    });
    const vacant = async () => ({ ok: true, json: async () => ({ object: "list", data: [] }) });
    await withSeededCatalogCache(vacant, async () => {
      expireCatalogCache();
      assert.equal((await loadRegisterableModels({ apiKey: "fw_test_key" })).served, false);
    });
    const offline = async () => { throw new TypeError("fetch failed"); };
    await withSeededCatalogCache(offline, async () => {
      expireCatalogCache();
      assert.equal((await loadRegisterableModels({ apiKey: "fw_test_key" })).served, false, "a stale cache is not served");
    });
  });

  test("a snapshot cached with gateway auto rows is served with one canonical auto", () => {
    const example = {
      id: "accounts/fireworks/routers/example-latest",
      shortId: "example-latest",
      displayName: "Example Latest",
      kind: "serverless",
    };
    const gatewayAuto = { id: "accounts/fireworks/routers/auto", shortId: "auto", displayName: "Auto", kind: "serverless" };
    const gatewayInstant = { ...gatewayAuto, id: "accounts/fireworks/routers/auto-instant", shortId: "auto-instant" };

    const served = catalogWithAutomaticAuto([gatewayAuto, example, { ...gatewayAuto }]);
    assert.deepEqual(served, [autoCatalogEntry(), example]);

    // A retired auto-instant row is dropped and does not stand in for the default mix.
    const instantOnly = catalogWithAutomaticAuto([gatewayInstant, example]);
    assert.deepEqual(instantOnly.map((entry) => entry.id), ["auto", "accounts/fireworks/routers/example-latest"]);

    assert.deepEqual(
      catalogWithAutoEntry([gatewayAuto, example]).filter(isAutoCatalogEntry).map((e) => e.shortId),
      ["auto"],
      "model list matches a resource-path auto row instead of adding a second one",
    );
  });

  test("loadServerlessCatalog leaves an empty served list empty", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "fc-catalog-empty-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network unreachable");
    };
    try {
      cacheServerlessCatalogSnapshot({
        entries: [],
        pricingById: new Map(),
        inputModalitiesById: new Map(),
        routerBaseModelById: new Map(),
        contextLengthById: new Map(),
        supportsToolsById: new Map(),
      });
      const result = await loadServerlessCatalog({ apiKey: "fw_test_key", refresh: true });
      assert.equal(result.source, "stale");
      assert.deepEqual(result.catalog, [], "no auto row on an empty list — offline stays unavailable");
    } finally {
      globalThis.fetch = previousFetch;
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("formatCatalogUpdatedAt uses the local timezone and includes its abbreviation", () => {
    assert.equal(
      formatCatalogUpdatedAt(Date.UTC(2026, 7, 29, 20, 28), "America/Los_Angeles"),
      "Aug 29, 2026, 1:28 PM PDT",
    );
    assert.equal(formatCatalogUpdatedAt(null), "bundled with Nexus CLI");
  });

  test("formatCatalogSections uses the shared minimal USD format", () => {
    const output = formatCatalogSections([{
      title: "MODELS",
      entries: [
        {
          id: "accounts/fireworks/models/model-a",
          shortId: "model-a",
          displayName: "Model A",
          pricing: {
            inputPerMillion: 0.2,
            cachedInputPerMillion: 0.02,
            outputPerMillion: 1,
          },
        },
        {
          id: "accounts/fireworks/models/model-b",
          shortId: "model-b",
          displayName: "Model B",
          pricing: {
            inputPerMillion: 4.5,
            cachedInputPerMillion: 0.45,
            outputPerMillion: 22.5,
          },
        },
      ],
    }]);

    assert.match(output, /\$0\.2\s+\$0\.02\s+\$1(?!\.\d)/);
    assert.match(output, /\$4\.5\s+\$0\.45\s+\$22\.5/);
  });

  test("formatCatalogSections annotates each smart router", () => {
    const output = formatCatalogSections([{
      title: "SMART ROUTERS",
      description: "one model picked per user turn",
      entries: [
        { id: "auto", shortId: "auto", displayName: "Auto" },
        { id: "auto-instant", shortId: "auto-instant", displayName: "Auto Instant" },
        { id: "accounts/fireworks/routers/firerouter", shortId: "firerouter", displayName: "FireRouter" },
      ],
    }]);

    assert.match(output, /SMART ROUTERS/);
    assert.match(output, /one model picked per user turn/);
    assert.match(output, /auto: +Smart routing: automatically picks the best model for the task\./);
    assert.match(output, /auto-instant: +Routes each user turn across the fastest Fireworks open models\./);
    assert.match(output, /firerouter: +Smart routing: automatically picks the best model for the task\./);
    // The three notes line up in one column.
    const noteColumns = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
      .filter((line) => /^ {2}(auto|auto-instant|firerouter):/.test(line))
      .map((line) => line.match(/^ {2}\S+: +/)[0].length);
    assert.equal(noteColumns.length, 3, output);
    assert.equal(new Set(noteColumns).size, 1, output);
  });

  test("buildPickerCatalogFromApiModels derives routers from usage_identifier", () => {
    const catalog = buildPickerCatalogFromApiModels([
      ...mockServerlessModelRows(),
      mockServerlessModel({
        id: "accounts/fireworks/models/embedding-only",
        display_name: "Embedding Only",
      }),
    ]);

    const ids = catalog.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/models/glm-5p2"));
    assert.ok(ids.includes("accounts/fireworks/routers/glm-5p2-fast"));
    assert.equal(ids.filter((id) => id.includes("/models/")).length, 2);
  });

  test("buildPickerCatalogFromApiModels keeps API-reported US-only routers", () => {
    const catalog = buildPickerCatalogFromApiModels([
      ...mockServerlessModelRows({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        aliases: ["accounts/fireworks/routers/kimi-k3-us"],
      }),
    ]);
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));

    assert.equal(
      byId.get("accounts/fireworks/routers/kimi-k3-us")?.displayName,
      "Kimi K3 (US)",
    );

    const sections = organizeCatalogForDisplay(catalog);
    const usOnly = sections.find((section) => section.title === "US-ONLY ROUTERS");
    assert.deepEqual(
      usOnly?.entries.map((entry) => entry.shortId),
      ["kimi-k3-us"],
    );
  });

  test("buildServerlessCatalogSnapshot captures API pricing and modalities", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        input_modalities: ["text", "image"],
      }),
      ...mockServerlessModelRows({
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "2.1", unit: "1M tokens" },
          { sku: "LLM input tokens (cached)", amount: "0.21", unit: "1M tokens" },
          { sku: "LLM output tokens", amount: "6.6", unit: "1M tokens" },
        ],
      }).slice(1),
    ]);

    assert.deepEqual(snapshot.inputModalitiesById.get("accounts/fireworks/models/glm-5p2"), ["text", "image"]);
    const pricing = snapshot.pricingById.get("accounts/fireworks/routers/glm-5p2-fast");
    assert.equal(pricing?.tier, "fast");
    assert.equal(pricing?.input, 2.1);
    assert.equal(pricing?.output, 6.6);
  });

  test("parseSkuPricing reads flat string amounts", () => {
    assert.equal(moneyToUsd({ units: "1", nanos: 500_000_000 }), 1.5);
    assert.deepEqual(parseSkuPricing([
      { sku: "LLM input tokens (uncached)", amount: "0.95" },
      { sku: "LLM input tokens (cached)", amount: "0.16" },
      { sku: "LLM output tokens", amount: "4" },
    ]), { input: 0.95, cachedInput: 0.16, output: 4 });
  });

  test("inputModalitiesFromModel prefers explicit API modalities", () => {
    assert.deepEqual(inputModalitiesFromModel({ input_modalities: ["text", "image"] }), ["text", "image"]);
    assert.deepEqual(inputModalitiesFromModel({ supportsImageInput: true }), ["text", "image"]);
  });

  test("snapshot routerBaseModelById uses model id when name is absent", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p2",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
      }),
    ]);
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/glm-5p2-fast"),
      "accounts/fireworks/models/glm-5p2",
    );
  });

  test("adds alias routers from the API aliases field", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        aliases: [
          "accounts/fireworks/routers/kimi-latest",
          "accounts/fireworks/routers/kimi-fast-latest",
        ],
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-latest"));
    assert.ok(ids.includes("accounts/fireworks/routers/kimi-fast-latest"));
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/kimi-latest"),
      "accounts/fireworks/models/kimi-k3",
    );
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/kimi-fast-latest"),
      "accounts/fireworks/models/kimi-k3",
    );
    // The standard-tier alias inherits this row's standard pricing; the
    // fast-latest alias must not (it expects fast-tier rates).
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-latest")?.tier, "standard");
    assert.equal(snapshot.pricingById.get("accounts/fireworks/routers/kimi-fast-latest"), undefined);
    const kimiLatest = snapshot.entries.find((entry) => entry.shortId === "kimi-latest");
    assert.equal(kimiLatest?.displayName, "Kimi K3 (Latest)");
  });

  test("does not synthesize alias routers the API does not report", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
      }),
    ]);
    const ids = snapshot.entries.map((entry) => entry.id);
    assert.equal(ids.includes("accounts/fireworks/routers/kimi-latest"), false);
    assert.equal(ids.includes("accounts/fireworks/routers/kimi-fast-latest"), false);
  });

  test("preserves turbo router display names after catalog refresh", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k2p6",
        display_name: "Kimi K2.6",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/kimi-k2p6-turbo",
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "2" },
          { sku: "LLM output tokens", amount: "8" },
        ],
      }),
    ]);

    const turbo = snapshot.entries.find((entry) => entry.shortId === "kimi-k2p6-turbo");
    assert.equal(turbo?.displayName, "Kimi K2.6 Turbo");
    assert.equal(turbo?.baseModelId, "accounts/fireworks/models/kimi-k2p6");
  });

  test("priority rows are not priced", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        serverless_mode: "priority",
        service_tier: "priority",
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "3.75" },
          { sku: "LLM output tokens", amount: "18.75" },
        ],
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/kimi-k3-fast",
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "3" },
          { sku: "LLM output tokens", amount: "15" },
        ],
      }),
    ]);

    assert.equal(snapshot.pricingById.get("accounts/fireworks/models/kimi-k3"), undefined);

    const fastRouterPricing = snapshot.pricingById.get("accounts/fireworks/routers/kimi-k3-fast");
    assert.equal(fastRouterPricing?.tier, "fast");
    assert.equal(fastRouterPricing?.input, 3);
    assert.equal(fastRouterPricing?.output, 15);
  });

  for (const order of ["standard row first", "spot row first"]) {
    test(`spot rows price only their -spot router, never the base model or its -latest alias (${order})`, () => {
      const skus = (input, cached, output) => [
        { sku: "LLM input tokens (uncached)", amount: String(input) },
        { sku: "LLM input tokens (cached)", amount: String(cached) },
        { sku: "LLM output tokens", amount: String(output) },
      ];
      const standardRow = mockServerlessModel({
        id: "accounts/fireworks/models/example-model",
        display_name: "Example Model",
        aliases: ["accounts/fireworks/routers/example-latest"],
        pricing: skus(1, 0.1, 4),
      });
      const spotRow = mockServerlessModel({
        id: "accounts/fireworks/models/example-model",
        display_name: "Example Model",
        serverless_mode: "spot",
        usage_identifier: "accounts/fireworks/routers/example-model-spot",
        pricing: skus(0.7, 0.07, 2.8),
      });
      const snapshot = buildServerlessCatalogSnapshot(
        order === "spot row first" ? [spotRow, standardRow] : [standardRow, spotRow],
      );

      const base = snapshot.pricingById.get("accounts/fireworks/models/example-model");
      assert.equal(base?.tier, "standard");
      assert.equal(base?.input, 1);
      assert.equal(base?.cachedInput, 0.1);
      assert.equal(base?.output, 4);

      const latest = snapshot.pricingById.get("accounts/fireworks/routers/example-latest");
      assert.equal(latest?.tier, "standard");
      assert.equal(latest?.input, 1);
      assert.equal(latest?.output, 4);

      const spot = snapshot.pricingById.get("accounts/fireworks/routers/example-model-spot");
      assert.equal(spot?.tier, "spot");
      assert.equal(spot?.input, 0.7);
      assert.equal(spot?.output, 2.8);
    });
  }

  test("an unrecognized serverless mode prices its own router, never the base model", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/example-model",
        display_name: "Example Model",
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "1" },
          { sku: "LLM output tokens", amount: "4" },
        ],
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/example-model",
        display_name: "Example Model",
        serverless_mode: "ultrafast",
        usage_identifier: "accounts/fireworks/routers/example-model-ultrafast",
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "6" },
          { sku: "LLM output tokens", amount: "30" },
        ],
      }),
    ]);
    const base = snapshot.pricingById.get("accounts/fireworks/models/example-model");
    assert.equal(base?.tier, "standard");
    assert.equal(base?.input, 1);
    const router = snapshot.pricingById.get("accounts/fireworks/routers/example-model-ultrafast");
    assert.equal(router?.tier, "ultrafast");
    assert.equal(router?.input, 6);
  });

  test("a fast-latest alias mirrors its fast-mode row pricing", () => {
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/kimi-k3",
        display_name: "Kimi K3",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/kimi-k3-fast",
        aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "1.9" },
          { sku: "LLM output tokens", amount: "8" },
        ],
      }),
    ]);
    const fastLatestPricing = snapshot.pricingById.get("accounts/fireworks/routers/kimi-fast-latest");
    assert.equal(fastLatestPricing?.tier, "fast");
    assert.equal(fastLatestPricing?.input, 1.9);
    assert.equal(
      snapshot.routerBaseModelById.get("accounts/fireworks/routers/kimi-fast-latest"),
      "accounts/fireworks/models/kimi-k3",
    );
  });

  test("a fast-latest alias borrows its own model's fast rates, never a sibling version's", () => {
    // glm-5p1-fast is inserted first: a family-prefix matcher would return its
    // rates for glm-fast-latest, but the alias sits on glm-5p2's rows.
    const snapshot = buildServerlessCatalogSnapshot([
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p1",
        display_name: "GLM 5.1",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p1-fast",
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "9.9" },
          { sku: "LLM output tokens", amount: "9.9" },
        ],
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p2",
        display_name: "GLM 5.2",
        aliases: ["accounts/fireworks/routers/glm-latest"],
      }),
      mockServerlessModel({
        id: "accounts/fireworks/models/glm-5p2",
        display_name: "GLM 5.2",
        serverless_mode: "fast",
        usage_identifier: "accounts/fireworks/routers/glm-5p2-fast",
        aliases: ["accounts/fireworks/routers/glm-fast-latest"],
        pricing: [
          { sku: "LLM input tokens (uncached)", amount: "2.1" },
          { sku: "LLM output tokens", amount: "6.6" },
        ],
      }),
    ]);
    const fastLatestPricing = snapshot.pricingById.get("accounts/fireworks/routers/glm-fast-latest");
    assert.equal(fastLatestPricing?.tier, "fast");
    assert.equal(fastLatestPricing?.input, 2.1);
    assert.equal(fastLatestPricing?.output, 6.6);
  });

  test("warmServerlessPricingCache never sends a non-Fireworks key to the gateway", async () => {
    const previousFetch = globalThis.fetch;
    const requestedKeys = [];
    globalThis.fetch = async (_url, options) => {
      requestedKeys.push(options?.headers?.Authorization ?? "");
      return { ok: true, json: async () => ({ models: [] }) };
    };
    try {
      await warmServerlessPricingCache("sk-ant-not-a-fireworks-key");
      await warmServerlessPricingCache("fpk_firepass_key_0000000000000000");
      assert.deepEqual(requestedKeys, [], "must not call the gateway with a non-fw_ key");

      await warmServerlessPricingCache("fw_real_fireworks_key");
      assert.deepEqual(requestedKeys, ["Bearer fw_real_fireworks_key"]);
    } finally {
      globalThis.fetch = previousFetch;
      setServerlessCatalogSnapshot(null);
    }
  });

  test("model list groups aliases and lists every model version", () => {
    const entry = (shortId, kind, baseModelId = undefined, created = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
      ...(created !== undefined ? { created } : {}),
    });
    const sections = organizeCatalogForDisplay([
      entry("firerouter", "routers"),
      autoCatalogEntry(),
      entry("glm-5p1", "models", undefined, 100),
      entry("glm-5p2", "models", undefined, 300),
      entry("glm-5p2-fast", "routers"),
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("glm-fast-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("kimi-k2p6", "models", undefined, 200),
      entry("kimi-k2p7-code", "models", undefined, 400),
      entry("kimi-k3", "models", undefined, 500),
      entry("kimi-k3-fast", "routers"),
      entry("kimi-latest", "routers", "accounts/fireworks/models/kimi-k3"),
      entry("kimi-fast-latest", "routers", "accounts/fireworks/models/kimi-k3"),
      entry("minimax-m2p7", "models", undefined, 150),
      entry("minimax-m3", "models", undefined, 600),
      entry("minimax-latest", "routers", "accounts/fireworks/models/minimax-m3"),
    ]);
    const idsBySection = Object.fromEntries(sections.map((section) => [
      section.title,
      section.entries.map(({ shortId }) => shortId),
    ]));

    assert.deepEqual(idsBySection, {
      // auto leads the section so the default recommendation is listed first.
      "SMART ROUTERS": ["auto", "firerouter"],
      "LATEST ROUTERS": ["glm-latest", "kimi-latest", "minimax-latest"],
      "FAST ROUTERS": ["glm-fast-latest", "kimi-fast-latest"],
      // Every version, newest first — no family collapsing.
      "INDIVIDUAL MODELS": ["minimax-m3", "kimi-k3", "kimi-k2p7-code", "glm-5p2", "kimi-k2p6", "minimax-m2p7", "glm-5p1"],
    });
  });

  test("model list synthesizes the auto rows", () => {
    const catalog = [{
      id: "accounts/fireworks/routers/glm-latest",
      shortId: "glm-latest",
      displayName: "GLM 5.2 (Latest)",
      kind: "serverless",
    }];

    const listed = catalogWithAutoEntry(catalog);
    assert.deepEqual(listed.map((e) => e.shortId), ["auto", "glm-latest"]);
    assert.equal(listed[0].displayName, "Nexus Auto");
    assert.equal(listed[1].displayName, "GLM 5.2 (Latest)");

    // A gateway-supplied auto row must not be duplicated by the synthesized one.
    const withGatewayRow = [autoCatalogEntry(), ...catalog];
    assert.deepEqual(
      catalogWithAutoEntry(withGatewayRow).map((e) => e.shortId),
      ["auto", "glm-latest"],
    );
    // A retired auto-instant row in the input is dropped, not displayed.
    const withAllGatewayRows = [autoCatalogEntry(), autoCatalogEntry("auto-instant"), ...catalog];
    assert.deepEqual(
      catalogWithAutoEntry(withAllGatewayRows).map((e) => e.shortId),
      ["auto", "glm-latest"],
    );
  });

  test("individual models list every version, newest first", () => {
    const entry = (shortId, kind, baseModelId = undefined, created = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
      ...(created !== undefined ? { created } : {}),
    });
    const sections = organizeCatalogForDisplay([
      entry("deepseek-flash-latest", "routers", "accounts/fireworks/models/deepseek-v4-flash-0731"),
      entry("deepseek-pro-latest", "routers", "accounts/fireworks/models/deepseek-v4-pro-0813"),
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("deepseek-v4-flash-0731", "models", undefined, 400),
      entry("deepseek-v4-pro-0813", "models", undefined, 300),
      entry("deepseek-v4-flash", "models", undefined, 200),
      entry("glm-5p2", "models", undefined, 100),
      // Standalone model with no -latest alias: still listed, since harnesses
      // can be pinned to it.
      entry("gpt-oss-120b", "models", undefined, 500),
    ]);
    const individual = sections.find((section) => section.title === "INDIVIDUAL MODELS")?.entries
      .map(({ shortId }) => shortId);

    assert.deepEqual(individual, [
      "gpt-oss-120b",
      "deepseek-v4-flash-0731",
      "deepseek-v4-pro-0813",
      "deepseek-v4-flash",
      "glm-5p2",
    ]);
  });

  test("a -latest router pinned to an older version cannot hide a newer model", () => {
    const entry = (shortId, kind, baseModelId = undefined, created = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
      ...(created !== undefined ? { created } : {}),
    });
    // glm-latest still resolves to 5p2 while the catalog already serves 5p3.
    // Both versions stay listed; recency, not the alias, orders them.
    const sections = organizeCatalogForDisplay([
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p2"),
      entry("glm-5p2", "models", undefined, 100),
      entry("glm-5p3", "models", undefined, 500),
      entry("newfamily-2p1", "models", undefined, 200),
      entry("newfamily-3", "models", undefined, 400),
    ]);
    const individual = sections.find((section) => section.title === "INDIVIDUAL MODELS")?.entries
      .map(({ shortId }) => shortId);

    assert.deepEqual(individual, ["glm-5p3", "newfamily-3", "newfamily-2p1", "glm-5p2"]);
  });

  test("a -flash-latest alias keeps Flash a family of its own", () => {
    const entry = (shortId, kind, baseModelId = undefined, created = undefined) => ({
      id: `accounts/fireworks/${kind}/${shortId}`,
      shortId,
      displayName: shortId,
      kind: "serverless",
      ...(baseModelId ? { baseModelId } : {}),
      ...(created !== undefined ? { created } : {}),
    });
    const withAlias = organizeCatalogForDisplay([
      entry("glm-latest", "routers", "accounts/fireworks/models/glm-5p3"),
      entry("glm-flash-latest", "routers", "accounts/fireworks/models/glm-5p2-flash"),
      entry("glm-5p2", "models", undefined, 100),
      entry("glm-5p3", "models", undefined, 300),
      entry("glm-5p2-flash", "models", undefined, 200),
    ]);
    const bySection = Object.fromEntries(withAlias.map((s) => [
      s.title,
      s.entries.map((e) => e.shortId),
    ]));
    assert.deepEqual(bySection["LATEST ROUTERS"], ["glm-flash-latest", "glm-latest"]);
    // Flash is a distinct model, not a speed tier: it must not land in FAST ROUTERS.
    assert.equal(bySection["FAST ROUTERS"], undefined);
    assert.deepEqual(bySection["INDIVIDUAL MODELS"], ["glm-5p3", "glm-5p2-flash", "glm-5p2"]);
  });
});
