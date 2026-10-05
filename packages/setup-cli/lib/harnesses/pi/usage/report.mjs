/**
 * Pi session-log discovery and usage pricing for `fireconnect pi usage`.
 *
 * Pi stores sessions as JSONL under `~/.pi/agent/sessions/--<cwd>--/` with one
 * assistant `message` entry per API call: usage (input/output/cacheRead/
 * cacheWrite), the requested `model`, and the `responseModel` that actually
 * served. That is the same raw material the Claude Code report prices, so rows
 * go through the same `computeClaudeUsageCost` engine (which prices Fireworks
 * ids at Fireworks rates and Anthropic/OpenAI ids at list) after a field rename.
 *
 * Discovery (listing, matching, waiting, snapshotting) lives in the
 * harness-neutral `lib/usage/session-logs.mjs`; only the store location, the
 * id matcher, and the record parsing are Pi-specific.
 *
 * Unlike Claude Code's log, a Pi file is a TREE: entries on abandoned branches
 * are alternative histories for context, but every assistant entry in the file
 * was a real billed API call, so all of them are counted — resume shows the same
 * total as the meter.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  NoSessionLogsError,
  collectJsonlFiles,
  expandHome,
  fileExists,
  filesWithMtime,
  filterWithinDays,
  isExplicitSessionPath,
  selectSessionLogs,
  waitForLiveSessionLog as waitForLiveLog,
  waitForSessionLog as waitForLog,
} from "../../../usage/session-logs.mjs";
import { UNPRICED_TEXT, addUsage, rowHasUsage, sumUsage } from "../../claude/usage/cost.mjs";
import { formatUsageCost } from "../../claude/usage/format.mjs";
import { computeClaudeUsageCost } from "../../claude/usage/pricing.mjs";

export { computeClaudeUsageCost };

/** Thrown by the finders when the sessions store has no logs at all. */
export { NoSessionLogsError as NoPiSessionLogsError } from "../../../usage/session-logs.mjs";

export const PI_SESSIONS_RELATIVE_DIR = ".pi/agent/sessions";

/**
 * @param {string} home
 * @param {string} [sessionsDir] explicit sessions dir (mirrors pi's `--session-dir`)
 */
export function piSessionsDir(home, sessionsDir = "") {
  if (!home) {
    throw new Error("HOME is required to find Pi session logs.");
  }
  return sessionsDir || path.join(home, PI_SESSIONS_RELATIVE_DIR);
}

/**
 * Every Pi session log, newest first.
 * @param {string} home
 * @param {string} [sessionsDir]
 * @returns {Promise<Array<{ filePath: string, mtimeMs: number, size: number }>>}
 */
export async function listPiSessionLogsWithMtime(home, sessionsDir = "") {
  const dir = piSessionsDir(home, sessionsDir);
  const candidates = await collectJsonlFiles(dir);
  if (candidates.length === 0) {
    throw new NoSessionLogsError(`No Pi session logs found under ${dir}`);
  }
  const withMtime = await filesWithMtime(candidates);
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime;
}

/** @param {string} home @param {string} [sessionsDir] @returns {Promise<string[]>} */
export async function listPiSessionLogPaths(home, sessionsDir = "") {
  const logs = await listPiSessionLogsWithMtime(home, sessionsDir);
  return logs.map(({ filePath }) => filePath);
}

/**
 * Ordered matchers: a bare id names the `<timestamp>_<id>.jsonl` suffix, a full
 * basename (with or without the `.jsonl` extension — what the plain report
 * prints and what a user pastes) matches by prefix, and anything else falls
 * back to a substring. The needle arrives lowercased without a trailing
 * `.jsonl`.
 */
const PI_SESSION_MATCHERS = [
  (basename, needle) => basename.endsWith(`_${needle}`),
  (basename, needle) => basename.startsWith(needle),
  (basename, needle) => basename.includes(needle),
];

/** Normalize a `--session` needle: lowercase, trailing `.jsonl` stripped. */
function normalizedSessionNeedle(session) {
  return String(session).trim().toLowerCase().replace(/\.jsonl$/, "");
}

/**
 * @param {{ home: string, session?: string, lastN?: number|string, withinDays?: number, sessionsDir?: string }} args
 * @returns {Promise<string[]>}
 */
export async function findPiSessionLogs({
  home,
  session = "",
  lastN = 1,
  withinDays,
  sessionsDir = "",
} = {}) {
  if (!home) {
    throw new Error("HOME is required to find Pi session logs.");
  }

  if (session && isExplicitSessionPath(session)) {
    const explicitPath = path.resolve(expandHome(session, home));
    if (await fileExists(explicitPath)) {
      return [explicitPath];
    }
  }

  const dir = piSessionsDir(home, sessionsDir);
  const withMtime = await listPiSessionLogsWithMtime(home, sessionsDir);

  const scoped = withinDays != null && withinDays !== ""
    ? filterWithinDays(withMtime, withinDays)
    : withMtime;

  return selectSessionLogs({
    logs: scoped,
    session,
    lastN,
    storeDir: dir,
    matchers: PI_SESSION_MATCHERS,
    // selectSessionLogs lowercases the needle for matching; feed it a
    // `.jsonl`-stripped form so both spellings resolve.
    normalize: normalizedSessionNeedle,
    noMatchMessage: (needle, storeDir) => `No Pi session log matching '${needle}' under ${storeDir}`,
  });
}

/**
 * @param {{ home: string, session?: string, sessionsDir?: string }} args
 * @returns {Promise<string | undefined>}
 */
export async function findPiSessionLog({ home, session = "", sessionsDir = "" }) {
  return (await findPiSessionLogs({ home, session, lastN: 1, sessionsDir }))[0];
}

/**
 * Wait until a specific session's log exists. `pi --session-id` writes its log
 * lazily on the first prompt, so a pinned live split polls until it appears.
 *
 * @param {{
 *   home: string,
 *   session: string,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   sessionsDir?: string,
 * }} opts
 * @returns {Promise<string>} absolute path to the session log
 */
export async function waitForPiSessionLog({
  home,
  session,
  pollMs = 250,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sessionsDir = "",
} = {}) {
  return waitForLog({
    find: async () => {
      try {
        return await findPiSessionLog({ home, session, sessionsDir });
      } catch {
        // Not written yet — a pinned `--session-id` writes its log lazily on
        // the first prompt, so a no-match is the normal pre-first-prompt state.
        return undefined;
      }
    },
    pollMs,
    signal,
    sleep,
    cancelMessage: "Cancelled while waiting for the Pi session log.",
  });
}

/** Snapshot session logs for the live split's right pane. */
export async function snapshotPiSessionLogs(home, sessionsDir = "") {
  let logs = [];
  try {
    logs = await listPiSessionLogsWithMtime(home, sessionsDir);
  } catch (error) {
    if (!(error instanceof NoSessionLogsError)) {
      throw error;
    }
  }
  return { startedAtMs: Date.now(), logs };
}

/**
 * Wait until a session log is created or appended to after `live` starts
 * (new sessions add a file; resumed sessions bump mtime/size).
 *
 * @param {{
 *   home: string,
 *   beforeLogs?: Array<{ filePath: string, mtimeMs: number, size?: number }>,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 *   sessionsDir?: string,
 * }} opts
 * @returns {Promise<string>} absolute path to the active session log
 */
export async function waitForPiLiveSessionLog({
  home,
  beforeLogs = [],
  pollMs = 250,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sessionsDir = "",
} = {}) {
  return waitForLiveLog({
    list: async () => {
      try {
        return await listPiSessionLogsWithMtime(home, sessionsDir);
      } catch (error) {
        if (error instanceof NoSessionLogsError) {
          return [];
        }
        throw error;
      }
    },
    beforeLogs,
    pollMs,
    signal,
    sleep,
    cancelMessage: "Cancelled while waiting for a new Pi session.",
  });
}

// ── parsing ─────────────────────────────────────────────────────────────────

function numberValue(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Pi's usage fields renamed to the vendor-neutral shape the shared pricing
 * engine reads (`input_tokens` etc.). Pi has no 5m/1h cache-write split —
 * Fireworks has no separate write price either — so one write bucket maps to
 * the flat `cache_creation_input_tokens` field.
 */
export function claudeUsageFieldsFromPi(usage = {}) {
  return {
    input_tokens: numberValue(usage.input),
    cache_read_input_tokens: numberValue(usage.cacheRead),
    cache_creation_input_tokens: numberValue(usage.cacheWrite),
    output_tokens: numberValue(usage.output),
  };
}

/** The model that actually served a call: the response model when Pi recorded one. */
export function servedModelOf(message = {}, entry = {}) {
  if (typeof message.responseModel === "string" && message.responseModel.trim()) {
    return message.responseModel;
  }
  if (typeof message.model === "string" && message.model.trim()) {
    return message.model;
  }
  if (typeof entry.model === "string" && entry.model.trim()) {
    return entry.model;
  }
  return "?";
}

/** The text of one content block (string or `{ type: "text", text }`). */
function textOfBlock(block) {
  if (typeof block === "string") {
    return block;
  }
  if (block && typeof block === "object" && typeof block.text === "string") {
    return block.text;
  }
  return "";
}

function textFromMessageContent(content) {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map(textOfBlock)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Display name for a Pi session: the `/name` session_info entry, else the first
 * user prompt (the same order Pi's own `/resume` picker uses).
 */
export function parsePiSessionName(text) {
  let named = "";
  let firstUserText = "";
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      if (!named) {
        named = entry.name.replace(/\s+/g, " ").trim();
      }
      continue;
    }
    if (!firstUserText && entry?.type === "message" && entry.message?.role === "user") {
      const prompt = textFromMessageContent(entry.message.content);
      if (prompt) {
        firstUserText = prompt;
      }
    }
  }
  return named || firstUserText;
}

/**
 * One billed call from a parsed Pi session entry, or null when the entry
 * carries none: an assistant `message` with usage (the model that served), or
 * a `usage` entry (cache warming and other model-attributed work Pi totals
 * but hides from the transcript). Shared by the log parser and the footer
 * extension's in-process seed.
 *
 * @param {any} entry a parsed Pi session JSONL entry
 * @returns {{ model: string, usage: object } | null}
 */
export function piUsageCallFromEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (entry.type === "usage" && entry.usage && typeof entry.usage === "object") {
    const model = typeof entry.model === "string" && entry.model.trim() ? entry.model : "";
    // A usage entry without a model cannot be attributed to a rate table —
    // keep it out rather than pricing it as "?".
    return model ? { model, usage: entry.usage } : null;
  }
  if (entry.type !== "message") {
    return null;
  }
  const message = entry.message && typeof entry.message === "object" ? entry.message : {};
  if (message.role !== "assistant") {
    return null;
  }
  const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
  if (!usage) {
    return null;
  }
  return { model: servedModelOf(message, entry), usage };
}

/**
 * Priced rows for every billed call in a Pi session log.
 */
export function parsePiUsageLog(text) {
  /** @type {Array<{ model: string, usage: object }>} */
  const calls = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const call = piUsageCallFromEntry(entry);
    if (call) {
      calls.push(call);
    }
  }
  return calls.map(({ model, usage }) => computeClaudeUsageCost(model, claudeUsageFieldsFromPi(usage)));
}

/**
 * Report for one Pi session log, in the Claude report's shape (no subagents:
 * Pi child agents keep ordinary session logs of their own).
 *
 * @param {string} filePath
 * @param {string} text
 * @param {{ includeSessionName?: boolean }} [opts]
 */
export function piUsageReportFromText(filePath, text, { includeSessionName = false } = {}) {
  const sessionName = includeSessionName ? parsePiSessionName(text) : "";
  const rows = parsePiUsageLog(text).filter(rowHasUsage);
  const totals = sumUsage(rows);
  const report = {
    path: filePath,
    requests: rows.length,
    rows,
    totals,
    estimated: rows.some((row) => row.estimated),
    unpriced: rows.filter((row) => row.priced === false).length,
    // Aliases so shared consumers (pickers, status display) can treat a
    // single-agent report and a Claude parent+subagent report alike.
    grandTotals: totals,
    grandRequests: rows.length,
    subagents: [],
  };
  if (sessionName) {
    report.sessionName = sessionName;
  }
  return report;
}

async function readPiUsageFile(filePath, { includeSessionName = false } = {}) {
  const text = await readFile(filePath, "utf8");
  return piUsageReportFromText(filePath, text, { includeSessionName });
}

/**
 * @param {{ home: string, session?: string, sessionsDir?: string }} args
 */
export async function readPiUsage({ home, session = "", sessionsDir = "" }) {
  const filePath = await findPiSessionLog({ home, session, sessionsDir });
  if (!filePath) {
    throw new NoSessionLogsError("No Pi session logs found.");
  }
  return readPiUsageFile(filePath, { includeSessionName: true });
}

/**
 * @param {{ home: string, session?: string, lastN?: number|string, sessionsDir?: string }} args
 */
export async function readPiUsages({ home, session = "", lastN = 1, sessionsDir = "" }) {
  const sessionPaths = await findPiSessionLogs({ home, session, lastN, sessionsDir });
  const loaded = await Promise.all(
    sessionPaths.map((filePath) => readPiUsageFile(filePath, { includeSessionName: true })),
  );
  const sessions = loaded.filter((report) => report.rows.length > 0);
  const grandTotals = sessions.reduce((totals, report) => addUsage(totals, report.totals), sumUsage([]));
  return {
    sessions,
    grandTotals,
    grandRequests: sessions.reduce((total, report) => total + report.requests, 0),
    estimated: sessions.some((report) => report.estimated),
    unpriced: sessions.reduce((total, report) => total + report.unpriced, 0),
    lastN: sessions.length,
    sessionCount: sessions.length,
  };
}

// ── snapshot text ────────────────────────────────────────────────────────────

function fmtInt(value) {
  return value.toLocaleString("en-US");
}

function fmtCost(value) {
  return value == null ? UNPRICED_TEXT : formatUsageCost(value);
}

/**
 * Plain (non-interactive) snapshot: per-model totals plus the session line.
 * `verbose` adds per-request rows with each call's rate source.
 * @param {{ path?: string, sessionName?: string, rows: Array<object>, totals: object, estimated?: boolean, unpriced?: number, requests?: number }} report
 * @param {{ verbose?: boolean }} [opts]
 */
export function formatPiUsageReport(report, { verbose = false } = {}) {
  /** @type {Map<string, { model: string, calls: number, input: number, cacheRead: number, cacheWrite: number, output: number, cost: number | null, unpriced: boolean }>} */
  const byModel = new Map();
  for (const row of report.rows) {
    const entry = byModel.get(row.displayModel) ?? {
      model: row.displayModel,
      calls: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: 0,
      unpriced: false,
    };
    entry.calls += 1;
    entry.input += row.input;
    entry.cacheRead += row.cacheRead;
    entry.cacheWrite += row.cacheWrite5m + row.cacheWrite1h;
    entry.output += row.output;
    entry.cost = row.cost == null ? null : entry.cost + row.cost;
    if (row.priced === false) {
      entry.unpriced = true;
    }
    byModel.set(row.displayModel, entry);
  }
  const lines = [];
  if (report.sessionName) {
    lines.push(`Pi session: ${report.sessionName}`);
  } else if (report.path) {
    lines.push(`Pi session: ${path.basename(report.path, ".jsonl")}`);
  }
  const models = [...byModel.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls);
  for (const model of models) {
    lines.push(
      `  ${model.model}: ${model.calls} calls · in ${fmtInt(model.input)} · cached ${fmtInt(model.cacheRead)} · out ${fmtInt(model.output)} · ${fmtCost(model.cost)}${model.unpriced ? " (some calls unpriced)" : ""}`,
    );
  }
  if (verbose) {
    lines.push("  requests:");
    for (const [i, row] of report.rows.entries()) {
      lines.push(
        `    ${i + 1}. ${row.displayModel} · in ${fmtInt(row.input)} · cached ${fmtInt(row.cacheRead)} · write ${fmtInt(row.cacheWrite5m + row.cacheWrite1h)} · out ${fmtInt(row.output)} · ${fmtCost(row.cost)}${row.rates?.source ? ` · ${row.rates.source}` : ""}`,
      );
    }
  }
  const totals = report.totals;
  lines.push(
    `  total: ${report.requests} calls · in ${fmtInt(totals.input)} · cached ${fmtInt(totals.cacheRead)} · out ${fmtInt(totals.output)} · ${fmtCost(totals.cost)}${report.estimated ? " (estimated)" : ""}`,
  );
  if (report.unpriced) {
    lines.push(`  ${report.unpriced} call${report.unpriced === 1 ? "" : "s"} at unpriced model rates (${UNPRICED_TEXT} above)`);
  }
  return lines.join("\n");
}
