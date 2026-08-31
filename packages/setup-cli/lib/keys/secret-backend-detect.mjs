export const ENCRYPTED_FILE_BACKEND_LABEL = "Encrypted file (AES-256-GCM, 0600)";

const DEFAULT_FILE_UNAVAILABLE_ERROR =
  "HOME is not set and XDG_DATA_HOME is unset. Set HOME (or XDG_DATA_HOME) to a writable path so the encrypted-file store can be created.";

/**
 * @param {string | null} fileLocation
 * @param {{ forced?: boolean, error?: string, unavailableError?: string }} [options]
 * @returns {{
 *   backend: "file" | "unavailable",
 *   label: string,
 *   location?: string,
 *   forced?: boolean,
 *   error?: string,
 * }}
 */
export function fileBackendDetectionResult(fileLocation, options = {}) {
  if (!fileLocation) {
    return {
      backend: "unavailable",
      label: "Unavailable",
      error: options.unavailableError ?? options.error ?? DEFAULT_FILE_UNAVAILABLE_ERROR,
    };
  }
  return {
    backend: "file",
    label: ENCRYPTED_FILE_BACKEND_LABEL,
    location: fileLocation,
    ...(options.forced !== undefined ? { forced: options.forced } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}
