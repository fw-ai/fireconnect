import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Electron `safeStorage`-compatible secret encryption.
 *
 * VS Code Chat's BYOK secrets (the `customendpoint` `apiKey`) are NOT stored as
 * a per-secret OS keychain entry. `LanguageModelsService` resolves the
 * `${input:chat.lm.secret.<id>}` reference via `ISecretStorageService.get(<id>)`,
 * which reads an **encrypted blob from the application-scoped `state.vscdb`**
 * (`ItemTable`, key `secret://<id>`) and decrypts it with Electron `safeStorage`
 * (see VS Code's `BaseSecretStorageService` + `EncryptionMainService`).
 *
 * The value stored in `state.vscdb` is exactly
 * `JSON.stringify(safeStorage.encryptString(plaintext))`, i.e. the JSON form of a
 * Node Buffer — `{"type":"Buffer","data":[...]}` — whose bytes are the platform
 * `safeStorage` ciphertext. This module reproduces that ciphertext so the harness
 * can write a key VS Code can actually read.
 *
 * Platform schemes (matching Chromium's OSCrypt, which Electron `safeStorage`
 * wraps — verified against Chromium's `os_crypt/async/common/algorithm.mojom`
 * and `encryptor.cc`):
 * - macOS:   `v10` + AES-128-CBC. Key = PBKDF2-HMAC-SHA1(masterPw, "saltysalt",
 *            1003, 16). IV = 16×0x20. The master password is a random value in
 *            the login keychain under service "<AppName> Safe Storage".
 * - Windows: `v10` + AES-256-GCM. Layout: `v10(3) + nonce(12) + ciphertext +
 *            tag(16)`. The 32-byte key is DPAPI-protected
 *            (`CryptProtectData`, CurrentUser) and stored base64-encoded under
 *            `os_crypt.encrypted_key` in the `Local State` JSON file (with a
 *            5-byte `"DPAPI"` prefix before the protected blob).
 * - Linux:   `v11` + AES-128-CBC with **1** PBKDF2 iteration when a keyring
 *            (libsecret) holds the master password, else `v10` with the
 *            hardcoded "peanuts" password (the "basic_text" backend) — also
 *            1 iteration. Same KDF/cipher as macOS but with 1 iteration, not
 *            1003 (which is macOS-only).
 *
 * Test seam: when FIRECONNECT_VSCODE_SECRET_PLAINTEXT is set, encrypt/decrypt are
 * the identity (the raw key is stored verbatim). VS Code does NOT read such a
 * value — this is only for exercising the harness's logic headlessly/in CI.
 */

const SALT = "saltysalt";
const MAC_ITERATIONS = 1003;
const LINUX_ITERATIONS = 1;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, 0x20);
const LINUX_BASIC_PASSWORD = "peanuts";

/* Windows (Chromium OSCrypt async — AES-256-GCM with a DPAPI-protected key). */
const WIN_VERSION = "v10";
const WIN_NONCE_LEN = 12;
const WIN_TAG_LEN = 16;
const WIN_KEY_LEN = 32;
const DPAPI_PREFIX = "DPAPI";

/**
 * @returns {boolean} whether the plaintext test seam is active.
 * Strictly `=== "1"` so that `FIRECONNECT_VSCODE_SECRET_PLAINTEXT=0` (or any
 * other value) does NOT enable plaintext — a common footgun with truthy-string
 * env checks. Exported for unit tests.
 */
export function plaintextMode() {
  return process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT === "1";
}

/**
 * On Linux, Electron `safeStorage` (and thus VS Code/Cursor) only encrypts when
 * a Secret Service implementation (libsecret/gnome-keyring/kwallet) is available
 * to hold the master password. Without it, Chromium falls back to the
 * hardcoded "peanuts" password — i.e. the stored secret is **obfuscated, not
 * encrypted**. Detect that so we can warn the user.
 *
 * Returns false on macOS/Windows (real OS keychain always available) and when
 * a Secret Service appears to be present on Linux.
 * @returns {boolean}
 */
/** Memoized result of {@link linuxSafeStorageIsObfuscatedFallback} (process-constant). */
let obfuscatedFallbackMemo;

/**
 * On Linux, Electron `safeStorage` (and thus VS Code/Cursor) only encrypts when
 * a Secret Service implementation (libsecret/gnome-keyring/kwallet) is available
 * to hold the master password. Without it, Chromium falls back to the
 * hardcoded "peanuts" password — i.e. the stored secret is **obfuscated, not
 * encrypted**. Detect that so we can warn the user.
 *
 * Returns false on macOS/Windows (real OS keychain always available) and when
 * a Secret Service appears to be present on Linux. Memoized because platform
 * and `secret-tool` availability do not change mid-process and this is called
 * 2-4 times per on/status run.
 * @returns {boolean}
 */
export function linuxSafeStorageIsObfuscatedFallback() {
  if (obfuscatedFallbackMemo !== undefined) {
    return obfuscatedFallbackMemo;
  }
  if (process.platform !== "linux") {
    obfuscatedFallbackMemo = false;
    return false;
  }
  // Heuristic: if `secret-tool` (libsecret-tools) isn't on PATH, there's almost
  // certainly no Secret Service D-Bus endpoint to hold the master password.
  // This is a best-effort check; safeStorage itself makes the same call at
  // runtime, so a false negative here just means we don't warn.
  try {
    const res = spawnSync("secret-tool", ["--version"], { stdio: "ignore" });
    obfuscatedFallbackMemo = Boolean(res.error || res.status !== 0);
    return obfuscatedFallbackMemo;
  } catch {
    obfuscatedFallbackMemo = true;
    return true;
  }
}

/**
 * Electron app name for the variant. Stable VS Code's keychain item is
 * "Code Safe Storage"; Insiders is "Code - Insiders Safe Storage".
 * @param {"stable" | "insiders"} [variant]
 * @returns {string}
 */
function appNameFor(variant) {
  return variant === "insiders" ? "Code - Insiders" : "Code";
}

/* -------------------------------------------------------------------------- */
/* OSCrypt AES (macOS + Linux)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Derive the AES-128 key from a master password (Chromium OSCrypt KDF).
 * @param {string} masterPassword @param {number} iterations
 */
function deriveKey(masterPassword, iterations) {
  return crypto.pbkdf2Sync(masterPassword, SALT, iterations, KEY_LEN, "sha1");
}

/**
 * Chromium OSCrypt AES encryption (macOS `v10`, Linux `v10`/`v11`). Exported for
 * unit tests; production callers go through {@link encryptSecret}.
 * @param {string} plaintext @param {string} masterPassword @param {string} version
 * @param {number} [iterations=MAC_ITERATIONS]
 */
export function aesEncrypt(plaintext, masterPassword, version, iterations = MAC_ITERATIONS) {
  const key = deriveKey(masterPassword, iterations);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(version, "latin1"), body]);
}

/**
 * Chromium OSCrypt AES decryption (inverse of {@link aesEncrypt}). Exported for
 * unit tests; production callers go through {@link decryptSecret}.
 * @param {Buffer} blob @param {string} masterPassword
 * @param {number} [iterations=MAC_ITERATIONS]
 */
export function aesDecrypt(blob, masterPassword, iterations = MAC_ITERATIONS) {
  const key = deriveKey(masterPassword, iterations);
  const body = blob.subarray(3); // strip the 3-byte "vNN" version prefix
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* macOS — master password from the login keychain                            */
/* -------------------------------------------------------------------------- */

/**
 * Read the Safe Storage master password from the macOS login keychain.
 * @param {"stable" | "insiders"} [variant]
 * @returns {string} the password, or "" if not found.
 */
function macReadMasterPassword(variant) {
  const service = `${appNameFor(variant)} Safe Storage`;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return "";
  }
  return (r.stdout || "").replace(/\n$/, "");
}

/* -------------------------------------------------------------------------- */
/* Linux — master password from libsecret, else "peanuts" (basic backend)      */
/* -------------------------------------------------------------------------- */

/**
 * Try to read the Safe Storage master password from the Linux keyring. Chromium
 * stores it under a libsecret item labelled "<App> Safe Storage". We probe the
 * common attribute schemes; on failure callers fall back to the basic backend.
 * @param {"stable" | "insiders"} [variant]
 * @returns {string} the password, or "" when no keyring entry is found.
 */
function linuxReadMasterPassword(variant) {
  const app = appNameFor(variant);
  const attempts = [
    ["application", app],
    ["application", app.toLowerCase()],
    ["application", "chromium"],
  ];
  for (const attrs of attempts) {
    const r = spawnSync("secret-tool", ["lookup", ...attrs], { encoding: "utf8" });
    if (r.status === 0 && (r.stdout || "").length > 0) {
      return r.stdout.replace(/\n$/, "");
    }
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* Windows — DPAPI via PowerShell (ProtectedData, CurrentUser)                 */
/* -------------------------------------------------------------------------- */

/**
 * Run a PowerShell snippet that prints a single base64 line, or "" on failure.
 * @param {string} script
 * @returns {string}
 */
function runPowerShell(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return "";
  }
  return (r.stdout || "").replace(/\r?\n/g, "").trim();
}

/**
 * DPAPI-protect a raw byte buffer (buffer-based to preserve binary data).
 * The previous string-based round-trip corrupted 32-byte keys because it
 * routed raw bytes through a UTF-8 string (yielding 45 bytes for a 32-byte
 * key with high-bit bytes). This function never touches a text encoding.
 * @param {Buffer} buf
 * @returns {Buffer} DPAPI-protected bytes (empty on failure).
 */
function windowsProtectBuffer(buf) {
  const b64 = buf.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($enc)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64") : Buffer.alloc(0);
}

/**
 * DPAPI-unprotect a raw byte buffer (buffer-based to preserve binary data).
 * Returns the exact bytes DPAPI produces — no UTF-8 conversion — so 32-byte
 * AES-256 keys survive the round-trip.
 * @param {Buffer} blob
 * @returns {Buffer} the decrypted bytes (empty on failure).
 */
function windowsUnprotectBuffer(blob) {
  const b64 = blob.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($dec)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64") : Buffer.alloc(0);
}

/** @param {string} plaintext @returns {Buffer} DPAPI-protected bytes (empty on failure). */
function windowsProtect(plaintext) {
  return windowsProtectBuffer(Buffer.from(plaintext, "utf8"));
}

/** @param {Buffer} blob @returns {string} the decrypted plaintext (empty on failure). */
function windowsUnprotect(blob) {
  const buf = windowsUnprotectBuffer(blob);
  return buf.length > 0 ? buf.toString("utf8") : "";
}

/* -------------------------------------------------------------------------- */
/* Windows — AES-256-GCM with a DPAPI-protected key from `Local State`         */
/* -------------------------------------------------------------------------- */

/**
 * Read the Chromium/Electron `os_crypt` master key from VS Code's `Local State`
 * JSON file. The key is base64-encoded under `os_crypt.encrypted_key`, prefixed
 * with a 5-byte `"DPAPI"` marker, then DPAPI-protected (CurrentUser). This
 * function loads, decodes, and DPAPI-unprotects it to a raw 32-byte AES-256 key.
 *
 * @param {string} localStatePath absolute path to VS Code's `Local State` file
 * @returns {Buffer} the 32-byte AES-256-GCM key
 * @throws {Error} if the file is missing, the key field is absent, or DPAPI
 *   unprotection fails or yields a wrong-length key.
 */
export function loadWindowsOsCryptKey(localStatePath) {
  let raw;
  try {
    raw = readFileSync(localStatePath, "utf8");
  } catch {
    throw new Error(
      `Could not read VS Code's "Local State" file at ${localStatePath}. Open VS Code once (it creates the OSCrypt key on first launch) and retry.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`VS Code's "Local State" file at ${localStatePath} is not valid JSON.`);
  }
  const encKeyB64 = parsed?.os_crypt?.encrypted_key;
  if (!encKeyB64 || typeof encKeyB64 !== "string") {
    throw new Error(
      `VS Code's "Local State" file at ${localStatePath} has no os_crypt.encrypted_key. Open VS Code once and retry.`,
    );
  }
  const encKey = Buffer.from(encKeyB64, "base64");
  if (encKey.subarray(0, DPAPI_PREFIX.length).toString("latin1") !== DPAPI_PREFIX) {
    // If the prefix is not "DPAPI", this may be App-Bound Encryption (v20),
    // which uses an app-identity DPAPI layer that an external process cannot
    // replicate. Fail clearly rather than producing a corrupt key.
    throw new Error(
      `VS Code's OSCrypt key in "Local State" has an unexpected prefix "${encKey.subarray(0, 5).toString("latin1")}" (expected "DPAPI"). App-Bound Encryption may be enabled; this is not yet supported.`,
    );
  }
  const dpapiBlob = encKey.subarray(DPAPI_PREFIX.length);
  const key = windowsUnprotectBuffer(dpapiBlob);
  if (key.length !== WIN_KEY_LEN) {
    throw new Error(
      `DPAPI-unprotected OSCrypt key from "Local State" is ${key.length} bytes, expected ${WIN_KEY_LEN}.`,
    );
  }
  return key;
}

/**
 * Chromium OSCrypt Windows encryption: `v10` + AES-256-GCM.
 * Layout: `v10(3) + nonce(12) + ciphertext + tag(16)` (tag at the end,
 * confirmed by ground-truth probe against Electron safeStorage on Windows).
 * @param {string} plaintext @param {Buffer} key32 the 32-byte AES-256 key
 * @returns {Buffer}
 */
export function windowsAesGcmEncrypt(plaintext, key32) {
  const nonce = crypto.randomBytes(WIN_NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key32, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(WIN_VERSION, "latin1"), nonce, ciphertext, tag]);
}

/**
 * Chromium OSCrypt Windows decryption (inverse of {@link windowsAesGcmEncrypt}).
 * @param {Buffer} blob @param {Buffer} key32
 * @returns {string}
 */
export function windowsAesGcmDecrypt(blob, key32) {
  const nonce = blob.subarray(WIN_VERSION.length, WIN_VERSION.length + WIN_NONCE_LEN);
  const tag = blob.subarray(blob.length - WIN_TAG_LEN);
  const ciphertext = blob.subarray(
    WIN_VERSION.length + WIN_NONCE_LEN,
    blob.length - WIN_TAG_LEN,
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key32, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Encrypt a secret into the exact string VS Code stores in `state.vscdb`
 * (`JSON.stringify(safeStorage.encryptString(value))`).
 * @param {string} plaintext
 * @param {{ variant?: "stable" | "insiders", localStatePath?: string }} [opts]
 *   `localStatePath` is required on Windows (path to VS Code's `Local State`
 *   file, which holds the DPAPI-protected AES-256 key).
 * @returns {string}
 */
export function encryptSecret(plaintext, { variant, localStatePath } = {}) {
  if (plaintextMode()) {
    return plaintext;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    const pw = macReadMasterPassword(variant);
    if (!pw) {
      throw new Error(secretEncryptionUnavailableMessage(variant));
    }
    return JSON.stringify(aesEncrypt(plaintext, pw, "v10", MAC_ITERATIONS));
  }
  if (platform === "win32") {
    const key32 = loadWindowsOsCryptKey(localStatePath);
    const enc = windowsAesGcmEncrypt(plaintext, key32);
    return JSON.stringify(enc);
  }
  // linux / others
  const keyringPw = linuxReadMasterPassword(variant);
  if (keyringPw) {
    // Chromium OSCrypt Linux with a keyring: v11 + 1 PBKDF2 iteration.
    return JSON.stringify(aesEncrypt(plaintext, keyringPw, "v11", LINUX_ITERATIONS));
  }
  // basic_text backend (no keyring): v10 + hardcoded "peanuts" password, 1 iteration.
  return JSON.stringify(aesEncrypt(plaintext, LINUX_BASIC_PASSWORD, "v10", LINUX_ITERATIONS));
}

/**
 * Decrypt a value read from `state.vscdb` (the JSON form of the safeStorage
 * ciphertext) back to plaintext. Returns "" when it can't be decrypted.
 * @param {string} stored
 * @param {{ variant?: "stable" | "insiders", localStatePath?: string }} [opts]
 *   `localStatePath` is required on Windows (path to VS Code's `Local State`
 *   file, which holds the DPAPI-protected AES-256 key).
 * @returns {string}
 */
export function decryptSecret(stored, { variant, localStatePath } = {}) {
  if (stored === "" || stored == null) {
    return "";
  }
  if (plaintextMode()) {
    return stored;
  }
  let blob;
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || !Array.isArray(parsed.data)) {
      return "";
    }
    blob = Buffer.from(parsed.data);
  } catch {
    return "";
  }
  try {
    const platform = os.platform();
    if (platform === "win32") {
      const key32 = loadWindowsOsCryptKey(localStatePath);
      return windowsAesGcmDecrypt(blob, key32);
    }
    const version = blob.subarray(0, 3).toString("latin1");
    let pw;
    let iterations;
    if (platform === "darwin") {
      pw = macReadMasterPassword(variant);
      iterations = MAC_ITERATIONS;
    } else if (version === "v11") {
      // Linux keyring: v11 + keyring master password + 1 iteration.
      pw = linuxReadMasterPassword(variant);
      iterations = LINUX_ITERATIONS;
    } else {
      // Linux basic_text: v10 + "peanuts" + 1 iteration.
      pw = LINUX_BASIC_PASSWORD;
      iterations = LINUX_ITERATIONS;
    }
    if (!pw) {
      return "";
    }
    return aesDecrypt(blob, pw, iterations);
  } catch {
    return "";
  }
}

/**
 * Whether the harness can produce a blob VS Code will decrypt on this machine.
 * @param {{ variant?: "stable" | "insiders", localStatePath?: string }} [opts]
 * @returns {boolean}
 */
export function isSecretEncryptionAvailable({ variant, localStatePath } = {}) {
  if (plaintextMode()) {
    return true;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    return macReadMasterPassword(variant).length > 0;
  }
  if (platform === "win32") {
    // Require a readable Local State with a loadable OSCrypt key. If the key
    // is missing VS Code hasn't launched yet — `on` should fail with the
    // actionable "open VS Code once" message rather than failing mid-encrypt.
    try {
      loadWindowsOsCryptKey(localStatePath);
      return true;
    } catch {
      return false;
    }
  }
  // linux: the basic_text backend always works ("peanuts"); a keyring is a bonus.
  return true;
}

/**
 * @param {"stable" | "insiders"} [variant]
 * @returns {string}
 */
export function secretEncryptionUnavailableMessage(variant) {
  const platform = os.platform();
  if (platform === "darwin") {
    return `Could not read VS Code's "${appNameFor(variant)} Safe Storage" key from the login Keychain, so the API key can't be stored where VS Code Chat reads it. Open VS Code once (it creates this key on first launch) and retry.`;
  }
  if (platform === "win32") {
    return "Could not load VS Code's OSCrypt encryption key from its \"Local State\" file. Open VS Code once (it creates this key on first launch) and retry.";
  }
  return "Could not encrypt the VS Code Chat API key for VS Code's secret storage.";
}
