/**
 * Claude Code status line: the Fireworks model actually being routed, plus a
 * cost computed from Fireworks rates.
 *
 * Claude Code's own `cost.total_cost_usd` prices every call against Anthropic's
 * list, so on a Fireworks gateway it reports a number the user is never billed.
 * The session transcript records the real model id and token usage per API call,
 * so the cost here is recomputed from it with the same engine `claude usage`
 * uses — which prices each call by its own model, and therefore stays correct
 * across a session that switched slots mid-flight.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { shellQuote } from "../../cli/path.mjs";
import {
  appendLatestRouterSuffix,
  lookupModelSpec,
  resolveFireworksModelLabel,
  resolveSpecSlug,
  specShortIdFromModelRef,
} from "../../fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../fireworks/pricing.mjs";
import { providerListPricing } from "../../demo/list-pricing.mjs";
import { isAnthropicModelId, isAutoModelId, isClaudeNativeModel } from "../../fireworks/model-id.mjs";
import { autoDisplayName, prettyModelName, stripViaFireworksSuffix } from "../../fireworks/models.mjs";
import { UNPRICED_TEXT, addUsage } from "./usage/cost.mjs";
import {
  formatUsageCost,
  formatUsageCachePct,
} from "./usage/format.mjs";

/** The helper Claude Code spawns on every status line refresh. */
const STATUSLINE_SCRIPT = fileURLToPath(
  new URL("../../../bin/claude-statusline.mjs", import.meta.url),
);

/** Substring that identifies a FireConnect-managed statusLine command. */
const STATUSLINE_MARKER = "bin/claude-statusline.mjs";

/**
 * Shell command for the `statusLine.command` field.
 *
 * `process.execPath` rather than a bare `node`: Claude Code spawns the status
 * line through a shell whose PATH may not include the Node that runs the CLI
 * (same reason apiKeyHelper embeds it — see fireconnectExportCommand).
 */
export function claudeStatusLineCommand() {
  return `${shellQuote(process.execPath)} ${shellQuote(STATUSLINE_SCRIPT)}`;
}

/**
 * The `statusLine` block FireConnect writes into settings.json.
 *
 * No `refreshInterval`: the cost only changes when a call completes, and Claude
 * Code already re-runs the command on every assistant message. A timer would
 * re-read the transcript for an unchanged number.
 */
export function claudeStatusLineSettings() {
  return { type: "command", command: claudeStatusLineCommand() };
}

/**
 * True when `statusLine` is one FireConnect wrote (so `on` may replace it and
 * `off` may remove it). A user's own status line matches nothing here and is
 * left alone.
 * @param {unknown} statusLine
 */
export function isFireconnectStatusLine(statusLine) {
  if (!statusLine || typeof statusLine !== "object") {
    return false;
  }
  const command = /** @type {{ command?: unknown }} */ (statusLine).command;
  return typeof command === "string" && command.includes(STATUSLINE_MARKER);
}

/**
 * Add the managed status line, preserving a user's own.
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function withClaudeStatusLine(settings) {
  if (Object.hasOwn(settings, "statusLine") && !isFireconnectStatusLine(settings.statusLine)) {
    return settings;
  }
  return { ...settings, statusLine: claudeStatusLineSettings() };
}

/**
 * Remove the managed status line. Returns `{ settings, changed }` like the
 * sibling strip helpers in core.mjs so callers don't diff before and after.
 * @param {Record<string, unknown>} settings
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function stripClaudeStatusLine(settings) {
  if (!isFireconnectStatusLine(settings?.statusLine)) {
    return { settings, changed: false };
  }
  const next = { ...settings };
  delete next.statusLine;
  return { settings: next, changed: true };
}

// Raw ANSI escapes (stdout is a pipe, not a TTY). Every SGR must end with `m`.
const COLOR = process.env.NO_COLOR ? null : {
  bold: "\x1b[1m",
  primary: "\x1b[39m",
  secondary: "\x1b[2m\x1b[39m",
  reset: "\x1b[0m",
};

// Series hues for bar segments and swatches only; text uses COLOR tokens above.
const SERIES_COLORS = Object.freeze([
  "\x1b[38;2;57;135;229m", // #3987e5 blue
  "\x1b[38;2;217;89;38m", // #d95926 orange
  "\x1b[38;2;25;158;112m", // #199e70 aqua
  "\x1b[38;2;201;133;0m", // #c98500 yellow
  "\x1b[38;2;213;81;129m", // #d55181 magenta
  "\x1b[38;2;0;131;0m", // #008300 green
  "\x1b[38;2;144;133;233m", // #9085e9 violet
  "\x1b[38;2;230;103;103m", // #e66767 red
]);

/** @param {keyof typeof COLOR} name @param {string} text */
function paint(name, text) {
  return COLOR ? `${COLOR[name]}${text}${COLOR.reset}` : String(text);
}

/** A mark in a series hue — bar segment or legend swatch, never prose. */
function paintSeries(index, mark) {
  if (!COLOR) {
    return String(mark);
  }
  return `${SERIES_COLORS[index % SERIES_COLORS.length]}${mark}${COLOR.reset}`;
}

function sep() {
  return paint("secondary", "·");
}

/** Join non-empty parts with the dim separator. */
function joinParts(parts) {
  return parts.filter(Boolean).join(` ${sep()} `);
}

/**
 * The bar's fill glyph, doubling as the legend swatch so a legend entry reads as
 * a piece of the bar. Heavy horizontal rule (U+2501): unambiguous single-column
 * width in every terminal, unlike the square/circle glyphs legends usually use,
 * which are East-Asian-ambiguous and can render double-wide and misalign.
 */
const BAR_MARK = "━";

/**
 * Stacked bar by spend share (not call count). Width only — no in-bar labels.
 * @param {Array<{ label: string, costShare: number }>} models largest first
 * @param {number} width total bar width in cells
 * @returns {string}
 */
function renderModelBar(models, width) {
  if (models.length === 0) {
    return "";
  }
  const gaps = models.length - 1;
  const inkWidth = Math.max(models.length, width - gaps);
  const widths = models.map((m) => Math.max(1, Math.round(m.costShare * inkWidth)));
  const drift = inkWidth - widths.reduce((sum, w) => sum + w, 0);
  if (drift !== 0) {
    widths[0] = Math.max(1, widths[0] + drift);
  }
  return models
    .map((model, index) => paintSeries(index, BAR_MARK.repeat(widths[index])))
    .join(" ");
}

/** Drop trailing parenthetical qualifiers when they fit the legend width. */
function compactModelLabel(label) {
  return String(label).replace(/\s*\([^)]*\)\s*$/, "").trim() || String(label);
}

/**
 * Human label for the routed model (mirrors picker naming without importing core.mjs).
 * @param {string} modelId
 * @returns {string}
 */
export function claudeStatusLineModelLabel(modelId) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return "unknown model";
  }
  if (isAutoModelId(id)) {
    return autoDisplayName(id);
  }
  const live = resolveFireworksModelLabel(id);
  if (live) {
    return stripViaFireworksSuffix(live);
  }
  const spec = lookupModelSpec(id);
  if (spec?.label) {
    return stripViaFireworksSuffix(appendLatestRouterSuffix(id, spec.label));
  }
  const pricing = lookupFireworksPricing(id);
  if (pricing?.label) {
    return stripViaFireworksSuffix(appendLatestRouterSuffix(id, pricing.label));
  }
  if (isAnthropicModelId(id)) {
    const anthropic = providerListPricing({ provider: "anthropic", modelId: id });
    if (anthropic?.label && !anthropic.estimated) {
      return anthropic.label;
    }
  }
  const shortId = specShortIdFromModelRef(id) || id;
  if (!/(?:^|-)[a-z]?\d+p\d+(?:-|$)/.test(shortId)) {
    return shortId;
  }
  const withoutLatest = shortId.replace(/-latest$/, "");
  const region = withoutLatest.endsWith("-us") ? " (US)" : "";
  const base = withoutLatest.replace(/-us$/, "");
  return appendLatestRouterSuffix(id, `${prettyModelName(base)}${region}`);
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Fireworks-accurate usage for the session (parent + subagents).
 * @param {string} transcriptPath
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ cost: number, estimated: boolean, lastModel: string, models: Array<{ label: string, share: number, calls: number, cost: number }>, cachePct: string } | null>}
 */
export async function claudeStatusLineUsage(transcriptPath, { home = process.env.HOME ?? "" } = {}) {
  const target = String(transcriptPath ?? "").trim();
  if (!target || !path.isAbsolute(target) || !await isFile(target)) {
    return null;
  }
  const { readClaudeUsage } = await import("./usage/report.mjs");
  const report = await readClaudeUsage({ home, session: target });
  const lastModel = report.rows.at(-1)?.model ?? "";
  const allRows = [
    ...report.rows,
    ...(report.subagents ?? []).flatMap((subagent) => subagent.rows),
  ];
  if (allRows.length === 0) {
    return null;
  }
  /** @type {Map<string, { calls: number, cost: number | null, input: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number }>} */
  const byModel = new Map();
  for (const row of allRows) {
    const sid = resolveSpecSlug(row.model);
    if (!sid) continue;
    const entry = byModel.get(sid)
      ?? {
        calls: 0,
        cost: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      };
    byModel.set(sid, {
      ...entry,
      ...addUsage(entry, row),
      calls: entry.calls + 1,
    });
  }
  const totalCalls = allRows.length || 1;
  const modelTallies = [...byModel.values()];
  const hasUnpriced = modelTallies.some((entry) => entry.cost == null);
  const totalCost = modelTallies.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  const models = [...byModel.entries()]
    .sort((a, b) => (
      hasUnpriced
        ? b[1].calls - a[1].calls
        : (b[1].cost ?? 0) - (a[1].cost ?? 0) || b[1].calls - a[1].calls
    ))
    .map(([sid, entry]) => ({
      label: claudeStatusLineModelLabel(sid),
      costShare: !hasUnpriced && totalCost > 0
        ? entry.cost / totalCost
        : entry.calls / totalCalls,
      share: entry.calls / totalCalls,
      calls: entry.calls,
      cost: entry.cost,
      cachePct: formatUsageCachePct(entry),
    }));
  return {
    cost: report.grandTotals.cost,
    estimated: report.estimated,
    lastModel,
    models,
    cachePct: formatUsageCachePct(report.grandTotals),
  };
}

const MODEL_BAR_WIDTH = 16;

/**
 * Build the two-line status line from Claude Code's stdin payload.
 * @param {{
 *   model?: { id?: string, display_name?: string },
 *   transcript_path?: string,
 * }} input
 * @param {{ home?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function renderClaudeStatusLine(input = {}, { home = process.env.HOME ?? "" } = {}) {
  const slotModelId = input.model?.id ?? "";
  const slotLabel = isClaudeNativeModel(slotModelId)
    ? (input.model?.display_name || "Claude default")
    : claudeStatusLineModelLabel(slotModelId);

  let usage = null;
  try {
    usage = await claudeStatusLineUsage(input.transcript_path ?? "", { home });
  } catch {
    usage = null;
  }

  const multi = (usage?.models.length ?? 0) > 1;

  const bar = usage?.models.length
    ? renderModelBar(usage.models, MODEL_BAR_WIDTH)
    : "";
  const line1 = joinParts([
    bar || paint("secondary", slotLabel),
    usage && (usage.cost == null
      ? paint("secondary", `cost ${UNPRICED_TEXT}`)
      : `${usage.estimated ? "~" : ""}${COLOR ? COLOR.bold : ""}${paint("primary", formatUsageCost(usage.cost))}`),
  ]);

  const rawLabels = usage?.models.map((m) => m.label) ?? [];
  const compact = rawLabels.map(compactModelLabel);
  const labelCounts = new Map();
  for (const label of compact) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const labels = compact.map((label, index) => (
    labelCounts.get(label) > 1 ? String(rawLabels[index]) : label
  ));
  const legend = usage?.models.map((m, index) => {
    const label = labels[index];
    const cache = m.cachePct && m.cachePct !== "—" ? ` ${m.cachePct} cache` : "";
    const text = multi
      ? `${label} ${formatUsageCost(m.cost)}${cache}`
      : `${label}${cache}`;
    return `${paintSeries(index, BAR_MARK)} ${paint("primary", text)}`;
  }) ?? [];
  const line2 = joinParts(legend);

  return [line1, line2].filter(Boolean).join("\n");
}
