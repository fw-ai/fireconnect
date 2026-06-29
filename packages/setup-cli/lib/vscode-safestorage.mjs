import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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
 * wraps):
 * - macOS:   `v10` + AES-128-CBC. Key = PBKDF2-HMAC-SHA1(masterPw, "saltysalt",
 *            1003, 16). IV = 16×0x20. The master password is a random value in
 *            the login keychain under service "<AppName> Safe Storage".
 * - Windows: DPAPI (`CryptProtectData`, CurrentUser) — opaque bytes, no prefix.
 * - Linux:   `v10` + AES-128-CBC when a keyring (libsecret) holds the master
 *            password, else `v11` with the hardcoded "peanuts" password (the
 *            "basic_text" backend). Same KDF/cipher as macOS.
 *
 * Test seam: when FIRECONNECT_VSCODE_SECRET_PLAINTEXT is set, encrypt/decrypt are
 * the identity (the raw key is stored verbatim). VS Code does NOT read such a
 * value — this is only for exercising the harness's logic headlessly/in CI.
 */

const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, 0x20);
const LINUX_BASIC_PASSWORD = "peanuts";

/** @returns {boolean} whether the plaintext test seam is active. */
function plaintextMode() {
  return Boolean(process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT);
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

/** Derive the AES-128 key from a master password (Chromium OSCrypt KDF). */
function deriveKey(masterPassword) {
  return crypto.pbkdf2Sync(masterPassword, SALT, ITERATIONS, KEY_LEN, "sha1");
}

/**
 * Chromium OSCrypt AES encryption (macOS `v10`, Linux `v10`/`v11`). Exported for
 * unit tests; production callers go through {@link encryptSecret}.
 * @param {string} plaintext @param {string} masterPassword @param {string} version
 */
export function aesEncrypt(plaintext, masterPassword, version) {
  const key = deriveKey(masterPassword);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(version, "latin1"), body]);
}

/**
 * Chromium OSCrypt AES decryption (inverse of {@link aesEncrypt}). Exported for
 * unit tests; production callers go through {@link decryptSecret}.
 * @param {Buffer} blob @param {string} masterPassword
 */
export function aesDecrypt(blob, masterPassword) {
  const key = deriveKey(masterPassword);
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

/** @param {string} plaintext @returns {Buffer} DPAPI-protected bytes (empty on failure). */
function windowsProtect(plaintext) {
  const b64 = Buffer.from(plaintext, "utf8").toString("base64");
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

/** @param {Buffer} blob @returns {string} the decrypted plaintext (empty on failure). */
function windowsUnprotect(blob) {
  const b64 = blob.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($dec)",
  ].join(";");
  const out = runPowerShell(script);
  return out ? Buffer.from(out, "base64").toString("utf8") : "";
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Encrypt a secret into the exact string VS Code stores in `state.vscdb`
 * (`JSON.stringify(safeStorage.encryptString(value))`).
 * @param {string} plaintext
 * @param {{ variant?: "stable" | "insiders" }} [opts]
 * @returns {string}
 */
export function encryptSecret(plaintext, { variant } = {}) {
  if (plaintextMode()) {
    return plaintext;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    const pw = macReadMasterPassword(variant);
    if (!pw) {
      throw new Error(secretEncryptionUnavailableMessage(variant));
    }
    return JSON.stringify(aesEncrypt(plaintext, pw, "v10"));
  }
  if (platform === "win32") {
    const enc = windowsProtect(plaintext);
    if (enc.length === 0) {
      throw new Error(secretEncryptionUnavailableMessage(variant));
    }
    return JSON.stringify(enc);
  }
  // linux / others
  const keyringPw = linuxReadMasterPassword(variant);
  if (keyringPw) {
    return JSON.stringify(aesEncrypt(plaintext, keyringPw, "v10"));
  }
  // basic_text backend (no keyring): hardcoded "peanuts" password, version v11.
  return JSON.stringify(aesEncrypt(plaintext, LINUX_BASIC_PASSWORD, "v11"));
}

/**
 * Decrypt a value read from `state.vscdb` (the JSON form of the safeStorage
 * ciphertext) back to plaintext. Returns "" when it can't be decrypted.
 * @param {string} stored
 * @param {{ variant?: "stable" | "insiders" }} [opts]
 * @returns {string}
 */
export function decryptSecret(stored, { variant } = {}) {
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
      return windowsUnprotect(blob);
    }
    const version = blob.subarray(0, 3).toString("latin1");
    let pw;
    if (platform === "darwin") {
      pw = macReadMasterPassword(variant);
    } else if (version === "v11") {
      pw = LINUX_BASIC_PASSWORD;
    } else {
      pw = linuxReadMasterPassword(variant);
    }
    if (!pw) {
      return "";
    }
    return aesDecrypt(blob, pw);
  } catch {
    return "";
  }
}

/**
 * Whether the harness can produce a blob VS Code will decrypt on this machine.
 * @param {{ variant?: "stable" | "insiders" }} [opts]
 * @returns {boolean}
 */
export function isSecretEncryptionAvailable({ variant } = {}) {
  if (plaintextMode()) {
    return true;
  }
  const platform = os.platform();
  if (platform === "darwin") {
    return macReadMasterPassword(variant).length > 0;
  }
  if (platform === "win32") {
    return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
    }).status === 0;
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
    return "Windows DPAPI (via PowerShell) is unavailable, so the VS Code Chat API key can't be encrypted into VS Code's secret storage.";
  }
  return "Could not encrypt the VS Code Chat API key for VS Code's secret storage.";
}
