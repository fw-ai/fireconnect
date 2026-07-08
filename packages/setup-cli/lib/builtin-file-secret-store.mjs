import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Minimal encrypted-file secret store compatible with cross-keychain's `file`
 * backend. Used only when the cross-keychain npm package cannot be loaded so
 * configure / harness on can still store keys (AES-256-GCM, same on-disk layout).
 */

/**
 * @returns {string}
 */
function resolvedHomeDir() {
  const home = process.env.HOME?.trim();
  return home || os.homedir();
}

/**
 * @returns {string}
 */
function configRoot() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "keyring");
  }
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA || process.env.APPDATA || resolvedHomeDir();
    return path.join(root, "Keyring");
  }
  return path.join(resolvedHomeDir(), ".config", "keyring");
}

/**
 * @returns {string}
 */
export function fileDataRoot() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "keyring");
  }
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA || process.env.ProgramData || resolvedHomeDir();
    return path.join(root, "Keyring");
  }
  const home = resolvedHomeDir();
  return home ? path.join(home, ".local", "share", "keyring") : "";
}

/**
 * @returns {string | null}
 */
export function secretsFilePath() {
  const root = fileDataRoot();
  return root ? path.join(root, "secrets.json") : null;
}

/**
 * @returns {string | null}
 */
function keyFilePath() {
  return path.join(configRoot(), "file.key");
}

/**
 * @returns {Promise<Buffer>}
 */
async function getKeyMaterial() {
  const envKey = process.env.KEYRING_FILE_MASTER_KEY;
  if (envKey) {
    if (envKey.length !== 64) {
      throw new Error("KEYRING_FILE_MASTER_KEY must be 64 hex characters (32 bytes)");
    }
    return Buffer.from(envKey, "hex");
  }

  const keyFile = keyFilePath();
  try {
    const key = await readFile(keyFile);
    if (key.length !== 32) {
      throw new Error("Key file must contain exactly 32 bytes");
    }
    return key;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
    const key = randomBytes(32);
    await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, key, { mode: 0o600 });
    return key;
  }
}

/**
 * @param {Record<string, Record<string, string>>} store
 * @returns {Promise<Buffer>}
 */
async function encryptStore(store) {
  const plaintext = JSON.stringify(store);
  const key = await getKeyMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const version = Buffer.from([1]);
  return Buffer.concat([version, iv, authTag, encrypted]);
}

/**
 * @param {Buffer} data
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
async function decryptStore(data) {
  const version = data[0];
  if (version !== 1) {
    throw new Error(`Unsupported store format version: ${version}`);
  }
  const iv = data.subarray(1, 13);
  const authTag = data.subarray(13, 29);
  const encrypted = data.subarray(29);
  const key = await getKeyMaterial();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * @param {string} file
 * @param {Buffer} buf
 */
async function atomicWrite(file, buf) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, buf, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
async function readStore() {
  const file = secretsFilePath();
  if (!file) {
    throw new Error("HOME is not set and XDG_DATA_HOME is unset");
  }
  try {
    const data = await readFile(file);
    return decryptStore(data);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/**
 * @param {Record<string, Record<string, string>>} store
 */
async function writeStore(store) {
  const file = secretsFilePath();
  if (!file) {
    throw new Error("HOME is not set and XDG_DATA_HOME is unset");
  }
  const encrypted = await encryptStore(store);
  await atomicWrite(file, encrypted);
}

/**
 * @returns {boolean}
 */
export function builtinFileStoreAvailable() {
  return Boolean(secretsFilePath());
}

/**
 * @param {string} service
 * @param {string} account
 * @returns {Promise<string | null>}
 */
export async function builtinGetPassword(service, account) {
  const store = await readStore();
  return store[service]?.[account] ?? null;
}

/**
 * @param {string} service
 * @param {string} account
 * @param {string} password
 */
export async function builtinSetPassword(service, account, password) {
  const store = await readStore();
  const serviceEntry = store[service] ?? {};
  serviceEntry[account] = password;
  store[service] = serviceEntry;
  await writeStore(store);
}

/**
 * @param {string} service
 * @param {string} account
 */
export async function builtinDeletePassword(service, account) {
  const store = await readStore();
  const serviceEntry = store[service];
  if (!serviceEntry || !(account in serviceEntry)) {
    return;
  }
  delete serviceEntry[account];
  if (Object.keys(serviceEntry).length === 0) {
    delete store[service];
  } else {
    store[service] = serviceEntry;
  }
  await writeStore(store);
}

/**
 * @param {string} service
 * @param {string} account
 * @returns {Promise<boolean>}
 */
export async function builtinHasPassword(service, account) {
  const value = await builtinGetPassword(service, account);
  return Boolean(value?.trim());
}
