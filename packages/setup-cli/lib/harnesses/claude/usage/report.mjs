import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { lookupFireworksPricing } from "../../../fireworks/pricing.mjs";
import { shortFireworksModelRef } from "../../../fireworks/model-id.mjs";
import { providerListPricing } from "../../../demo/incumbent-detect.mjs";
import {
  formatCostEstimateNote,
  formatClaudeUsageReportsSummaryDisplay,
  formatClaudeUsageSummaryDisplay,
} from "./display.mjs";

const DEFAULT_PRICE = {
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
  output: 5,
  label: "Default reference",
  source: "",
  estimated: true,
};

const FAST_PRICES = {
  "claude-opus-4-8": { input: 10, output: 50 },
  "claude-opus-4-7": { input: 30, output: 150 },
};

const WEB_SEARCH_PER_1K = 10;
const US_INFERENCE_GEO_MULTIPLIER = 1.1;
const BATCH_DISCOUNT = 0.5;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function expandHome(value, home) {
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

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function collectJsonlFiles(dir) {
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

function isSubagentLog(filePath) {
  return filePath.split(path.sep).includes("subagents")
    || path.basename(filePath).startsWith("agent-");
}

function isTopLevelSessionLog(filePath) {
  return !isSubagentLog(filePath)
    && SESSION_ID_RE.test(path.basename(filePath, ".jsonl"));
}

function isExplicitSessionPath(value) {
  return value.startsWith("~")
    || path.isAbsolute(value)
    || value.includes("/")
    || value.includes("\\")
    || value.endsWith(".jsonl");
}

async function filesWithMtime(files) {
  return Promise.all(
    files.map(async (filePath) => {
      const st = await stat(filePath);
      return { filePath, mtimeMs: st.mtimeMs, size: st.size };
    }),
  );
}

function parseLastN(value) {
  if (value === "" || value == null) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--last_n must be a positive integer.");
  }
  return parsed;
}

/**
 * Every top-level Claude Code session log under ~/.claude.
 *
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function listTopLevelSessionLogPaths(home) {
  if (!home) {
    throw new Error("HOME is required to find Claude Code session logs.");
  }
  const claudeDir = path.join(home, ".claude");
  return (await collectJsonlFiles(claudeDir)).filter(isTopLevelSessionLog);
}

/**
 * Wait until Claude Code creates a session log that did not exist in `beforePaths`.
 *
 * @param {{
 *   home: string,
 *   beforePaths?: Iterable<string>,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<string>} absolute path to the new session log
 */
export async function waitForNewSessionLog({
  home,
  beforePaths = [],
  pollMs = 250,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const before = new Set(beforePaths);
  for (;;) {
    if (signal?.aborted) {
      throw new Error("Cancelled while waiting for a new Claude Code session.");
    }
    const logs = await listTopLevelSessionLogPaths(home);
    const fresh = logs.filter((filePath) => !before.has(filePath));
    if (fresh.length) {
      const withMtime = await filesWithMtime(fresh);
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return withMtime[0].filePath;
    }
    await sleep(pollMs);
  }
}

/**
 * Snapshot top-level session logs for the live split's right pane.
 *
 * @param {string} home
 */
export async function snapshotLiveSessionLogs(home) {
  const paths = await listTopLevelSessionLogPaths(home);
  const logs = await filesWithMtime(paths);
  return {
    startedAtMs: Date.now(),
    logs,
  };
}

/**
 * Wait until Claude Code creates or resumes a session log after `live` starts.
 *
 * New sessions add a log path; resumed sessions append to an existing log and
 * bump its mtime. Only changes at or after `startedAtMs` count so unrelated
 * background sessions are less likely to steal the lock.
 *
 * @param {{
 *   home: string,
 *   beforeLogs?: Array<{ filePath: string, mtimeMs: number, size?: number }>,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<string>} absolute path to the active session log
 */
export async function waitForLiveSessionLog({
  home,
  beforeLogs = [],
  pollMs = 250,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const before = new Map(beforeLogs.map(({ filePath, mtimeMs, size = 0 }) => [filePath, { mtimeMs, size }]));
  for (;;) {
    if (signal?.aborted) {
      throw new Error("Cancelled while waiting for a new Claude Code session.");
    }
    const logs = await listTopLevelSessionLogPaths(home);
    const withMtime = await filesWithMtime(logs);
    const candidates = withMtime.filter(({ filePath, mtimeMs, size }) => {
      const prev = before.get(filePath);
      if (prev == null) {
        return true;
      }
      return mtimeMs > prev.mtimeMs || size > prev.size;
    });
    if (candidates.length) {
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return candidates[0].filePath;
    }
    await sleep(pollMs);
  }
}

/**
 * @param {{ home: string, session?: string }} args
 */
export async function findClaudeSessionLog({ home, session = "" }) {
  return (await findClaudeSessionLogs({ home, session, lastN: 1 }))[0];
}

/**
 * Wait until a specific session's log exists (a pinned `--session-id` writes
 * its log lazily, on the first prompt), then return its path.
 *
 * Unlike `findClaudeSessionLog` (which throws when nothing matches), this polls
 * until the log appears. For a resumed session the log already exists, so it
 * returns on the first poll.
 *
 * @param {{
 *   home: string,
 *   session: string,
 *   pollMs?: number,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<string>} absolute path to the session log
 */
export async function waitForClaudeSessionLog({
  home,
  session,
  pollMs = 250,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (;;) {
    if (signal?.aborted) {
      throw new Error("Cancelled while waiting for the Claude Code session log.");
    }
    try {
      const logPath = await findClaudeSessionLog({ home, session });
      if (logPath) {
        return logPath;
      }
    } catch {
      /* not written yet — the session idles until the first prompt */
    }
    await sleep(pollMs);
  }
}

/**
 * @param {{ home: string, session?: string, lastN?: number|string, withinDays?: number }} args
 */
export async function findClaudeSessionLogs({ home, session = "", lastN = 1, withinDays } = {}) {
  if (!home) {
    throw new Error("HOME is required to find Claude Code session logs.");
  }

  if (session && isExplicitSessionPath(session)) {
    const explicitPath = path.resolve(expandHome(session, home));
    if (await fileExists(explicitPath)) {
      return [explicitPath];
    }
  }

  const claudeDir = path.join(home, ".claude");
  const candidates = (await collectJsonlFiles(claudeDir)).filter(isTopLevelSessionLog);
  if (candidates.length === 0) {
    throw new Error(`No Claude Code session logs found under ${claudeDir}`);
  }

  let withMtime = await filesWithMtime(candidates);
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (withinDays != null && withinDays !== "") {
    const days = Number(withinDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("withinDays must be a positive number.");
    }
    const cutoffMs = Date.now() - days * 86_400_000;
    withMtime = withMtime.filter(({ mtimeMs }) => mtimeMs >= cutoffMs);
  }

  if (session) {
    const needle = session.toLowerCase();
    const exactish = withMtime.find(({ filePath }) => path.basename(filePath, ".jsonl").toLowerCase().startsWith(needle));
    if (exactish) {
      return [exactish.filePath];
    }
    const fuzzy = withMtime.find(({ filePath }) => path.basename(filePath, ".jsonl").toLowerCase().includes(needle));
    if (fuzzy) {
      return [fuzzy.filePath];
    }
    throw new Error(`No Claude Code session log matching '${session}' under ${claudeDir}`);
  }

  if (withMtime.length === 0) {
    return [];
  }

  return withMtime.slice(0, parseLastN(lastN)).map(({ filePath }) => filePath);
}

function displayModel(model) {
  return shortFireworksModelRef(model);
}

function fireworkPriceFor(model) {
  const pricing = lookupFireworksPricing(model);
  if (!pricing) {
    return null;
  }
  return {
    input: pricing.input,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: pricing.cachedInput,
    output: pricing.output,
    label: pricing.label,
    source: pricing.source,
    estimated: false,
  };
}

function anthropicPriceFor(model) {
  const rate = providerListPricing({ provider: "anthropic", modelId: model });
  if (!rate || rate.tier === "subscription") {
    return null;
  }
  const input = rate.inputPerMillion;
  return {
    input,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
    output: rate.outputPerMillion,
    label: rate.label,
    source: rate.source,
    estimated: rate.estimated,
  };
}

function fastPriceFor(model) {
  const id = model.toLowerCase();
  const key = Object.keys(FAST_PRICES).find((candidate) => id.startsWith(candidate));
  return key ? FAST_PRICES[key] : null;
}

function priceFor(model, usage) {
  const fireworksPrice = fireworkPriceFor(model);
  let price = fireworksPrice ?? anthropicPriceFor(model);
  price ??= DEFAULT_PRICE;

  const fast = usage.speed === "fast" ? fastPriceFor(model) : null;
  if (fast) {
    return {
      ...price,
      fireworks: Boolean(fireworksPrice),
      input: fast.input,
      cacheWrite5m: fast.input * 1.25,
      cacheWrite1h: fast.input * 2,
      cacheRead: fast.input * 0.1,
      output: fast.output,
    };
  }
  return { ...price, fireworks: Boolean(fireworksPrice) };
}

function numberValue(value) {
  return Number.isFinite(value) ? value : 0;
}

export function computeClaudeUsageCost(model, usage = {}) {
  const price = priceFor(model, usage);
  const input = numberValue(usage.input_tokens);
  const cacheRead = numberValue(usage.cache_read_input_tokens);
  const output = numberValue(usage.output_tokens);
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object"
    ? usage.cache_creation
    : null;
  const cacheWrite5m = cacheCreation
    ? numberValue(cacheCreation.ephemeral_5m_input_tokens)
    : numberValue(usage.cache_creation_input_tokens);
  const cacheWrite1h = cacheCreation ? numberValue(cacheCreation.ephemeral_1h_input_tokens) : 0;

  let tokenCost = (
    input * price.input
    + cacheWrite5m * price.cacheWrite5m
    + cacheWrite1h * price.cacheWrite1h
    + cacheRead * price.cacheRead
    + output * price.output
  ) / 1_000_000;

  if (usage.inference_geo === "us") {
    tokenCost *= US_INFERENCE_GEO_MULTIPLIER;
  }
  if (usage.service_tier === "batch") {
    tokenCost *= BATCH_DISCOUNT;
  }

  const webSearches = numberValue(usage.server_tool_use?.web_search_requests);
  const cost = tokenCost + (webSearches / 1000) * WEB_SEARCH_PER_1K;

  return {
    model,
    displayModel: displayModel(model),
    fireworks: price.fireworks,
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output,
    webSearches,
    cost,
    estimated: price.estimated,
    rates: {
      inputPerMillion: price.input,
      cacheWrite5mPerMillion: price.cacheWrite5m,
      cacheWrite1hPerMillion: price.cacheWrite1h,
      cacheReadPerMillion: price.cacheRead,
      outputPerMillion: price.output,
      webSearchPer1k: WEB_SEARCH_PER_1K,
      label: price.label,
      source: price.source,
      estimated: price.estimated,
    },
  };
}

function cleanSessionName(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function textFromMessageContent(content) {
  if (typeof content === "string") {
    return cleanSessionName(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      const text = cleanSessionName(block);
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (block && typeof block === "object" && typeof block.text === "string") {
      const text = cleanSessionName(block.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return cleanSessionName(parts.join(" "));
}

/**
 * Extract a display name for a Claude Code session from its JSONL transcript.
 * Preference matches Claude Code's resume picker: customTitle, then aiTitle,
 * then summary, then the first user prompt.
 */
export function parseClaudeSessionName(text) {
  let customTitle = "";
  let aiTitle = "";
  let summary = "";
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
    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (entry.type === "custom-title") {
      const title = cleanSessionName(entry.customTitle);
      if (title) {
        customTitle = title;
      }
      continue;
    }

    if (entry.type === "ai-title" || entry.type === "title") {
      const title = cleanSessionName(entry.aiTitle || entry.title || entry.customTitle);
      if (title) {
        aiTitle = title;
      }
      continue;
    }

    if (entry.type === "summary") {
      const value = cleanSessionName(entry.summary || entry.text || entry.content);
      if (value) {
        summary = value;
      }
      continue;
    }

    // Some Claude Code builds stash title fields on other metadata rows.
    const inlineCustom = cleanSessionName(entry.customTitle);
    if (inlineCustom) {
      customTitle = inlineCustom;
    }
    const inlineAi = cleanSessionName(entry.aiTitle);
    if (inlineAi) {
      aiTitle = inlineAi;
    }

    if (!firstUserText && entry.type === "user") {
      const message = entry.message && typeof entry.message === "object" ? entry.message : {};
      const textContent = textFromMessageContent(message.content ?? entry.content);
      // Skip meta/system-looking prompts that are not useful as a session name.
      if (textContent && !textContent.startsWith("<") && textContent.toLowerCase() !== "warmstart") {
        firstUserText = textContent;
      }
    }
  }

  return customTitle || aiTitle || summary || firstUserText || "";
}

/**
 * Claude Code's placeholder model id for a turn that never hit the API.
 *
 * Written as `<synthetic>` on interrupts and local slash commands, always with
 * an all-zero usage payload, so it is not a billable call.
 */
export function isSyntheticModel(model) {
  return /^<.*>$/.test(String(model ?? "").trim());
}

/**
 * Total billable tokens on a usage payload — the "is this the real one?" test.
 *
 * Cache writes arrive in either shape: a flat `cache_creation_input_tokens`, or
 * a structured `cache_creation` with 5m/1h buckets. Counting only the flat field
 * undervalued new-format records, so a stale old-format one could outweigh the
 * record that actually carried the write tokens. Mirrors how
 * `computeClaudeUsageCost` reads the same two shapes.
 */
function usageWeight(usage = {}) {
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object"
    ? usage.cache_creation
    : null;
  const cacheWrite = cacheCreation
    ? numberValue(cacheCreation.ephemeral_5m_input_tokens)
      + numberValue(cacheCreation.ephemeral_1h_input_tokens)
    : numberValue(usage.cache_creation_input_tokens);
  return numberValue(usage.input_tokens)
    + numberValue(usage.cache_read_input_tokens)
    + cacheWrite
    + numberValue(usage.output_tokens);
}

export function parseClaudeUsageLog(text) {
  // Claude Code writes one record per content block, repeating the SAME
  // message.id. Usage is attached to the LAST of those records — the earlier
  // ones carry an all-zero payload. Keeping the first (a plain `seen` set)
  // priced most calls at zero: a real subagent log with 636k tokens reported
  // $0.00. Billing is per API call, so keep one row per id in first-seen order
  // (`slotOf` points an id at the slot it owns) and let the richest usage win.
  /** @type {{ model: string, usage: object, weight: number }[]} */
  const calls = [];
  /** @type {Map<string, number>} */
  const slotOf = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") {
      continue;
    }
    const message = entry.message && typeof entry.message === "object" ? entry.message : {};
    const model = message.model || entry.model || "?";
    // `<synthetic>` marks a turn that never reached the API (interrupt, local
    // command) and always carries an all-zero payload — not a billable call.
    if (isSyntheticModel(model)) {
      continue;
    }
    const usage = entry.usage || message.usage || {};
    const weight = usageWeight(usage);
    // `||` not `??`: an empty-string id must fall through to the next
    // candidate, or every id-less record collapses into one bucket.
    const key = message.id || entry.requestId || entry.uuid || "";
    if (!key) {
      // No identity to dedupe on — count it as its own call.
      calls.push({ model, usage, weight });
      continue;
    }
    const slot = slotOf.get(key);
    if (slot === undefined) {
      slotOf.set(key, calls.length);
      calls.push({ model, usage, weight });
      continue;
    }
    // Ties keep the earlier record: repeated all-zero blocks shouldn't churn.
    if (weight > calls[slot].weight) {
      calls[slot] = { model: model || calls[slot].model, usage, weight };
    }
  }

  return calls.map(({ model, usage }) => computeClaudeUsageCost(model, usage));
}

function sumRows(rows) {
  return rows.reduce((totals, row) => ({
    input: totals.input + row.input,
    cacheWrite5m: totals.cacheWrite5m + row.cacheWrite5m,
    cacheWrite1h: totals.cacheWrite1h + row.cacheWrite1h,
    cacheRead: totals.cacheRead + row.cacheRead,
    output: totals.output + row.output,
    webSearches: totals.webSearches + row.webSearches,
    cost: totals.cost + row.cost,
  }), {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    webSearches: 0,
    cost: 0,
  });
}

function addTotals(a, b) {
  return {
    input: a.input + b.input,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    webSearches: a.webSearches + b.webSearches,
    cost: a.cost + b.cost,
  };
}

function rowHasUsage(row) {
  return row.input > 0
    || row.cacheWrite5m > 0
    || row.cacheWrite1h > 0
    || row.cacheRead > 0
    || row.output > 0
    || row.webSearches > 0
    || row.cost > 0;
}

function reportHasUsage(report) {
  return report.rows.length > 0 || (report.subagents ?? []).some((subagent) => subagent.rows.length > 0);
}

function reportFromRows(filePath, rows, { sessionName = "" } = {}) {
  const usedRows = rows.filter(rowHasUsage);
  const report = {
    path: filePath,
    requests: usedRows.length,
    rows: usedRows,
    totals: sumRows(usedRows),
    estimated: usedRows.some((row) => row.estimated),
  };
  if (sessionName) {
    report.sessionName = sessionName;
  }
  return report;
}

async function readUsageFile(filePath, { includeSessionName = false } = {}) {
  const text = await readFile(filePath, "utf8");
  return usageReportFromText(filePath, text, { includeSessionName });
}

export function usageReportFromText(filePath, text, { includeSessionName = false } = {}) {
  const sessionName = includeSessionName ? parseClaudeSessionName(text) : "";
  return reportFromRows(filePath, parseClaudeUsageLog(text), { sessionName });
}

async function findSubagentLogs(sessionLogPath) {
  const sessionId = path.basename(sessionLogPath, ".jsonl");
  const subagentsDir = path.join(path.dirname(sessionLogPath), sessionId, "subagents");
  const files = (await collectJsonlFiles(subagentsDir))
    .filter((filePath) => path.basename(filePath).startsWith("agent-"));
  const withMtime = await filesWithMtime(files);
  withMtime.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return withMtime.map(({ filePath }) => filePath);
}
export { findSubagentLogs };

async function readClaudeUsageAtPath(sessionPath) {
  const report = await readUsageFile(sessionPath, { includeSessionName: true });
  const subagents = (await Promise.all(
    (await findSubagentLogs(sessionPath)).map(async (subagentPath) => {
      const subagent = await readUsageFile(subagentPath);
      return {
        ...subagent,
        id: path.basename(subagentPath, ".jsonl").replace(/^agent-/, ""),
      };
    }),
  )).filter((subagent) => subagent.rows.length > 0);
  const grandTotals = subagents.reduce(
    (totals, subagent) => addTotals(totals, subagent.totals),
    report.totals,
  );
  return {
    ...report,
    subagents,
    grandTotals,
    grandRequests: report.requests + subagents.reduce((total, subagent) => total + subagent.requests, 0),
    estimated: report.estimated || subagents.some((subagent) => subagent.estimated),
  };
}

export async function readClaudeUsage({ home, session = "" }) {
  return readClaudeUsageAtPath(await findClaudeSessionLog({ home, session }));
}

export async function readClaudeUsages({ home, session = "", lastN = 1 }) {
  const requestedLastN = parseLastN(lastN);
  const sessionPaths = await findClaudeSessionLogs({ home, session, lastN });
  const sessions = (await Promise.all(sessionPaths.map(readClaudeUsageAtPath))).filter(reportHasUsage);
  const grandTotals = sessions.reduce(
    (totals, report) => addTotals(totals, report.grandTotals),
    sumRows([]),
  );
  return {
    sessions,
    grandTotals,
    grandRequests: sessions.reduce((total, report) => total + report.grandRequests, 0),
    estimated: sessions.some((report) => report.estimated),
    lastN: sessions.length,
    requestedLastN,
    sessionCount: sessions.length,
  };
}

function fmtInt(value) {
  return value.toLocaleString("en-US");
}

function fmtCost(value) {
  return value.toFixed(2);
}

function fmtRate(value) {
  const text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

function padCell(value, width, align = "left") {
  const text = String(value);
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function splitLongWord(word, width) {
  const chunks = [];
  for (let i = 0; i < word.length; i += width) {
    chunks.push(word.slice(i, i + width));
  }
  return chunks;
}

function wrapCell(value, width) {
  const text = String(value ?? "");
  if (text.length === 0) {
    return [""];
  }

  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let current = "";
    for (const word of rawLine.split(/\s+/)) {
      if (!word) {
        continue;
      }
      if (word.length > width) {
        if (current) {
          lines.push(current);
          current = "";
        }
        lines.push(...splitLongWord(word, width));
        continue;
      }
      const next = current ? `${current} ${word}` : word;
      if (next.length > width) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function tableBorder(widths, left, middle, right) {
  return `${left}${widths.map((width) => "-".repeat(width + 2)).join(middle)}${right}`;
}

function formatWrappedTable({ headers, rows, widths, aligns = [], label = "", dividerBeforeLast = false }) {
  const lines = [];
  if (label) {
    lines.push(label);
  }

  const top = tableBorder(widths, "+", "+", "+");
  const sep = tableBorder(widths, "+", "+", "+");
  lines.push(top);

  const renderRow = (cells) => {
    const wrapped = cells.map((value, index) => wrapCell(value, widths[index]));
    const height = Math.max(...wrapped.map((cellLines) => cellLines.length));
    for (let i = 0; i < height; i += 1) {
      lines.push(`|${wrapped.map((cellLines, index) => {
        const align = aligns[index] ?? "left";
        return ` ${padCell(cellLines[i] ?? "", widths[index], align)} `;
      }).join("|")}|`);
    }
  };

  renderRow(headers);
  lines.push(sep);
  rows.forEach((row, index) => {
    if (dividerBeforeLast && index === rows.length - 1) {
      lines.push(sep);
    }
    renderRow(row);
  });
  lines.push(top);
  return lines;
}

function allRows(report) {
  return [
    ...report.rows,
    ...(report.subagents ?? []).flatMap((subagent) => subagent.rows),
  ];
}

function modelRateRows(report) {
  const seen = new Set();
  const rows = [];
  for (const row of allRows(report)) {
    const key = [
      row.model,
      row.rates.inputPerMillion,
      row.rates.cacheWrite5mPerMillion,
      row.rates.cacheWrite1hPerMillion,
      row.rates.cacheReadPerMillion,
      row.rates.outputPerMillion,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      model: row.displayModel,
      rates: row.rates,
      fireworks: row.fireworks,
    });
  }
  rows.sort((a, b) => a.model.localeCompare(b.model));
  return rows;
}

function formatEstimateExplanation(report) {
  const rates = modelRateRows(report);
  if (rates.length === 0) {
    return [];
  }

  const lines = [
    ...formatCostEstimateNote(),
    "",
    "Usage columns:",
    "  Request #: request number within this section.",
    "  Model: model id recorded for the assistant response.",
    "  Input: non-cached input tokens billed at the input rate.",
    "  5m Cache Write: input tokens written to a five-minute prompt cache.",
    "  1h Cache Write: input tokens written to a one-hour prompt cache.",
    "  Cache Read: input tokens served from prompt cache.",
    "  Output: generated output tokens.",
    "  Cost (USD): estimated cost for that request.",
    "",
    "Rates used for models in this session (USD per 1M tokens):",
  ];

  const rows = rates.map((row) => {
    const r = row.rates;
    return [
      row.model,
      fmtRate(r.inputPerMillion),
      row.fireworks ? "-" : fmtRate(r.cacheWrite5mPerMillion),
      row.fireworks ? "-" : fmtRate(r.cacheWrite1hPerMillion),
      fmtRate(r.cacheReadPerMillion),
      fmtRate(r.outputPerMillion),
    ];
  });
  lines.push(...formatWrappedTable({
    headers: ["Model", "Input", "5m Write", "1h Write", "Cache Read", "Output"],
    rows,
    widths: [28, 10, 10, 10, 10, 10],
    aligns: ["left", "right", "right", "right", "right", "right"],
  }));
  lines.push("");
  return lines;
}

function formatRowsTable(rows, totals) {
  const tableRows = rows.map((row, index) => {
    const fireworks = row.fireworks;
    return [
      index + 1,
      row.displayModel,
      fmtInt(row.input),
      fireworks ? "-" : fmtInt(row.cacheWrite5m),
      fireworks ? "-" : fmtInt(row.cacheWrite1h),
      fmtInt(row.cacheRead),
      fmtInt(row.output),
      fmtCost(row.cost),
    ];
  });
  tableRows.push([
    "",
    "TOTAL",
    fmtInt(totals.input),
    fmtInt(totals.cacheWrite5m),
    fmtInt(totals.cacheWrite1h),
    fmtInt(totals.cacheRead),
    fmtInt(totals.output),
    fmtCost(totals.cost),
  ]);
  return formatWrappedTable({
    headers: ["Request #", "Model", "Input", "5m Cache Write", "1h Cache Write", "Cache Read", "Output", "Cost (USD)"],
    rows: tableRows,
    widths: [9, 24, 10, 11, 11, 10, 10, 10],
    aligns: ["right", "left", "right", "right", "right", "right", "right", "right"],
    dividerBeforeLast: true,
  });
}

function summarizeUsageRows(rows) {
  const byModel = new Map();
  for (const row of rows) {
    const subagentId = row.subagentId ?? "Parent";
    const key = `${subagentId}|${row.model}`;
    const current = byModel.get(key) ?? {
      subagentId,
      model: row.model,
      calls: 0,
      input: 0,
      output: 0,
      cost: 0,
    };
    current.calls += 1;
    current.input += row.input;
    current.output += row.output;
    current.cost += row.cost;
    byModel.set(key, current);
  }
  return [...byModel.values()].sort((a, b) => (
    (a.subagentId === "Parent" && b.subagentId !== "Parent" ? -1 : 0)
    || (b.subagentId === "Parent" && a.subagentId !== "Parent" ? 1 : 0)
    || a.subagentId.localeCompare(b.subagentId)
    || a.model.localeCompare(b.model)
  ));
}

function formatPlainSummaryTable(rows, label) {
  let calls = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  const tableRows = rows.map((row) => {
    calls += row.calls;
    input += row.input;
    output += row.output;
    cost += row.cost;
    return [
      row.subagentId,
      row.model,
      fmtInt(row.calls),
      fmtInt(row.input),
      fmtInt(row.output),
      fmtCost(row.cost),
    ];
  });

  tableRows.push(["TOTAL", "", fmtInt(calls), fmtInt(input), fmtInt(output), fmtCost(cost)]);
  return formatWrappedTable({
    label,
    headers: ["Parent/Sub-agent ID", "Model", "Calls", "Input", "Output", "Cost (USD)"],
    rows: tableRows,
    widths: [20, 42, 7, 10, 10, 10],
    aligns: ["left", "left", "right", "right", "right", "right"],
    dividerBeforeLast: true,
  });
}

function formatPlainSessionTotalsTable(sessions, label) {
  const tableRows = sessions.map((report) => [
    sessionBannerLabel(report),
    fmtInt(report.grandRequests),
    fmtInt(report.grandTotals.input),
    fmtInt(report.grandTotals.output),
    fmtCost(report.grandTotals.cost),
  ]);

  const totals = sessions.reduce(
    (total, report) => ({
      calls: total.calls + report.grandRequests,
      input: total.input + report.grandTotals.input,
      output: total.output + report.grandTotals.output,
      cost: total.cost + report.grandTotals.cost,
    }),
    { calls: 0, input: 0, output: 0, cost: 0 },
  );
  tableRows.push(["GRAND TOTAL", fmtInt(totals.calls), fmtInt(totals.input), fmtInt(totals.output), fmtCost(totals.cost)]);
  return formatWrappedTable({
    label,
    headers: ["Session", "Calls", "Input", "Output", "Cost (USD)"],
    rows: tableRows,
    widths: [36, 8, 12, 12, 10],
    aligns: ["left", "right", "right", "right", "right"],
    dividerBeforeLast: true,
  });
}

function plainSummaryRowsForReport(report) {
  return summarizeUsageRows([
    ...report.rows.map((row) => ({ ...row, subagentId: "Parent" })),
    ...(report.subagents ?? []).flatMap((subagent) => (
      subagent.rows.map((row) => ({ ...row, subagentId: subagent.id }))
    )),
  ]);
}

function formatTotalsLine(label, totals) {
  return `${label}: $${fmtCost(totals.cost)} (${fmtInt(totals.input)} input, ${fmtInt(totals.cacheRead)} cache read, ${fmtInt(totals.output)} output)`;
}

function sessionId(report) {
  return path.basename(report.path, ".jsonl");
}

function sessionBannerLabel(report) {
  const id = sessionId(report);
  const name = typeof report.sessionName === "string" ? report.sessionName.replace(/\s+/g, " ").trim() : "";
  return name ? `${id} (${name})` : id;
}

function formatClaudeUsageVerboseReport(report) {
  if (report.rows.length === 0 && (report.subagents ?? []).length === 0) {
    return `No assistant entries found in ${report.path}`;
  }

  const lines = [
    `Session log: ${report.path}`,
  ];
  if (report.sessionName) {
    lines.push(`Session name: ${report.sessionName}`);
  }
  lines.push("", ...formatEstimateExplanation(report));

  if (report.rows.length > 0) {
    lines.push(...formatRowsTable(report.rows, report.totals));
    lines.push("");
    lines.push(`Requests: ${report.requests}`);
  }

  for (const subagent of report.subagents ?? []) {
    lines.push("");
    lines.push(`---- sub-agent ${subagent.id} ----`);
    lines.push(`Sub-agent log: ${subagent.path}`);
    lines.push("");
    lines.push(...formatRowsTable(subagent.rows, subagent.totals));
    lines.push(formatTotalsLine("Sub-agent total cost", subagent.totals));
    lines.push(`Requests: ${subagent.requests}`);
    lines.push(`---- sub-agent ${subagent.id} ----`);
  }

  lines.push("");
  lines.push(formatTotalsLine("Grand total cost", report.grandTotals));
  lines.push(`Grand requests: ${report.grandRequests}`);

  if (report.estimated) {
    lines.push("Note: Some rows used fallback/reference pricing because the model id was not recognized.");
  }
  return lines.join("\n");
}

function formatClaudeUsagePlainSummaryReport(report) {
  if (report.rows.length === 0 && (report.subagents ?? []).length === 0) {
    return `No assistant entries found in ${report.path}`;
  }

  const lines = [
    ...formatCostEstimateNote(),
    "",
    `Session log: ${report.path}`,
  ];
  if (report.sessionName) {
    lines.push(`Session name: ${report.sessionName}`);
  }
  lines.push("");

  lines.push(...formatPlainSummaryTable(plainSummaryRowsForReport(report), "Usage summary:"));
  lines.push(`Grand requests: ${report.grandRequests}`);

  if (report.estimated) {
    lines.push("Note: Some rows used fallback/reference pricing because the model id was not recognized.");
  }
  return lines.join("\n");
}

export function formatClaudeUsageReport(report, { verbose = false, plain = false, stream } = {}) {
  if (verbose) {
    return formatClaudeUsageVerboseReport(report);
  }
  if (plain) {
    return formatClaudeUsagePlainSummaryReport(report);
  }
  return formatClaudeUsageSummaryDisplay(report, { stream });
}

export function formatClaudeUsageReports(reportGroup, { verbose = false, plain = false, stream } = {}) {
  const sessions = reportGroup.sessions ?? [];
  if (sessions.length === 0) {
    return "No Claude Code session usage found.";
  }
  if (verbose) {
    const lines = [];
    sessions.forEach((report, index) => {
      if (index > 0) {
        lines.push("");
      }
      lines.push(`================ start session ${sessionBannerLabel(report)} ================`);
      lines.push(formatClaudeUsageVerboseReport(report));
      lines.push(`================ end session ${sessionBannerLabel(report)} ================`);
    });
    lines.push("");
    lines.push(formatTotalsLine(`Grand total cost for last ${sessions.length} sessions`, reportGroup.grandTotals));
    lines.push(`Grand requests for last ${sessions.length} sessions: ${reportGroup.grandRequests}`);
    if (reportGroup.estimated) {
      lines.push("Note: Some rows used fallback/reference pricing because the model id was not recognized.");
    }
    return lines.join("\n");
  }
  if (plain) {
    if (sessions.length === 1) {
      return formatClaudeUsagePlainSummaryReport(sessions[0]);
    }
    const lines = [];
    sessions.forEach((report, index) => {
      if (index > 0) {
        lines.push("");
      }
      lines.push(`================ start session ${sessionBannerLabel(report)} ================`);
      lines.push(formatClaudeUsagePlainSummaryReport(report));
      lines.push(`================ end session ${sessionBannerLabel(report)} ================`);
    });
    lines.push("");
    lines.push(...formatPlainSessionTotalsTable(sessions, `Session totals for last ${sessions.length} sessions:`));
    if (reportGroup.estimated) {
      lines.push("Note: Some rows used fallback/reference pricing because the model id was not recognized.");
    }
    return lines.join("\n");
  }
  return formatClaudeUsageReportsSummaryDisplay(reportGroup, { stream });
}
