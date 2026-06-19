import { mkdtemp, mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSpawnChecker,
  hasActiveUpdateLock,
  tryAcquireUpdateLock,
} from "../lib/update-notify.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIVE_MIN = 5 * 60 * 1000;

describe("shouldSpawnChecker", () => {
  const now = 1_700_000_000_000;

  it("spawns when cache is missing", () => {
    assert.equal(shouldSpawnChecker(null, now), true);
  });

  it("does not spawn while a pending check is in flight", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - FIVE_MIN + 1000, pending: true }, now),
      false,
    );
  });

  it("spawns after pending TTL expires", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - FIVE_MIN - 1000, pending: true }, now),
      true,
    );
  });

  it("uses 24h TTL when latestVersion is known", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - DAY + 1000, latestVersion: "0.3.0" }, now),
      false,
    );
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - DAY - 1000, latestVersion: "0.3.0" }, now),
      true,
    );
  });

  it("uses 1h retry when fetch failed without a known version", () => {
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - HOUR + 1000, latestVersion: null }, now),
      false,
    );
    assert.equal(
      shouldSpawnChecker({ checkedAt: now - HOUR - 1000, latestVersion: null }, now),
      true,
    );
  });

  it("uses 1h retry when fetchFailed is set even with a known version", () => {
    assert.equal(
      shouldSpawnChecker(
        { checkedAt: now - HOUR + 1000, latestVersion: "0.3.0", fetchFailed: true },
        now,
      ),
      false,
    );
    assert.equal(
      shouldSpawnChecker(
        { checkedAt: now - HOUR - 1000, latestVersion: "0.3.0", fetchFailed: true },
        now,
      ),
      true,
    );
  });
});

describe("tryAcquireUpdateLock", () => {
  it("prevents concurrent workers without touching the version cache", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-update-notify-"));
    const cacheDir = path.join(home, ".fireconnect");
    await mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, "update-check.json");

    await writeFile(
      cachePath,
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "0.3.0" }),
    );

    assert.equal(tryAcquireUpdateLock(home), true);
    assert.equal(hasActiveUpdateLock(home), true);
    assert.equal(tryAcquireUpdateLock(home), false);

    const saved = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(saved.latestVersion, "0.3.0");
    assert.equal(saved.pending, undefined);
  });

  it("allows a new worker after the lock TTL expires", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-update-notify-"));
    await mkdir(path.join(home, ".fireconnect"), { recursive: true });

    assert.equal(tryAcquireUpdateLock(home), true);

    const lockPath = path.join(home, ".fireconnect", "update-check.lock");
    const stale = new Date(Date.now() - FIVE_MIN - 1000);
    await utimes(lockPath, stale, stale);

    assert.equal(hasActiveUpdateLock(home), false);
    assert.equal(tryAcquireUpdateLock(home), true);
  });
});
