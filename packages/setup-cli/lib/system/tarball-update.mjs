import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

// Same URL install.sh downloads — the documented archive endpoint
// (https://docs.github.com/en/rest/repos/contents), which redirects to
// GitHub's archive host. NEXUS_TARBALL_URL lets tests point at a local
// fixture without touching the network.
export const TARBALL_URL =
  process.env.NEXUS_TARBALL_URL
  ?? "https://api.github.com/repos/fw-ai/nexus-cli/tarball/main";

// Same package.json the update checker already reads.
export const REMOTE_VERSION_URL =
  "https://raw.githubusercontent.com/fw-ai/nexus-cli/main/packages/setup-cli/package.json";

const HEADER_SIZE = 512;

function readString(bytes, offset, length) {
  let end = offset;
  const max = Math.min(offset + length, bytes.length);
  while (end < max && bytes[end] !== 0) end += 1;
  return bytes.subarray(offset, end).toString("utf8");
}

function readOctal(bytes, offset, length) {
  const raw = readString(bytes, offset, length).trim();
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Extract a gzipped GitHub tarball into `staging`, dropping the single
 * top-level directory GitHub prefixes every entry with (like
 * `tar --strip-components=1`). Only plain files and directories are
 * extracted; symlinks/devices/PAX records are skipped. Every entry must
 * resolve inside `staging` — anything that would escape (tar-slip) throws.
 *
 * @param {Buffer} gzipBytes
 * @param {string} staging Absolute path of an existing (possibly empty) directory.
 * @returns {Promise<void>}
 */
export async function extractCliTarball(gzipBytes, staging) {
  const tar = gunzipSync(gzipBytes);
  let offset = 0;
  while (offset + HEADER_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + HEADER_SIZE);
    const name = readString(header, 0, 100);
    if (!name) break; // Zero block: end of archive.
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + HEADER_SIZE;
    const dataEnd = Math.min(dataStart + size, tar.length);
    offset = dataStart + Math.ceil(size / HEADER_SIZE) * HEADER_SIZE;

    if (type === "x" || type === "g" || type === "L" || type === "K") {
      continue; // PAX / GNU metadata records: skip their payload.
    }

    const fullName = prefix ? `${prefix}/${name}` : name;
    const parts = fullName.split("/").filter((part) => part && part !== ".");
    if (parts.length <= 1) continue; // The GitHub top-level directory itself.
    const relative = parts.slice(1).join("/");
    if (path.isAbsolute(relative) || relative.split(path.posix.sep).includes("..")) {
      throw new Error(`Refusing to extract unsafe tar entry: ${fullName}`);
    }
    const target = path.resolve(staging, relative);
    if (target !== path.resolve(staging) && !target.startsWith(path.resolve(staging) + path.sep)) {
      throw new Error(`Refusing to extract unsafe tar entry: ${fullName}`);
    }

    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(dataStart, dataEnd));
    }
    // Anything else (symlinks, hardlinks, devices) is skipped.
  }
}

/**
 * Fetch the latest published CLI version over HTTPS. Returns "" on any
 * failure so callers can degrade to a hint instead of crashing.
 *
 * @returns {Promise<string>}
 */
export async function fetchLatestVersion({
  url = REMOTE_VERSION_URL,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "";
    const { version } = await res.json();
    return typeof version === "string" && version ? version : "";
  } catch {
    return "";
  }
}

/**
 * Download the CLI tarball over HTTPS and extract it into `staging`.
 * Throws on network/HTTP/extract failure; the caller cleans up staging.
 *
 * @param {string} staging Absolute path; created if missing.
 * @returns {Promise<void>}
 */
export async function downloadCliTarball(
  staging,
  {
    url = TARBALL_URL,
    fetchImpl = fetch,
    timeoutMs = 120_000,
    extract = extractCliTarball,
  } = {},
) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await extract(bytes, staging);
}
