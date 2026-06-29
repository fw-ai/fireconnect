import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { readLocalVersion } from "./version.mjs";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;

function cacheFilePath(home) {
  return path.join(home, ".fireconnect", "update-check.json");
}

function lockFilePath(home) {
  return path.join(home, ".fireconnect", "update-check.lock");
}

function readCache(home) {
  try {
    const raw = readFileSync(cacheFilePath(home), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function semverGt(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

export function shouldSpawnChecker(cache, now = Date.now()) {
  if (!cache) return true;

  const age = now - (cache.checkedAt ?? 0);
  if (cache.pending) {
    return age >= PENDING_TTL_MS;
  }

  // Distinguish a failed fetch (short retry) from a successful one (full TTL).
  if (cache.fetchFailed) {
    return age >= FAILURE_RETRY_MS;
  }

  if (cache.latestVersion) {
    return age >= CACHE_TTL_MS;
  }

  return age >= FAILURE_RETRY_MS;
}

function lockAgeMs(home, now = Date.now()) {
  try {
    const stat = statSync(lockFilePath(home));
    return now - stat.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function hasActiveUpdateLock(home, now = Date.now()) {
  return lockAgeMs(home, now) < PENDING_TTL_MS;
}

export function tryAcquireUpdateLock(home, now = Date.now()) {
  const lockPath = lockFilePath(home);
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    if (hasActiveUpdateLock(home, now)) {
      return false;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // No stale lock to remove.
    }
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    return false;
  }
}

function spawnChecker(home) {
  try {
    const workerPath = fileURLToPath(new URL("./update-checker.mjs", import.meta.url));
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: home },
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Never fail the main process for a background check.
  }
}

export function checkForUpdates(command, homeOverride) {
  if (command === "upgrade" || command === "uninstall" || command === "version") return;

  const home = homeOverride || process.env.HOME || "";
  if (!home) return;

  const localVersion = readLocalVersion();
  const cache = readCache(home);

  if (localVersion && cache?.latestVersion && semverGt(cache.latestVersion, localVersion)) {
    const isGitInstall = existsSync(path.join(home, ".fireconnect", "cli", ".git"));
    const upgradeInstruction = isGitInstall
      ? "Run: fireconnect upgrade"
      : "Run: curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash";
    process.stderr.write(
      `\nFireConnect update available: v${localVersion} → v${cache.latestVersion}\n` +
        `${upgradeInstruction}\n\n`,
    );
  }

  if (shouldSpawnChecker(cache) && tryAcquireUpdateLock(home)) {
    spawnChecker(home);
  }
}
