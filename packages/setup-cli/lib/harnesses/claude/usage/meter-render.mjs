/**
 * The meter's row renderers: state in, lines of text out.
 *
 * Split from the Dashboard so that "what the session has spent" and "what the
 * screen looks like" are separate concerns — the Dashboard accumulates, these
 * functions only read. Every one is a pure function of its arguments, so a frame
 * can be rendered in a test without constructing a Dashboard or a stream.
 *
 * Each returns either one line or an array of lines, already clipped to the pane
 * width. Colour comes from `meter-style` live bindings, so `applyMeterStyle` must
 * have run first.
 */

import { sanitize } from "../../../ui/sanitize.mjs";
import {
  BAR_MAX,
  COST_COL,
  FOOTER_LABEL_INDENT,
  LABEL_BLOCK,
  MODEL_COL,
  money,
  moneyTotal,
  SHARE_COL,
  TOKEN_COLUMNS_WIDTH,
  tokenCells,
} from "./meter-layout.mjs";
import { badgeName } from "./meter-model.mjs";
import {
  ACCENT,
  B,
  clip,
  clipAnsi,
  D,
  GHOST,
  GOLD,
  GREEN,
  H,
  R,
  RED,
  SPIN,
  vislen,
} from "./meter-style.mjs";
import { formatUsageCachePct } from "./format.mjs";

/** Most agent rows to show in the pane before collapsing the rest into a count. */
const AGENT_PANE_ROWS = 6;

/**
 * Whether an agent list is worth a pane.
 *
 * Every session lists Main, so a bare length check would give a solo session a
 * four-row pane whose entire content is the agent already being metered. The
 * pane earns its space only once there is somewhere else to go.
 *
 * @param {any[]} list
 */
export function agentPaneWorthShowing(list) {
  return Array.isArray(list) && list.some((a) => a?.kind === "subagent");
}

/**
 * Coloured model badges for a turn, plus their printable width.
 *
 * The badge column is 8 chars. A single model fits; a turn the router split
 * across two usually doesn't ("GLM5.2+Opus5" is 12), so the multi-model case
 * degrades to per-model initials rather than shoving the numeric columns right.
 * Two models in one turn is itself the signal worth seeing — the exact versions
 * are in the footer.
 *
 * @param {{ models: string[] }} turn
 * @param {(key: string) => string} colorOf bucket key -> SGR prefix
 * @returns {[string, number]} rendered badges and their printable width
 */
export function renderBadges(turn, colorOf) {
  if (!turn.models.length) return [`${GHOST}··${R}`, 2];
  let short = turn.models.map(badgeName);
  if (short.join("+").length > MODEL_COL) {
    short = turn.models.map((m) => badgeName(m)
      .slice(0, Math.max(1, Math.floor(MODEL_COL / turn.models.length) - 1)));
  }
  let raw = short.join("+");
  // Even 1-char initials overflow past ~5 models ("a+b+c+d+e+f" is 11), and the
  // turn row pads with `MODEL_COL - blen`, which floors at 0 and would shove
  // every numeric column left of its heading. Keep the field 8 wide: show as
  // many models as fit and mark the rest with "+".
  if (raw.length > MODEL_COL) {
    const fit = [];
    for (const [i, s] of short.entries()) {
      const next = fit.length ? `${fit.join("+")}+${s}` : s;
      // Reserve the last column for the "+" overflow marker.
      if (next.length > MODEL_COL - 1) break;
      fit.push(s);
      if (i === short.length - 1) break;
    }
    short = short.slice(0, fit.length || 1);
    raw = `${short.join("+")}+`;
    const parts = short.map((s, i) => `${colorOf(turn.models[i])}${s}${R}`);
    return [`${parts.join("+")}${GHOST}+${R}`, raw.length];
  }
  const parts = turn.models.map((m, i) => `${colorOf(m)}${short[i]}${R}`);
  return [parts.join("+"), raw.length];
}

/**
 * One turn row: status, number, model badges, token columns, cost, prompt.
 *
 * @param {object} turn
 * @param {{ width: number, tick: number, colorOf: (key: string) => string }} ctx
 */
export function renderTurnRow(turn, { width, tick, colorOf }) {
  const glyph = turn.finished ? `${GREEN}✓${R}` : `${ACCENT}${SPIN[tick % SPIN.length]}${R}`;
  const [badges, blen] = renderBadges(turn, colorOf);
  const t = turn.tally;
  const star = turn.hasUnpriced ? `${RED}*${R}` : " ";
  const pad = " ".repeat(Math.max(0, MODEL_COL - blen));
  const prefix = `  ${glyph} ${D}${String(turn.no).padStart(2)}${R} `
    + `${badges}${pad}${D}${tokenCells(t)}${R} ${GOLD}${money(t.cost)}${R}${star} `;
  // In a pane too narrow even for the fixed columns, drop the prompt text and
  // clip the prefix itself. Padding the line back out would push it past the
  // pane and wrap it — worse than showing a truncated row.
  const avail = width - vislen(prefix) - 1;
  if (avail < 1) return clipAnsi(prefix, width);
  const text = turn.prompt.length <= avail ? turn.prompt : `${turn.prompt.slice(0, avail - 1)}…`;
  return prefix + (turn.finished ? R : GHOST) + text + R;
}

/**
 * Live agents pane: every agent in the session with its own cursor.
 *
 * The rows update in place on the peers cadence, so a subagent spawning while
 * you watch Main is visible immediately — a modal list only shows you that once
 * you think to open it, which is exactly when you would not think to.
 *
 * Renders nothing without a subagent to switch to: a solo session would
 * otherwise spend four rows saying so.
 *
 * @param {{ list: any[], index: number, focused: boolean, trackingId: string } | null} pane
 * @param {number} width
 */
export function renderAgentPane(pane, width) {
  if (!pane || !agentPaneWorthShowing(pane.list)) return [];
  const { list } = pane;
  const focused = Boolean(pane.focused);
  const cursor = Math.min(Math.max(0, pane.index | 0), list.length - 1);

  // Window the rows around the cursor so a session with 30 subagents cannot push
  // the turn table off screen, and the selected row is always visible.
  const shown = Math.min(AGENT_PANE_ROWS, list.length);
  const start = Math.max(0, Math.min(cursor - Math.floor(shown / 2), list.length - shown));
  const slice = list.slice(start, start + shown);

  // No leading rule: `draw` already puts one between the turn table and
  // everything below it, and a second would draw two adjacent lines.
  const lines = [focused
    ? `  ${ACCENT}agents${R} ${GHOST}· ↑/↓ pick · Enter track · Tab back to turns${R}`
    : `  ${GHOST}agents · Tab to focus${R}`];

  for (const [i, agent] of slice.entries()) {
    const on = focused && start + i === cursor;
    const tracked = pane.trackingId && agent.id === pane.trackingId;
    const totals = agent.report?.totals ?? {};
    // An agent row is a total, not a single call.
    const cost = moneyTotal(totals.cost ?? 0);
    const calls = String(agent.report?.requests ?? 0).padStart(3);
    const cache = formatUsageCachePct(totals).padStart(4);
    // The tracked agent gets the gold dot; the cursor gets the pointer. They
    // answer different questions ("what am I metering" vs "what would Enter
    // pick"), and both spend a fixed column so rows stay aligned.
    const dot = tracked ? `${GOLD}•${R}` : " ";
    const point = on ? `${ACCENT}❯${R}` : " ";
    const label = sanitize(String(agent.label ?? "")).replace(/\s+/g, " ").trim();
    const head = `  ${point}${dot} ${GOLD}${cost}${R} ${GHOST}${cache} cache · ${calls} calls${R}  `;
    const room = Math.max(0, width - vislen(head) - 1);
    lines.push(head + (agent.kind === "main" ? B : "") + clip(label, room) + R);
  }

  const hidden = list.length - slice.length;
  if (hidden > 0) {
    lines.push(`${D}     ⋮ ${hidden} more agent${hidden === 1 ? "" : "s"}${R}`);
  }
  return lines.map((l) => (vislen(l) > width ? clipAnsi(l, width) : l));
}

/**
 * Per-model breakdown plus the spend-attribution summary rows.
 *
 * @param {{
 *   totals: Map<string, any>,
 *   unpriced: Set<string>,
 *   peers: { count: number, calls: number, cost: number, main?: any } | null,
 *   agentLabel: string,
 *   colorOf: (key: string) => string,
 *   width: number,
 * }} ctx
 */
export function renderFooter({ totals, unpriced, peers, agentLabel, colorOf, width }) {
  let grand = 0;
  for (const t of totals.values()) grand += t.cost;

  // The share bar is the one elastic column, so it absorbs a narrow pane and
  // drops out entirely rather than forcing every line to wrap. The launcher gives
  // the meter 40% of the window — 48-64 cols on a laptop — so this is the common
  // case, not an edge case. Its floor is everything on a model row except the bar
  // itself, derived so a column change cannot leave it stale.
  const fixedRow = LABEL_BLOCK + TOKEN_COLUMNS_WIDTH + 1 + SHARE_COL + 1 + COST_COL;
  const barw = Math.max(0, Math.min(BAR_MAX, width - fixedRow - 2));

  const lines = [];
  for (const [key, t] of totals) {
    const c = colorOf(key);
    const fill = grand ? Math.floor((t.cost / grand) * barw) : 0;
    const bar = barw ? `${c}${"█".repeat(fill)}${R}${D}${"░".repeat(barw - fill)}${R} ` : "";
    const share = `${grand ? ((t.cost / grand) * 100).toFixed(0) : "0"}%`.padStart(SHARE_COL);
    // Label padded to LABEL_BLOCK minus its `  ● ` prefix, so the numbers land
    // under the same headings as a turn row's.
    const label = key.slice(0, MODEL_COL).padEnd(LABEL_BLOCK - FOOTER_LABEL_INDENT);
    lines.push(
      `  ${c}●${R} ${label}${D}${tokenCells(t)}${R} `
      + `${bar}${GHOST}${share}${R} ${GOLD}${moneyTotal(t.cost)}${R}`,
    );
  }
  if (!lines.length) lines.push(`  ${GHOST}no priced turns yet${R}`);

  // Summary rows carry no numeric columns, so right-align their cost against
  // where a model row's cost cell ends. Padding the label instead would drift,
  // because `moneyTotal` is variable width ("$0.87" vs "$20.37"). Measured off a
  // rendered row rather than re-summing the terms, which is one place for the
  // arithmetic to go wrong instead of two.
  const modelRowEnd = totals.size ? vislen(lines[0]) : fixedRow + (barw ? barw + 1 : 0);
  const summary = (label, value, { bold: strong = false, ghost = false } = {}) => {
    const cost = moneyTotal(value);
    const room = Math.max(1, modelRowEnd - 2 - cost.length);
    const text = clip(label, room);
    const style = strong ? B : (ghost ? GHOST : "");
    return `  ${style}${text}${R}${" ".repeat(room - text.length)}${GOLD}${strong ? B : ""}${cost}${R}`;
  };

  // Spend attribution: the meter tails ONE agent log, so a session whose work
  // happened inside subagents shows a small total with no hint of where the money
  // went. Name the tracked agent, break the rest out by kind, and let them
  // reconcile to a session figure without switching panes.
  //
  // Main is its own row: while tracking a subagent it is usually the largest
  // spend in the session, and folding it into "N subagents" both inflates that
  // count and files Main's cost under the wrong kind of agent.
  const peerMain = peers?.main;
  const subCount = peers?.count ?? 0;
  if (peers && (subCount > 0 || peerMain)) {
    const callWord = (n) => (n === 1 ? "call" : "calls");
    lines.push(summary(agentLabel || "Main", grand));
    if (peerMain) {
      lines.push(summary(
        `${peerMain.label} · ${peerMain.calls} ${callWord(peerMain.calls)}`,
        peerMain.cost,
        { ghost: true },
      ));
    }
    if (subCount > 0) {
      lines.push(summary(
        `${subCount} ${subCount === 1 ? "subagent" : "subagents"} · ${peers.calls} ${callWord(peers.calls)}`,
        peers.cost,
        { ghost: true },
      ));
    }
    lines.push(summary("SESSION COST", grand + peers.cost + (peerMain?.cost ?? 0), { bold: true }));
  } else {
    lines.push(summary("TOTAL COST", grand, { bold: true }));
  }

  if (unpriced.size) {
    lines.push(`  ${RED}*${R} ${GHOST}unpriced (excluded): ${[...unpriced].sort().join(", ")}${R}`);
  }
  // Even with the bar gone the fixed columns need ~59 cols, and the unpriced line
  // is unbounded, so clip rather than let anything wrap the frame.
  return lines.map((l) => (vislen(l) > width ? clipAnsi(l, width) : l));
}

/** Horizontal rule spanning the pane, used between the table and the footer. */
export const rule = (width) => `${D}  ${H.repeat(Math.max(0, width - 4))}${R}`;
