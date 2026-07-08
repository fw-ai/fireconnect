import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { lookupFireworksPricing } from "./fireworks-pricing.mjs";
import { providerListPricing } from "./demo/incumbent-detect.mjs";

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
const ANTHROPIC_PRICING_DOCS_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
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
    files.map(async (filePath) => ({ filePath, mtimeMs: (await stat(filePath)).mtimeMs })),
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
 * @param {{ home: string, session?: string }} args
 */
export async function findClaudeSessionLog({ home, session = "" }) {
  return (await findClaudeSessionLogs({ home, session, lastN: 1 }))[0];
}

/**
 * @param {{ home: string, session?: string, lastN?: number|string }} args
 */
export async function findClaudeSessionLogs({ home, session = "", lastN = 1 }) {
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

  const withMtime = await filesWithMtime(candidates);
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

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

  return withMtime.slice(0, parseLastN(lastN)).map(({ filePath }) => filePath);
}

function isFireworks(model) {
  return model.startsWith("accounts/fireworks/");
}

function displayModel(model) {
  if (model.startsWith("accounts/fireworks/models/")) {
    return model.slice("accounts/fireworks/models/".length);
  }
  if (model.startsWith("accounts/fireworks/routers/")) {
    return model.slice("accounts/fireworks/routers/".length);
  }
  return model;
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
  let price = isFireworks(model) ? fireworkPriceFor(model) : anthropicPriceFor(model);
  price ??= DEFAULT_PRICE;

  const fast = usage.speed === "fast" ? fastPriceFor(model) : null;
  if (fast) {
    return {
      ...price,
      input: fast.input,
      cacheWrite5m: fast.input * 1.25,
      cacheWrite1h: fast.input * 2,
      cacheRead: fast.input * 0.1,
      output: fast.output,
    };
  }
  return price;
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

export function parseClaudeUsageLog(text) {
  const seen = new Set();
  const rows = [];

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
    const key = message.id || entry.requestId || entry.uuid || "";
    if (key) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    const model = message.model || entry.model || "?";
    const usage = entry.usage || message.usage || {};
    rows.push(computeClaudeUsageCost(model, usage));
  }

  return rows;
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

function reportFromRows(filePath, rows) {
  const usedRows = rows.filter(rowHasUsage);
  return {
    path: filePath,
    requests: usedRows.length,
    rows: usedRows,
    totals: sumRows(usedRows),
    estimated: usedRows.some((row) => row.estimated),
  };
}

async function readUsageFile(filePath) {
  return reportFromRows(filePath, parseClaudeUsageLog(await readFile(filePath, "utf8")));
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

async function readClaudeUsageAtPath(sessionPath) {
  const report = await readUsageFile(sessionPath);
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
      fireworks: isFireworks(row.model),
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

function formatCostEstimateNote() {
  return [
    "Cost estimate:",
    "  Fireworks-served model estimate per request: (input * input rate + cache writes * cache-write rates + cache reads * cache-read rate + output * output rate) / 1,000,000.",
    `  Anthropic model usage is fetched from session logs; estimated cost is calculated from local rates and may be affected by tool usage, inference service tier and location, and other factors. Reference: ${ANTHROPIC_PRICING_DOCS_URL}`,
    "  ***All pricing shown below are estimates based on token usage, please refer to service-specific billing pages for actual cost information***",
  ];
}

function formatRowsTable(rows, totals) {
  const tableRows = rows.map((row, index) => {
    const fireworks = isFireworks(row.model);
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

function formatSummaryTable(rows, label) {
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

function formatSessionTotalsTable(sessions, label) {
  const tableRows = sessions.map((report) => [
    sessionId(report),
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

function summaryRowsForReport(report, scope = "parent") {
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

function formatClaudeUsageVerboseReport(report) {
  if (report.rows.length === 0 && (report.subagents ?? []).length === 0) {
    return `No assistant entries found in ${report.path}`;
  }

  const lines = [
    `Session log: ${report.path}`,
    "",
    ...formatEstimateExplanation(report),
  ];

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

function formatClaudeUsageSummaryReport(report) {
  if (report.rows.length === 0 && (report.subagents ?? []).length === 0) {
    return `No assistant entries found in ${report.path}`;
  }

  const lines = [
    ...formatCostEstimateNote(),
    "",
    `Session log: ${report.path}`,
    "",
  ];

  lines.push(...formatSummaryTable(summaryRowsForReport(report), "Usage summary:"));
  lines.push(`Grand requests: ${report.grandRequests}`);

  if (report.estimated) {
    lines.push("Note: Some rows used fallback/reference pricing because the model id was not recognized.");
  }
  return lines.join("\n");
}

export function formatClaudeUsageReport(report, { verbose = false } = {}) {
  return verbose ? formatClaudeUsageVerboseReport(report) : formatClaudeUsageSummaryReport(report);
}

export function formatClaudeUsageReports(reportGroup, { verbose = false } = {}) {
  const sessions = reportGroup.sessions ?? [];
  if (sessions.length === 0) {
    return "No Claude Code session usage found.";
  }
  if (sessions.length === 1) {
    return formatClaudeUsageReport(sessions[0], { verbose });
  }

  const lines = [];
  sessions.forEach((report, index) => {
    if (index > 0) {
      lines.push("");
    }
    lines.push(`================ start session ${sessionId(report)} ================`);
    lines.push(formatClaudeUsageReport(report, { verbose }));
    lines.push(`================ end session ${sessionId(report)} ================`);
  });
  lines.push("");
  if (verbose) {
    lines.push(formatTotalsLine(`Grand total cost for last ${sessions.length} sessions`, reportGroup.grandTotals));
    lines.push(`Grand requests for last ${sessions.length} sessions: ${reportGroup.grandRequests}`);
  } else {
    lines.push(...formatSessionTotalsTable(sessions, `Session totals for last ${sessions.length} sessions:`));
  }
  if (reportGroup.estimated) {
    lines.push("Note: Some rows used fallback/reference pricing because the model id was not recognized.");
  }
  return lines.join("\n");
}
