/**
 * Harness-neutral session-log discovery: listing, matching, waiting, and
 * snapshotting for JSONL session stores (`~/.claude/projects`, `~/.pi/agent/
 * sessions`). Both harness usage reports feed from here; only the lister
 * (where logs live and which files count) and the matcher (how a `--session`
 * needle names a file) are per-harness.
 *
 * Purely positional helpers (paths, mtimes, polling) — no parsing, no pricing.
 * Parsing a log's records into priced rows stays per-harness because the two
 * vendors record usage under different field names.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Error thrown by a lister when the store has no logs at all. */
export class NoSessionLogsError extends Error {
}

/**
 * Recursively collect `.jsonl` files under `dir` (missing dir → empty).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function collectJsonlFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * @param {string} filePath
 */
export async function fileExists(filePath) {
  try {
    const st = await stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string[]} files
 * @returns {Promise<Array<{ filePath: string, mtimeMs: number, size: number }>>}
 */
export async function filesWithMtime(files) {
  return Promise.all(
    files.map(async (filePath) => {
      const st = await stat(filePath);
      return { filePath, mtimeMs: st.mtimeMs, size: st.size };
    }),
  );
}

/**
 * `~/`-relative path expansion against a home directory.
 * @param {string} value
 * @param {string} home
 */
export function expandHome(value, home) {
  if (!value?.startsWith("~")) {
    return value;
  }
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

/** Whether a `--session` value names a file rather than a session id. */
export function isExplicitSessionPath(value) {
  return value.startsWith("~")
    || path.isAbsolute(value)
    || value.includes("/")
    || value.includes("\\")
    || value.endsWith(".jsonl");
}

/**
 * Validate `--last-n` (empty → 1).
 * @param {number | string | null | undefined} value
 */
export function parseLastN(value) {
  if (value === "" || value == null) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--last-n must be a positive integer.");
  }
  return parsed;
}

/**
 * Filter mtime-tagged logs to a lookback window (positive days).
 * @param {Array<{ mtimeMs: number }>} logs
 * @param {number | string} withinDays
 * @param {number} [now]
 */
export function filterWithinDays(logs, withinDays, now = Date.now()) {
  const days = Number(withinDays);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("withinDays must be a positive number.");
  }
  const cutoffMs = now - days * 86_400_000;
  return logs.filter(({ mtimeMs }) => mtimeMs >= cutoffMs);
}

/**
 * Shared tail of every `findSessionLogs`: pick the log a `--session` needle
 * names via ordered per-harness matchers (each pass scans ALL logs before the
 * next, so an earlier-priority match always wins), else the newest `lastN`
 * logs.
 *
 * @param {{
 *   logs: Array<{ filePath: string, mtimeMs: number, size?: number }>, newest first,
 *   session?: string,
 *   lastN?: number | string,
 *   storeDir: string,
 *   matchers?: Array<(basename: string, needle: string) => boolean>,
 *   normalize?: (session: string) => string, needle preparation (default: lowercase),
 *   noMatchMessage?: (session: string, storeDir: string) => string,
 * }} opts
 * @returns {string[]}
 */
export function selectSessionLogs({
  logs,
  session = "",
  lastN = 1,
  storeDir,
  matchers = [],
  normalize,
  noMatchMessage,
}) {
  if (session && matchers.length) {
    const needle = normalize ? normalize(session) : session.toLowerCase();
    for (const matches of matchers) {
      const match = logs.find(({ filePath }) => matches(path.basename(filePath, ".jsonl").toLowerCase(), needle));
      if (match) {
        return [match.filePath];
      }
    }
    throw new Error((noMatchMessage?.(session, storeDir))
      ?? `No session log matching '${session}' under ${storeDir}`);
  }
  if (logs.length === 0) {
    return [];
  }
  return logs.slice(0, parseLastN(lastN)).map(({ filePath }) => filePath);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until a specific session's log exists. A pinned fresh session
 * (`--session-id`) writes its log lazily on the first prompt, so callers poll.
 *
 * `find` should resolve the path or throw the store's not-found error.
 *
 * @param {{
 *   find: () => Promise<string | undefined>,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   cancelMessage?: string,
 * }} opts
 * @returns {Promise<string>}
 */
export async function waitForSessionLog({
  find,
  pollMs = 250,
  signal,
  sleep = defaultSleep,
  cancelMessage = "Cancelled while waiting for the session log.",
}) {
  for (;;) {
    if (signal?.aborted) {
      throw new Error(cancelMessage);
    }
    const found = await find();
    if (found) {
      return found;
    }
    await sleep(pollMs);
  }
}

/**
 * Wait until a session log that did not exist in `beforePaths` appears.
 * @param {{
 *   list: () => Promise<Array<{ filePath: string, mtimeMs: number, size?: number }>>,
 *   beforePaths?: Iterable<string>,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   cancelMessage?: string,
 * }} opts
 * @returns {Promise<string>}
 */
export async function waitForNewSessionLog({
  list,
  beforePaths = [],
  pollMs = 250,
  signal,
  sleep = defaultSleep,
  cancelMessage = "Cancelled while waiting for a new session.",
}) {
  const before = new Set(beforePaths);
  for (;;) {
    if (signal?.aborted) {
      throw new Error(cancelMessage);
    }
    const logs = await list();
    const fresh = logs.filter(({ filePath }) => !before.has(filePath));
    if (fresh.length) {
      return fresh[0].filePath;
    }
    await sleep(pollMs);
  }
}

/**
 * Snapshot session logs (mtime + size) for a live split's right pane.
 * @param {() => Promise<Array<{ filePath: string, mtimeMs: number, size?: number }>>} list
 * @param {number} [now]
 */
export async function snapshotSessionLogs(list, now = Date.now()) {
  return { startedAtMs: now, logs: await list() };
}

/**
 * Wait until a session log is created or appended to after the snapshot:
 * new sessions add a file; resumed sessions bump mtime/size.
 *
 * @param {{
 *   list: () => Promise<Array<{ filePath: string, mtimeMs: number, size?: number }>>,
 *   beforeLogs?: Array<{ filePath: string, mtimeMs: number, size?: number }>,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   cancelMessage?: string,
 * }} opts
 * @returns {Promise<string>}
 */
export async function waitForLiveSessionLog({
  list,
  beforeLogs = [],
  pollMs = 250,
  signal,
  sleep = defaultSleep,
  cancelMessage = "Cancelled while waiting for a new session.",
}) {
  const before = new Map(beforeLogs.map(({ filePath, mtimeMs, size = 0 }) => [filePath, { mtimeMs, size }]));
  for (;;) {
    if (signal?.aborted) {
      throw new Error(cancelMessage);
    }
    const logs = await list();
    const candidates = logs.filter(({ filePath, mtimeMs, size }) => {
      const prev = before.get(filePath);
      if (prev == null) {
        return true;
      }
      return mtimeMs > prev.mtimeMs || size > prev.size;
    });
    if (candidates.length) {
      return candidates[0].filePath;
    }
    await sleep(pollMs);
  }
}
