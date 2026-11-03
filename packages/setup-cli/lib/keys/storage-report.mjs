import process from "node:process";
import { detectSecretBackend } from "./secret-store.mjs";
import { plaintextSecretStoreAvailable } from "./plaintext-secret-store.mjs";
import { formatKeyStorageOverrideHint, isKeyStorageForcedNull } from "./storage-env.mjs";
import { accent } from "../ui/term.mjs";

/**
 * Shared, backend-aware messaging for the places that store a Fireworks API
 * key (`login`, `configure`). Keeps the user
 * informed about *where* their key actually lives — OS keychain vs encrypted
 * file fallback — so sandboxes/Linux-without-keychain users aren't misled.
 */

/**
 * @typedef {Awaited<ReturnType<typeof detectSecretBackend>>} SecretBackend
 */

/**
 * The refusal line when no backend can store a key. Names the file-backend
 * path for headless machines — every credential must land in storage because
 * env vars are not a credential source.
 * @param {string} [error]  backend detection error, when known
 */
export function cannotStoreKeyMessage(error = "") {
  const reason = error
    ? `Cannot store the API key: ${error}`
    : "Cannot store the API key: no secret storage backend is available.";
  return `${reason}\n`
    + `On headless machines, use the file backend instead: ${formatKeyStorageOverrideHint("file")}`;
}

/**
 * Throw a friendly, actionable error if no backend can store a key. Call this
 * *before* attempting `setSecret` so the user gets a clear message instead of
 * a raw storage error.
 *
 * @param {SecretBackend} backend
 * @param {string} [home]
 * @returns {Promise<void>}
 */
export async function assertBackendCanStore(backend, home = process.env.HOME ?? "") {
  if (backend.backend === "unavailable") {
    if (isKeyStorageForcedNull()) {
      throw new Error(cannotStoreKeyMessage(backend.error));
    }
    if (plaintextSecretStoreAvailable(home)) {
      return;
    }
    throw new Error(cannotStoreKeyMessage(backend.error));
  }
}

/**
 * One-line summary of where a key was just stored. Returns "" for unavailable
 * (caller should have refused first).
 *
 * @param {SecretBackend} backend
 * @returns {string}
 */
export function storedKeyMessage(backend) {
  if (backend.backend === "keychain") {
    return `Stored Fireworks API key in the OS keychain (${backend.label}); config files only ever hold a reference to it.`;
  }
  if (backend.backend === "file") {
    const where = backend.location ?? "an encrypted file";
    if (backend.error?.includes("cross-keychain")) {
      return (
        `Stored Fireworks API key in an encrypted file at ${where} `
        + "(AES-256-GCM, 0600). Re-run `nexus update` to restore OS keychain support."
      );
    }
    return (
      `No OS keychain detected; stored Fireworks API key in an encrypted file at ${where} `
      + "(AES-256-GCM, 0600). Install gnome-keyring + secret-service on Linux, then run "
      + "`nexus update` to move it to the OS keychain."
    );
  }
  if (backend.backend === "memory") {
    return "Stored Fireworks API key in the in-memory test store.";
  }
  if (backend.backend === "plaintext") {
    const where = backend.location ?? "~/.nexus/.api-key";
    return (
      `Stored Fireworks API key in a plaintext fallback file at ${where} `
      + "(0600). Secure storage failed; run `nexus update` when keychain access is restored."
    );
  }
  return "";
}

/**
 * Convenience: detect the backend and return the storage summary line plus the
 * backend descriptor. Used by commands that need both the message and the
 * backend for further branching.
 *
 * @param {string} home
 * @returns {Promise<{ backend: SecretBackend, message: string }>}
 */
export async function keyStorageSummaryLine(home) {
  const backend = await detectSecretBackend(home);
  return { backend, message: storedKeyMessage(backend) };
}

/**
 * Short, masked preview of a key: first 3 + last 4 chars (never the whole key).
 * @param {string} key
 * @returns {string}
 */
function maskKey(key) {
  const k = key?.trim() ?? "";
  if (!k) {
    return "";
  }
  return k.length <= 8 ? "****" : `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/**
 * One explicit line stating which Fireworks credential tools will actually use,
 * so the source of truth is never ambiguous — especially at `login`.
 *
 * The stored secret is the source of truth. `FIREWORKS_API_KEY` in the shell
 * is NOT a credential source — Nexus ignores it — so when it is set we warn
 * that it has no effect. Returns "" only when there is no key at all.
 *
 * @param {string} storedKey  the key that was just stored (or resolved as stored)
 * @returns {string}
 */
export function activeKeySourceNote(storedKey) {
  const envKey = process.env.FIREWORKS_API_KEY?.trim() ?? "";
  const stored = storedKey?.trim() ?? "";
  if (envKey) {
    return stored
      ? `Note: ${accent("FIREWORKS_API_KEY")} is set in your shell but Nexus ignores it; the stored key (${maskKey(stored)}) is used.`
      : `Note: ${accent("FIREWORKS_API_KEY")} is set in your shell but Nexus ignores it; run ${accent("nexus login")} to store a key.`;
  }
  if (!stored) {
    return "";
  }
  return "This key is now your source of truth: every harness resolves it from here.";
}
