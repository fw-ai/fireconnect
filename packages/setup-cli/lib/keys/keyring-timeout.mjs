/** Match cross-keychain's secret-tool backend command timeout. */
export const KEYRING_OP_TIMEOUT_MS = 10_000;

export class KeyringTimeoutError extends Error {
  /**
   * @param {string} label Short operation name for error messages.
   * @param {number} [timeoutMs]
   */
  constructor(label, timeoutMs = KEYRING_OP_TIMEOUT_MS) {
    super(`Keyring operation timed out after ${timeoutMs}ms (${label})`);
    this.name = "KeyringTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Bound a cross-keychain / libsecret call so a dead OS keyring cannot hang the
 * CLI indefinitely (common on SSH sessions without an unlocked gnome-keyring).
 *
 * Note: this unblocks the caller only; the underlying subprocess is not
 * cancelled and may continue until the OS keyring responds.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label Short operation name for error messages.
 * @returns {Promise<T>}
 */
export async function withKeyringTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new KeyringTimeoutError(label));
        }, KEYRING_OP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
