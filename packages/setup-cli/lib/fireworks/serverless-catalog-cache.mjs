import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** @typedef {{ slug: string, label: string, input: number, cachedInput: number, output: number, tier: string, source: string }} ServerlessPricing */

/** @typedef {{ entries: import("./models.mjs").CatalogEntry[], pricingById: Map<string, ServerlessPricing>, inputModalitiesById: Map<string, string[]>, routerBaseModelById: Map<string, string>, contextLengthById: Map<string, number>, supportsToolsById: Map<string, boolean> }} ServerlessCatalogSnapshot */

/** @type {ServerlessCatalogSnapshot | null} */
let activeSnapshot = null;
// Distinguishes "this process explicitly set the snapshot (even null = no
// catalog)" from "no snapshot touched yet". `get` lazy-loads the disk cache only
// once, in a fresh process, so a `setServerlessCatalogSnapshot(null)` cleanup
// can never resurrect stale disk data.
let snapshotResolved = false;

// How long a persisted catalog snapshot is considered fresh before an eligible
// command refreshes it from the network. Overridable for tests.
export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
export function catalogTtlMs() {
  const raw = Number(process.env.NEXUS_CATALOG_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CATALOG_TTL_MS;
}

// NEXUS_CACHE_DIR lets tests (and CI) point persisted caches at
// a throwaway dir so in-process loads never touch the developer's real
// ~/.nexus. When set, it's scoped by HOME so spawned CLI children (which
// inherit NEXUS_CACHE_DIR but each get their own temp HOME) read their own
// cache file instead of all colliding on one.
export function scopedCacheFilePath(filename, home = process.env.HOME ?? os.homedir()) {
  let dir = process.env.NEXUS_CACHE_DIR;
  if (dir) {
    const scope = createHash("sha1").update(home).digest("hex").slice(0, 12);
    dir = path.join(dir, scope);
  } else {
    dir = path.join(home, ".nexus");
  }
  return path.join(dir, filename);
}

function cacheFilePath(home) {
  return scopedCacheFilePath("catalog-cache.json", home);
}

function pairs(map) {
  return map instanceof Map ? [...map.entries()] : [];
}

function toMap(pairs) {
  return new Map(Array.isArray(pairs) ? pairs : []);
}

/** JSON-safe snapshot form: Maps become [key, value] arrays. */
function serializeSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }
  return {
    entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
    pricingById: pairs(snapshot.pricingById),
    inputModalitiesById: pairs(snapshot.inputModalitiesById),
    routerBaseModelById: pairs(snapshot.routerBaseModelById),
    contextLengthById: pairs(snapshot.contextLengthById),
    supportsToolsById: pairs(snapshot.supportsToolsById),
  };
}

function deserializeSnapshot(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.entries)) {
    return null;
  }
  return {
    entries: value.entries,
    pricingById: toMap(value.pricingById),
    inputModalitiesById: toMap(value.inputModalitiesById),
    routerBaseModelById: toMap(value.routerBaseModelById),
    contextLengthById: toMap(value.contextLengthById),
    supportsToolsById: toMap(value.supportsToolsById),
  };
}

/**
 * Read the persisted cache file: `{ cachedAt, snapshot }`. Handles the legacy
 * pre-TTL format (a bare snapshot JSON without the wrapper) as an age-less
 * cache — `cachedAt` is 0, so it reads as stale and is refreshed on the next
 * eligible command. Returns null when the file is missing or unreadable.
 * `keyFingerprint` identifies the API key the catalog was fetched with ("" for
 * older caches); see {@link catalogKeyFingerprint}.
 * @returns {{ cachedAt: number, snapshot: ServerlessCatalogSnapshot | null, keyFingerprint: string } | null}
 */
export function readCatalogCache(home) {
  let raw;
  try {
    raw = readFileSync(cacheFilePath(home), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return null;
    }
    // New format: { cachedAt, snapshot }. Legacy: snapshot fields at the top.
    const hasWrapper = "snapshot" in value;
    const snapshot = deserializeSnapshot(hasWrapper ? value.snapshot : value);
    const cachedAt = hasWrapper && Number.isFinite(value.cachedAt) ? value.cachedAt : 0;
    const keyFingerprint = hasWrapper && typeof value.keyFingerprint === "string" ? value.keyFingerprint : "";
    return { cachedAt, snapshot, keyFingerprint };
  } catch {
    return null;
  }
}

/** Whether the persisted cache snapshot is fresh enough to skip a refetch. */
export function isCatalogCacheFresh() {
  const cache = readCatalogCache();
  if (!cache?.snapshot) {
    return false;
  }
  return Date.now() - cache.cachedAt < catalogTtlMs();
}

// Best-effort disk I/O: the in-memory snapshot is authoritative for the current
// process; the disk copy exists so a FRESH process can recover the last-known
// catalog when offline (registration fallback, `off` cleanup). A broken or
// missing cache file is treated as "no cache" and never breaks the CLI.
function loadPersistedSnapshot() {
  return readCatalogCache()?.snapshot ?? null;
}

function persistSnapshot(snapshot, keyFingerprint) {
  const cachedAt = snapshot ? Date.now() : null;
  try {
    const file = cacheFilePath();
    if (!snapshot) {
      rmSync(file, { force: true });
      return cachedAt;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      cachedAt,
      ...(keyFingerprint ? { keyFingerprint } : {}),
      snapshot: serializeSnapshot(snapshot),
    }));
  } catch {
    // Best-effort — a failed persist must never break catalog loading.
  }
  return cachedAt;
}

/**
 * Set the in-memory serverless catalog snapshot — memory only. This marks the
 * current process's snapshot value (including null, meaning "no catalog") as
 * authoritative; it never touches the disk cache. Use
 * {@link cacheServerlessCatalogSnapshot} when the snapshot is freshly-fetched
 * authoritative data that should survive for offline processes.
 * @param {ServerlessCatalogSnapshot | null} snapshot
 */
export function setServerlessCatalogSnapshot(snapshot) {
  activeSnapshot = snapshot;
  snapshotResolved = true;
}

/**
 * Set the in-memory snapshot AND persist it to the on-disk cache so a fresh
 * process can recover the last-known catalog (e.g. offline registration or
 * `off` cleanup). Only call with a freshly-fetched authoritative snapshot.
 * @param {ServerlessCatalogSnapshot | null} snapshot
 * @param {{ apiKey?: string }} [options] the key the catalog was fetched with.
 * @returns {number | null} Snapshot time, or null when clearing.
 */
export function cacheServerlessCatalogSnapshot(snapshot, { apiKey = "" } = {}) {
  activeSnapshot = snapshot;
  snapshotResolved = true;
  return persistSnapshot(snapshot, apiKey ? catalogKeyFingerprint(apiKey) : "");
}

/**
 * A short one-way fingerprint of the API key a catalog belongs to. The catalog
 * depends on the account (a plan can limit it), so a cache fetched with another
 * key must not be served as fresh. Never store the key itself.
 * @param {string} apiKey
 */
export function catalogKeyFingerprint(apiKey) {
  return createHash("sha256").update(String(apiKey).trim()).digest("hex").slice(0, 16);
}

export function getServerlessCatalogSnapshot() {
  if (!snapshotResolved) {
    activeSnapshot = loadPersistedSnapshot();
    snapshotResolved = true;
  }
  return activeSnapshot;
}

/**
 * Re-read the persisted snapshot into memory, so a long-lived process (or a
 * helper polling for a background refresh) sees rows another process wrote.
 * A missing/unreadable file keeps the in-memory snapshot untouched. Total:
 * never throws.
 */
export function reloadServerlessCatalogSnapshot() {
  const snapshot = loadPersistedSnapshot();
  if (snapshot) {
    activeSnapshot = snapshot;
  }
  snapshotResolved = true;
  return activeSnapshot;
}

/**
 * Mark the persisted catalog stale so the next eligible command refetches it.
 * The snapshot stays on disk as the offline fallback.
 */
export function expireCatalogCache(home) {
  const cache = readCatalogCache(home);
  if (!cache?.snapshot || cache.cachedAt === 0) {
    return;
  }
  try {
    const file = cacheFilePath(home);
    const value = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...value, cachedAt: 0 }));
  } catch {
    // Best-effort, like every other cache write.
  }
}

/** Reset the persisted and in-memory catalog cache. */
export function deletePersistedCatalogCache() {
  try {
    rmSync(cacheFilePath(), { force: true });
  } catch {}
  activeSnapshot = null;
  snapshotResolved = false;
}

// Lookups lazy-load the persisted snapshot for short-lived consumers such as
// the statusline helper. An explicit setServerlessCatalogSnapshot(null) still
// wins because it marks the snapshot resolved.

/**
 * @param {string} modelRef
 * @returns {ServerlessPricing | null}
 */
export function lookupCachedServerlessPricing(modelRef) {
  return getServerlessCatalogSnapshot()?.pricingById.get(modelRef) ?? null;
}

/**
 * @param {string} modelRef
 * @returns {string[] | null}
 */
export function lookupCachedInputModalities(modelRef) {
  return getServerlessCatalogSnapshot()?.inputModalitiesById.get(modelRef) ?? null;
}

/**
 * @param {string} modelRef
 * @returns {number | null}
 */
export function lookupCachedContextLength(modelRef) {
  return getServerlessCatalogSnapshot()?.contextLengthById.get(modelRef) ?? null;
}

/**
 * @param {string} modelRef
 * @returns {boolean | null}
 */
export function lookupCachedSupportsTools(modelRef) {
  const value = getServerlessCatalogSnapshot()?.supportsToolsById.get(modelRef);
  return value === undefined ? null : value;
}

/**
 * @param {string} routerId Full accounts/fireworks/routers/... id.
 * @returns {string | null}
 */
export function lookupCachedRouterBaseModel(routerId) {
  const snapshot = getServerlessCatalogSnapshot();
  if (!snapshot || !routerId) {
    return null;
  }
  const normalized = routerId.replace(/\[1m\]$/i, "");
  return snapshot.routerBaseModelById.get(normalized) ?? null;
}

/**
 * @param {string} modelId Full accounts/fireworks/models|routers/... id.
 * @returns {import("./models.mjs").CatalogEntry | null}
 */
export function lookupCatalogEntryById(modelId) {
  const snapshot = getServerlessCatalogSnapshot();
  if (!snapshot || !modelId) {
    return null;
  }
  const normalized = modelId.replace(/\[1m\]$/i, "");
  return snapshot.entries.find((entry) => entry.id === normalized) ?? null;
}

/** Whether a model reference is present in the cached serverless catalog. */
export function isCachedServerlessModelRef(modelRef) {
  const snapshot = getServerlessCatalogSnapshot();
  if (!snapshot || typeof modelRef !== "string" || !modelRef.trim()) {
    return false;
  }
  const bare = modelRef.trim().replace(/\[1m\]$/i, "");
  if (bare.startsWith("accounts/fireworks/")) {
    return snapshot.entries.some((entry) => entry?.id === bare);
  }
  return snapshot.entries.some((entry) => entry?.shortId === bare);
}
