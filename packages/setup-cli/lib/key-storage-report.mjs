import process from "node:process";
import { detectSecretBackend } from "./secret-store.mjs";
import { plaintextSecretStoreAvailable } from "./plaintext-secret-store.mjs";
import { isKeyStorageForcedNull } from "./key-storage-env.mjs";

/**
 * Shared, backend-aware messaging for the places that store a Fireworks API
 * key (`login`, `configure`, `<harness> on --api-key`). Keeps the user
 * informed about *where* their key actually lives — OS keychain vs encrypted
 * file fallback — so sandboxes/Linux-without-keychain users aren't misled.
 */

/**
 * @typedef {Awaited<ReturnType<typeof detectSecretBackend>>} SecretBackend
 */

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
      throw new Error(
        backend.error
          ? `Cannot store the API key: ${backend.error}`
          : "Cannot store the API key: no secret storage backend is available.",
      );
    }
    if (plaintextSecretStoreAvailable(home)) {
      return;
    }
    throw new Error(
      backend.error
        ? `Cannot store the API key: ${backend.error}`
        : "Cannot store the API key: no secret storage backend is available.",
    );
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
        + "(AES-256-GCM, 0600). Re-run `fireconnect upgrade` to restore OS keychain support."
      );
    }
    return (
      `No OS keychain detected; stored Fireworks API key in an encrypted file at ${where} `
      + "(AES-256-GCM, 0600). Install gnome-keyring + secret-service on Linux, then run "
      + "`fireconnect upgrade` to move it to the OS keychain."
    );
  }
  if (backend.backend === "memory") {
    return "Stored Fireworks API key in the in-memory test store.";
  }
  if (backend.backend === "plaintext") {
    const where = backend.location ?? "~/.fireconnect/.api-key";
    return (
      `Stored Fireworks API key in a plaintext fallback file at ${where} `
      + "(0600). Secure storage failed; run `fireconnect upgrade` when keychain access is restored."
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
