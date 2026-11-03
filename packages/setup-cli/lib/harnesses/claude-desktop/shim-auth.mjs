/**
 * Shim identity: loopback ports are shared by every local OS user, so an
 * answer on 127.0.0.1:<port> does not prove the listener is our shim. A
 * per-install random secret (0600, under ~/.nexus/claude-desktop) lets the
 * shim prove itself: it answers HEALTH_PATH?n=<nonce> with
 * HMAC-SHA256(secret, nonce), which only a process that can read the
 * secret can compute. The shim imports this, so it pulls in nothing beyond
 * node built-ins and the atomic writer.
 */
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileAtomic } from "../../io/atomic-write.mjs";

export const SHIM_HEALTH_PATH = "/__nexus_health";
const SECRET_FILE = "shim-secret";
const SECRET_RE = /^[0-9a-f]{64}$/;

export function shimSecretPath(dataDir) {
  return path.join(dataDir, SECRET_FILE);
}

/** The stored secret, or null when missing or malformed. */
export async function readShimSecret(dataDir) {
  try {
    const value = (await readFile(shimSecretPath(dataDir), "utf8")).trim();
    return SECRET_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The stored secret, created owner-only on first use. Exclusive create, so
 * the CLI and the shim racing to create it both end up with the same value.
 */
export async function ensureShimSecret(dataDir) {
  const existing = await readShimSecret(dataDir);
  if (existing) {
    // Owner-only even when the file came from elsewhere (a restore, a copy).
    await chmod(shimSecretPath(dataDir), 0o600).catch(() => {});
    return existing;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const fresh = randomBytes(32).toString("hex");
  try {
    await writeFile(shimSecretPath(dataDir), `${fresh}\n`, { mode: 0o600, flag: "wx" });
    return fresh;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const raced = await readShimSecret(dataDir);
  if (raced) return raced;
  // A malformed file (truncated, hand-edited): replace it, owner-only
  // whatever mode the old file had.
  await writeFileAtomic(shimSecretPath(dataDir), `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

export function shimHealthDigest(secret, nonce) {
  return createHmac("sha256", secret).update(String(nonce)).digest("hex");
}

/**
 * True only when the listener on `port` proves it knows `secret`. Bounded by
 * `timeoutMs`; never throws.
 */
export async function probeShimIdentity(port, secret, { timeoutMs = 1000 } = {}) {
  if (!secret) return false;
  const nonce = randomUUID();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${SHIM_HEALTH_PATH}?n=${nonce}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    return (await res.text()).trim() === shimHealthDigest(secret, nonce);
  } catch {
    return false;
  }
}
