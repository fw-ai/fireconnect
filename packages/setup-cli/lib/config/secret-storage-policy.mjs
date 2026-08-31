import process from "node:process";
import { isRemoteContext } from "./remote-context.mjs";
import { readKeyStorageOverride } from "../keys/storage-env.mjs";

/**
 * Central policy for secret storage in remote / SSH / WSL sessions.
 * Keys, harness, and environment detection should all consult this module
 * instead of re-deriving overlapping predicates.
 */

/**
 * On Linux SSH/WSL, prefer encrypted-file storage over libsecret. Secret
 * Service is often detected (secret-tool installed) but unusable without an
 * unlocked session keyring.
 *
 * @returns {boolean}
 */
export function shouldPreferFileBackendOnLinux() {
  if (process.platform !== "linux") {
    return false;
  }
  if (readKeyStorageOverride()) {
    return false;
  }
  return isRemoteContext();
}

/**
 * Skip automatic env-key → keychain persistence (harness `on` paths). Remote
 * sessions often lack a working OS keychain; persisting would block or fail.
 *
 * @returns {boolean}
 */
export function shouldSkipEnvKeyAutoPersist() {
  return isRemoteContext();
}

/**
 * Human-readable detail for `detectSecretStorage()` when file backend is chosen
 * due to remote context.
 *
 * @returns {string | undefined}
 */
export function remoteSecretStorageDetail() {
  if (!shouldPreferFileBackendOnLinux()) {
    return undefined;
  }
  return "SSH/remote session — using encrypted-file storage instead of the OS keychain";
}
