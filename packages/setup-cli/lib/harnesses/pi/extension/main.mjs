/**
 * FireConnect's Pi footer usage bar: an in-process extension that tallies
 * every model call's usage as it finishes (`message_end`) and renders a
 * spend-by-model bar plus the session cost at Fireworks rates into Pi's
 * footer status line (`ctx.ui.setStatus`).
 *
 * Why not a spawned status-line helper like Claude Code's: Pi has no
 * `statusLine` setting to spawn a command from — the extension IS the native
 * equivalent, and better: in-process events mean no transcript re-reading, so
 * the bar updates the moment a call lands instead of on the next refresh.
 *
 * This module lives in the CLI's lib tree and is loaded by a stub
 * (`index.js`) that `fireconnect pi on` writes into
 * `~/.pi/agent/extensions/fireconnect-usage/`, with this file's absolute URL
 * baked in (same self-location pattern as the Claude status line helper). It
 * therefore imports the same canonical pricing engine (`computeClaudeUsageCost`)
 * and the same bar renderer as the Claude status line, so every surface quotes
 * identical figures.
 */

import { rowHasUsage, sumUsage, UNPRICED_TEXT } from "../../claude/usage/cost.mjs";
import { formatUsageCachePct, formatUsageCost } from "../../claude/usage/format.mjs";
import { computeClaudeUsageCost } from "../../claude/usage/pricing.mjs";
import { claudeStatusLineModelLabel } from "../../claude/statusline.mjs";
import { BAR_MARK, paintSeries, renderSpendBar } from "../../../usage/spend-bar.mjs";
import { claudeUsageFieldsFromPi, piUsageCallFromEntry, servedModelOf } from "../usage/report.mjs";

/** Footer status key: the line Pi renders under its own footer. */
const STATUS_KEY = "fireconnect";

/** Bar width in cells — the Claude status line's width, same visual language. */
const BAR_WIDTH = 16;

// Raw ANSI, mirroring the Claude status line's palette rules: color is
// identity only (bar slices and swatches); every word and number stays in the
// terminal's own color. NO_COLOR collapses to plain glyphs.
const COLORLESS = process.env.NO_COLOR ? true : false;
const BOLD = COLORLESS ? "" : "\x1b[1m";
const RESET = COLORLESS ? "" : "\x1b[0m";
const SEPARATOR = COLORLESS ? "·" : "\x1b[2m\x1b[39m·\x1b[0m";

function joinParts(parts) {
  return parts.filter(Boolean).join(` ${SEPARATOR} `);
}

/** One priced row for a finished assistant message, or null. */
export function rowFromAssistantMessage(message) {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return null;
  }
  const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
  if (!usage) {
    return null;
  }
  const row = computeClaudeUsageCost(
    servedModelOf(message, {}),
    claudeUsageFieldsFromPi(usage),
  );
  return rowHasUsage(row) ? row : null;
}

/** Priced rows for a session's stored entries (resume/reload seed). */
export function rowsFromSessionEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    const call = piUsageCallFromEntry(entry);
    if (!call) {
      continue;
    }
    const row = computeClaudeUsageCost(call.model, claudeUsageFieldsFromPi(call.usage));
    if (rowHasUsage(row)) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The status-line model legend: label + cost per model, largest spend first.
 * Null costs (no published rate) sort by calls and keep the total honest.
 * Carries each model's token totals too — the /usage table reuses them.
 */
export function legendModels(rows) {
  const byModel = new Map();
  for (const row of rows) {
    const entry = byModel.get(row.model)
      ?? {
        model: row.model,
        calls: 0,
        cost: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      };
    entry.calls += 1;
    entry.cost = row.cost == null ? null : entry.cost + row.cost;
    entry.input += row.input;
    entry.cacheRead += row.cacheRead;
    entry.cacheWrite += row.cacheWrite5m + row.cacheWrite1h;
    entry.output += row.output;
    byModel.set(row.model, entry);
  }
  const models = [...byModel.values()];
  const totalCost = models.reduce((sum, m) => sum + (m.cost ?? 0), 0);
  const hasUnpriced = models.some((entry) => entry.cost == null);
  return models
    .sort((a, b) => (hasUnpriced
      ? b.calls - a.calls
      : (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls))
    .map((entry) => ({
      ...entry,
      label: claudeStatusLineModelLabel(entry.model),
      costShare: hasUnpriced
        ? entry.calls / Math.max(1, rows.length)
        : (entry.cost ?? 0) / Math.max(1e-12, totalCost),
    }));
}

/**
 * The one-line footer status: spend bar · total · cache share · per-model legend.
 * @param {Array<object>} rows priced rows
 */
export function renderUsageStatus(rows) {
  if (rows.length === 0) {
    return "";
  }
  const totals = sumUsage(rows);
  const models = legendModels(rows);
  const bar = renderSpendBar(models, BAR_WIDTH);
  const total = totals.cost == null
    ? `cost ${UNPRICED_TEXT}`
    : `${BOLD}${formatUsageCost(totals.cost)}${RESET}`;
  const cachePct = formatUsageCachePct(totals);
  const cache = cachePct === "—" ? "" : `${cachePct} cache`;
  const legend = models.map((model, index) => (
    `${paintSeries(index, BAR_MARK)} ${model.label} ${formatUsageCost(model.cost)}`
  ));
  return joinParts([bar, total, cache, ...legend]);
}

/** Fixed-width cell padding for the /usage table. */
function cell(value, width, align = "left") {
  const text = String(value);
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function fmtInt(value) {
  return value.toLocaleString("en-US");
}

/**
 * Plain (unstyled) table lines for the /usage overlay: one row per model
 * plus the session total — the same figures the meter and `pi usage` print.
 * @param {Array<object>} rows priced rows
 */
export function usageTableLines(rows) {
  const totals = sumUsage(rows);
  const models = legendModels(rows);
  const widths = { model: 24, calls: 7, input: 12, cached: 14, write: 10, out: 12, cost: 11 };
  const header = [
    cell("model", widths.model),
    cell("calls", widths.calls, "right"),
    cell("in", widths.input, "right"),
    cell("cached", widths.cached, "right"),
    cell("write", widths.write, "right"),
    cell("out", widths.out, "right"),
    cell("cost", widths.cost, "right"),
  ].join("  ");
  const lines = [header, "-".repeat(header.length)];
  for (const model of models) {
    lines.push([
      cell(model.label, widths.model),
      cell(model.calls, widths.calls, "right"),
      cell(fmtInt(model.input), widths.input, "right"),
      cell(fmtInt(model.cacheRead), widths.cached, "right"),
      cell(fmtInt(model.cacheWrite), widths.write, "right"),
      cell(fmtInt(model.output), widths.out, "right"),
      cell(model.cost == null ? UNPRICED_TEXT : formatUsageCost(model.cost), widths.cost, "right"),
    ].join("  "));
  }
  const cachePct = formatUsageCachePct(totals);
  lines.push("-".repeat(header.length));
  lines.push([
    cell("TOTAL", widths.model),
    cell(rows.length, widths.calls, "right"),
    cell(fmtInt(totals.input), widths.input, "right"),
    cell(fmtInt(totals.cacheRead), widths.cached, "right"),
    cell(fmtInt(totals.cacheWrite5m + totals.cacheWrite1h), widths.write, "right"),
    cell(fmtInt(totals.output), widths.out, "right"),
    cell(totals.cost == null ? UNPRICED_TEXT : formatUsageCost(totals.cost), widths.cost, "right"),
    ...(cachePct === "—" ? [] : [`  ${cachePct} cache`]),
  ].join("  "));
  return lines;
}

/**
 * The FireConnect Pi usage-bar extension factory.
 *
 * @param {import("../../../harness/types.mjs").PiExtensionAPI} pi
 */
export default function fireconnectPiUsageExtension(pi) {
  /** @type {Array<object>} priced rows for this session, insertion order */
  let rows = [];

  const render = (ctx) => {
    if (!ctx?.ui || typeof ctx.ui.setStatus !== "function") {
      return;
    }
    try {
      ctx.ui.setStatus(STATUS_KEY, renderUsageStatus(rows) || undefined);
    } catch {
      /* a footer that cannot render must never break the session */
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Seed from the stored entries so a resumed session shows its full cost
    // immediately (entries on abandoned branches were billed too).
    try {
      rows = rowsFromSessionEntries(ctx?.sessionManager?.getEntries?.() ?? []);
    } catch {
      rows = [];
    }
    render(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const row = rowFromAssistantMessage(event?.message);
    if (row) {
      rows.push(row);
    }
    render(ctx);
  });

  // No session_shutdown reset is needed: session_start fires for every start
  // reason (startup, resume, new, fork, reload) and re-seeds `rows` from the
  // stored entries, so the tally never leaks across sessions.

  pi.registerCommand("usage", {
    description: "FireConnect: session usage at Fireworks rates (per-model table)",
    handler: async (_args, ctx) => {
      if (!ctx?.ui || ctx.mode !== "tui") {
        return;
      }
      if (rows.length === 0) {
        ctx.ui.notify("No billed calls yet this session.", "info");
        return;
      }
      await ctx.ui.custom((_tui, theme, _keybindings, done) => {
        const header = "  FireConnect usage — this session  ";
        const snapshot = usageTableLines(rows);
        const component = {
          render(width) {
            const lines = [theme.fg("accent", header), ""];
            for (const line of snapshot) {
              lines.push(theme.fg("dim", line.slice(0, Math.max(0, width))));
            }
            lines.push("");
            lines.push(theme.fg("dim", "  press any key to close"));
            return lines;
          },
          handleInput() {
            done(undefined);
          },
          invalidate() {
            /* stateless render — nothing cached to drop */
          },
        };
        return component;
      }, { overlay: true });
    },
  });
}
