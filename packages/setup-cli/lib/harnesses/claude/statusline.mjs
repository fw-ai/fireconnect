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
  specShortIdFromModelRef,
} from "../../fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../fireworks/pricing.mjs";
import { providerListPricing } from "../../demo/list-pricing.mjs";
import { isAnthropicModelId, isAutoModelId, isClaudeNativeModel } from "../../fireworks/model-id.mjs";
import { autoDisplayName } from "../../fireworks/models.mjs";
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Raw escapes, not lib/ui/style.mjs: that module disables color when stdout is
// not a TTY, and a status line's stdout is always a captured pipe. Claude Code
// renders ANSI from status line output, so color is correct here — NO_COLOR
// still wins for anyone who sets it. Codes match the live cost meter
// (lib/ui/palette.mjs METER) so the line reads like `claude usage`.
//
// Every sequence MUST carry its `m` terminator. Without it the next character
// terminates the CSI instead: `\x1b[38;5;141` + "GLM" parses as `\x1b[38;5;141G`
// (CHA, cursor-move) and eats the "G", while `\x1b[38;5;141` + "█" is an invalid
// sequence whose parameters leak to the screen as literal `38;5;141` text.
// Text tokens. Values, labels and legends wear these — never a series color.
//
// Both are relative to the terminal's own foreground rather than fixed values:
// `primary` is the default foreground (\x1b[39m) and `secondary` is that same
// foreground faint (\x1b[2m). A status line has no say over the surface it
// lands on — a hardcoded light grey is legible on a dark theme and washes out
// on a light one — so de-emphasis has to be expressed as a modifier, not a
// colour. (The series hues below are different: they are marks, not text, and
// they are validated for contrast.)
const COLOR = process.env.NO_COLOR ? null : {
  bold: "\x1b[1m",
  primary: "\x1b[39m",
  secondary: "\x1b[2m\x1b[39m",
  reset: "\x1b[0m",
};

// Categorical series hues, assigned in fixed order by share rank and never
// cycled. These are the validated dark-mode steps: every check passes against
// the dark surface (lightness band, chroma floor, CVD separation, normal-vision
// floor, 3:1 contrast), with worst adjacent CVD ΔE 8.4 across all eight.
//
// Truecolor rather than 256-color so the rendered value is the validated one.
// They carry identity ONLY — as bar segments and legend swatches. Text beside
// them stays in the tokens above, which is what keeps the line calm.
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
 * One multi-color stacked bar showing each backend model's share of the
 * session's SPEND, encoded purely as segment width.
 *
 * Cost, not call count: the line exists to answer "where is the money going",
 * and those two answers diverge hard on a router — a model can take 47% of the
 * calls and 89% of the bill. Drawing calls put the less important dimension in
 * the most prominent position, and left the bar disagreeing with the legend
 * beneath it, which states cost.
 *
 * Deliberately textless. The legend already carries a percentage per model
 * (cache hit), and printing a share inside the segments put two unrelated kinds
 * of `%` side by side — the reader had to work out which was which. Width
 * answers "how much of the spend" at a glance, and the legend lists the models
 * in the same order with the exact dollars.
 *
 * @param {Array<{ label: string, costShare: number }>} models largest first
 * @param {number} width total bar width in cells
 * @returns {string}
 */
function renderModelBar(models, width) {
  if (models.length === 0) {
    return "";
  }
  // One blank cell between segments — the terminal's version of the surface gap
  // a stacked chart puts between fills. It separates neighbours without relying
  // on hue alone, which matters for colorblind readers and for the two segments
  // whose adjacent CVD separation is closest to the floor.
  const gaps = models.length - 1;
  const inkWidth = Math.max(models.length, width - gaps);
  // Min one cell: a model that cost a rounding error still ran, and a segment
  // that vanishes reads as "this model was not used".
  const widths = models.map((m) => Math.max(1, Math.round(m.costShare * inkWidth)));
  // Rounding drift: hand the remainder to the largest segment so the bar always
  // occupies exactly the width it was given.
  const drift = inkWidth - widths.reduce((sum, w) => sum + w, 0);
  if (drift !== 0) {
    widths[0] = Math.max(1, widths[0] + drift);
  }
  return models
    // A thin rule, not a filled block: the bar is chrome, and a slab of
    // saturated color out-shouts the numbers it exists to introduce.
    .map((model, index) => paintSeries(index, BAR_MARK.repeat(widths[index])))
    .join(" ");
}

function stripViaFireworks(label) {
  return String(label).replace(/ via Fireworks$/i, "");
}

/**
 * Tighten a model label for the bar and legend.
 *
 * Catalog labels carry qualifiers that earn their place in a picker but not in a
 * status line: `DeepSeek V4 Flash (0731)` and `GLM 5.2 Fast (Latest)` cost ~9
 * columns apiece to say something the line does not turn on. With three models
 * plus the metrics, that overflow is what gets truncated away. The base name is
 * enough to tell the segments apart.
 *
 * @param {string} label
 * @returns {string}
 */
function compactModelLabel(label) {
  return String(label).replace(/\s*\([^)]*\)\s*$/, "").trim() || String(label);
}

/**
 * Human label for the routed model.
 *
 * Mirrors `fireworksModelPickerName` (core.mjs) rather than importing it: the
 * status line runs on every assistant message, so it stays off core.mjs's
 * dependency graph. Live catalog label first, then static spec, then pricing
 * table, then the bare slug.
 *
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
    return stripViaFireworks(live);
  }
  const spec = lookupModelSpec(id);
  if (spec?.label) {
    return stripViaFireworks(appendLatestRouterSuffix(id, spec.label));
  }
  const pricing = lookupFireworksPricing(id);
  if (pricing?.label) {
    return stripViaFireworks(appendLatestRouterSuffix(id, pricing.label));
  }
  // A native Anthropic model (a slot left on Claude's own default): label it
  // from the list-price table rather than printing the bare slug.
  if (isAnthropicModelId(id)) {
    const anthropic = providerListPricing({ provider: "anthropic", modelId: id });
    if (anthropic?.label && !anthropic.estimated) {
      return anthropic.label;
    }
  }
  // An id we have no metadata for — the bare slug, minus the Claude Code-only
  // [1m] tag.
  return specShortIdFromModelRef(id) || id;
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Fireworks-accurate usage for the session, including its subagents.
 *
 * Returns null when there is nothing to report yet (no transcript on a fresh
 * session) so the caller can omit those fields instead of claiming $0.00.
 *
 * `lastModel` is the real backend model the gateway selected for the most
 * recent parent call — the transcript records it per assistant turn, so a
 * FireRouter session surfaces the model that actually served the last turn
 * (e.g. `accounts/fireworks/models/glm-5p2` or `claude-opus-5`), not the
 * `firerouter` alias the slot is pinned to.
 *
 * `models` is the per-backend breakdown of every billed call in the session,
 * subagents included — each entry `{ label, share, calls, cost }`, largest share
 * first — so the status line can draw one multi-color bar and attribute spend
 * per model instead of naming only the latest one. That split is the point: a
 * router sending 40% of calls to a frontier model can put 95% of the bill there,
 * which a single total hides. FireRouter routes per call and a `/model` switch
 * changes the slot mid-session, so a session can span several backends.
 *
 * In a fully priced session the per-model costs reconcile with `cost`. If any
 * call is unpriced the headline is `cost n/a`; known per-model costs remain in
 * the legend, and the bar switches from spend share to call share.
 *
 * @param {string} transcriptPath
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ cost: number, estimated: boolean, lastModel: string, models: Array<{ label: string, share: number, calls: number, cost: number }>, cachePct: string } | null>}
 */
export async function claudeStatusLineUsage(transcriptPath, { home = process.env.HOME ?? "" } = {}) {
  const target = String(transcriptPath ?? "").trim();
  // Guard before calling readClaudeUsage: given a path that does not exist it
  // falls back to scanning every .jsonl under ~/.claude, which is far too much
  // work for a status line (and would price the wrong session).
  if (!target || !path.isAbsolute(target) || !await isFile(target)) {
    return null;
  }
  // Imported here, not at module scope: core.mjs pulls this module in on every
  // `claude on` for the settings helpers alone, and the cost engine's dependency
  // graph (pricing tables, catalog cache) is only needed when a status line is
  // actually being rendered.
  const { readClaudeUsage } = await import("./usage/report.mjs");
  const report = await readClaudeUsage({ home, session: target });
  // `lastModel` tracks the MAIN thread only: it answers "what is serving me
  // right now", which a subagent's model does not.
  const lastModel = report.rows.at(-1)?.model ?? "";
  // The breakdown, however, must cover every billed call — subagents included.
  // `grandTotals.cost` (the headline) sums parent + subagents, so tallying only
  // parent rows would leave the legend short of the total and silently orphan
  // the subagents' spend.
  const allRows = [
    ...report.rows,
    ...(report.subagents ?? []).flatMap((subagent) => subagent.rows),
  ];
  // Claude Code creates the transcript before the first API call — it opens with
  // user and metadata lines. Existing-but-callless is still "nothing to price",
  // so return null rather than a zero-cost report the caller would render as
  // `$0.00` and pass off as a free session.
  if (allRows.length === 0) {
    return null;
  }
  // Tally per backend, distinct by normalized short id so
  // `accounts/fireworks/models/glm-5p2` and a bare `glm-5p2` are one model.
  // The token buckets mirror the live meter's per-model Tally (meter-model.mjs):
  // uncached input, cache reads, and both Anthropic cache-write TTLs summed —
  // so the cache figure here is computed from the same inputs by the same
  // helpers the meter's `cache%` column uses.
  /** @type {Map<string, { calls: number, cost: number | null, input: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number }>} */
  const byModel = new Map();
  for (const row of allRows) {
    const sid = specShortIdFromModelRef(row.model);
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
    // Spend share is undefined if even one model is unpriced. In that case every
    // segment uses the same call-share denominator instead of combining priced
    // spend share with unpriced call share (fractions that can sum above 100%).
    .sort((a, b) => (
      hasUnpriced
        ? b[1].calls - a[1].calls
        : (b[1].cost ?? 0) - (a[1].cost ?? 0) || b[1].calls - a[1].calls
    ))
    .map(([sid, entry]) => ({
      label: claudeStatusLineModelLabel(sid),
      // A fully-priced nonzero session draws spend share. A free or partly
      // unpriced session draws call share for every segment.
      costShare: !hasUnpriced && totalCost > 0
        ? entry.cost / totalCost
        : entry.calls / totalCalls,
      share: entry.calls / totalCalls,
      calls: entry.calls,
      cost: entry.cost,
      // Same function the session figure uses, and the same ratio+rounding the
      // meter applies per row — a 99.85%-cached model must not read "100%".
      cachePct: formatUsageCachePct(entry),
    }));
  return {
    cost: report.grandTotals.cost,
    estimated: report.estimated,
    lastModel,
    models,
    // `formatUsageCachePct` returns "—" before the first prompt has any cached
    // tokens; the caller drops the field in that case.
    cachePct: formatUsageCachePct(report.grandTotals),
  };
}

// Bar width in cells. Fixed rather than COLUMNS-adaptive so the line layout is
// predictable and the cost always fits beside it on line 1. Kept modest so the
// legend + metrics on line 2 stay within a typical status-line width.
const MODEL_BAR_WIDTH = 16;

/**
 * Build the status line text from Claude Code's stdin payload.
 *
 * Two lines:
 *   <textless spend-share bar> · <session total>
 *   <swatch> <model> <its cost> <its cache>% cache   (repeated per backend)
 *
 * Every number carries its unit: `$` for money, an explicit `% cache` for hit
 * rate. Spend share is the one figure left unlabeled, so it is shown only as bar
 * width — a bare percentage next to a bare percentage meaning something else is
 * what made an earlier version unreadable, and the exact dollars sit in the
 * legend directly beneath. Before the first call lands there is no transcript to
 * break down, so line 1 falls back to the slot alias and the bar is omitted.
 * Never more than two lines.
 *
 * @param {{
 *   model?: { id?: string, display_name?: string },
 *   transcript_path?: string,
 * }} input
 * @param {{ home?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function renderClaudeStatusLine(input = {}, { home = process.env.HOME ?? "" } = {}) {
  const slotModelId = input.model?.id ?? "";
  // The `claude-default` sentinel is FireConnect's own marker for an unpinned
  // native slot; Claude Code never sends it as a model id, so prefer whatever
  // display name it did send. Everything else — Fireworks routers, real
  // Anthropic ids, unknown ids — resolves through the label helper.
  const slotLabel = isClaudeNativeModel(slotModelId)
    ? (input.model?.display_name || "Claude default")
    : claudeStatusLineModelLabel(slotModelId);

  let usage = null;
  try {
    usage = await claudeStatusLineUsage(input.transcript_path ?? "", { home });
  } catch {
    // An unreadable or half-written transcript must not blank the status line.
    usage = null;
  }

  const multi = (usage?.models.length ?? 0) > 1;

  // Line 1: the model bar (or the slot alias before any call lands) + cost.
  const bar = usage?.models.length
    ? renderModelBar(usage.models, MODEL_BAR_WIDTH)
    : "";
  // No context-window figure here on purpose. Every other number on this line is
  // one only FireConnect can give you — the real backend model, cost at
  // Fireworks rates, per-model cache. Context usage is a value Claude Code
  // hands us and already surfaces itself (`/context`, auto-compact warnings), so
  // echoing it spent columns to repeat someone else's number and blurred what
  // the line is for.
  const line1 = joinParts([
    bar || paint("secondary", slotLabel),
    // The session total is the headline number: primary ink, bold. Colour is
    // spent on identity (which model), never on emphasis.
    //
    // A null total means some call in the session has no rate we can look up, so
    // there is no honest number to print: it reads `cost n/a` rather than a
    // figure that would silently exclude those calls. The `~` estimate marker
    // has nothing to qualify in that case.
    usage && (usage.cost == null
      ? paint("secondary", `cost ${UNPRICED_TEXT}`)
      : `${usage.estimated ? "~" : ""}${COLOR ? COLOR.bold : ""}${paint("primary", formatUsageCost(usage.cost))}`),
  ]);

  // Line 2: one entry per backend — `<swatch> <model> <its cost> <its cache>`.
  // Every figure is labeled, including a repeated `cache` on each entry: the
  // repetition costs columns but leaves nothing to infer. Per-model spend is the
  // fact a single total hides (47% of calls can be 89% of the bill).
  //
  // Only the swatch is coloured. Painting the whole entry in its series hue —
  // name, cost AND cache — turned the line into three bands of saturated text
  // competing with each other; identity belongs on a mark, and the numbers read
  // far better in one consistent ink.
  const legend = usage?.models.map((m, index) => {
    // A single-model session needs no per-model cost: it equals the total
    // already shown on line 1.
    const label = compactModelLabel(m.label);
    const cache = m.cachePct && m.cachePct !== "—" ? ` ${m.cachePct} cache` : "";
    const text = multi
      ? `${label} ${formatUsageCost(m.cost)}${cache}`
      : `${label}${cache}`;
    return `${paintSeries(index, BAR_MARK)} ${paint("primary", text)}`;
  }) ?? [];
  const line2 = joinParts(legend);

  return [line1, line2].filter(Boolean).join("\n");
}
