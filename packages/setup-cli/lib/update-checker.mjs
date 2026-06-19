import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

const REMOTE_URL =
  "https://raw.githubusercontent.com/fw-ai/fireconnect/main/packages/setup-cli/package.json";

function cachePath(home) {
  return path.join(home, ".fireconnect", "update-check.json");
}

function lockPath(home) {
  return path.join(home, ".fireconnect", "update-check.lock");
}

async function readExistingCache(home) {
  try {
    const raw = await readFile(cachePath(home), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(home, payload) {
  const filePath = cachePath(home);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload), "utf8");
}

async function releaseLock(home) {
  try {
    await unlink(lockPath(home));
  } catch {
    // Lock may already be gone.
  }
}

async function main() {
  const home = process.env.HOME ?? "";
  if (!home) return;

  const existing = await readExistingCache(home);
  const checkedAt = Date.now();
  const latestVersion = existing?.latestVersion ?? null;

  try {
    const res = await fetch(REMOTE_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("fetch failed");
    const { version } = await res.json();
    if (!version) throw new Error("missing version");
    await writeCache(home, { checkedAt, latestVersion: version });
  } catch {
    if (!latestVersion) {
      try {
        await writeCache(home, { checkedAt, latestVersion: null, fetchFailed: true });
      } catch {
        // Silent — main CLI must never be affected.
      }
    }
    // Keep existing cache when we already know a version but fetch failed.
  } finally {
    await releaseLock(home);
  }
}

main().catch(() => {});
