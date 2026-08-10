/**
 * Claude-Code-like agent picker for live usage.
 * Built on `runPrompt` (same framework as session picker / launcher menus)
 * with METER gold/ghost so the handoff from the live meter stays continuous.
 */

import path from "node:path";
import process from "node:process";

import { accent, bold, dim, paint, symbols } from "../../../ui.mjs";
import { colorsEnabled } from "../../../ui/color.mjs";
import { ANSI, METER } from "../../../ui/palette.mjs";
import { createKeyParser, KEY, runPrompt } from "../../../ui/prompt.mjs";
import { sanitize } from "../../../ui/sanitize.mjs";
import {
  formatUsageCachePct,
  listSessionAgents,
} from "./agents.mjs";
import { agentPaneWorthShowing } from "./meter.mjs";
import { formatLiveCostTotal } from "./format.mjs";

/** Returned when ←/Esc should resume the previous live meter without switching. */
export const CLAUDE_USAGE_AGENT_RESUME = Object.freeze({ resume: true });

/**
 * @param {{
 *   kind: string,
 *   id: string,
 *   label: string,
 *   name?: string,
 *   description?: string,
 *   report: { totals?: { cost?: number, input?: number, cacheRead?: number, cacheWrite5m?: number, cacheWrite1h?: number }, requests?: number, sessionName?: string },
 * }} agent
 * @param {{
 *   stream?: NodeJS.WritableStream,
 *   color?: boolean,
 *   active?: boolean,
 * }} [opts]
 */
export function formatClaudeUsageAgentChoice(agent, opts = {}) {
  const stream = opts.stream ?? process.stdout;
  // Probe the RESOLVED stream: checking `opts.stream` meant an explicit
  // `stream: null` fell back to process.stdout for writing but was treated as
  // "no stream" for colour, so a colour-capable terminal rendered plain.
  const useColor = opts.color === true
    || (opts.color !== false && colorsEnabled(stream));
  const active = opts.active !== false;

  const totals = agent.report?.totals ?? {};
  // An agent's spend is a total, so 2 decimals.
  const costText = formatLiveCostTotal(totals.cost ?? 0).padStart(8);
  const cacheText = formatUsageCachePct(totals).padStart(4);
  const callsText = String(agent.report?.requests ?? 0).padStart(3);

  let extra = "";
  if (agent.kind === "main" && typeof agent.report?.sessionName === "string") {
    const name = sanitize(agent.report.sessionName).replace(/\s+/g, " ").trim();
    if (name) {
      extra = ` · ${name.length > 28 ? `${name.slice(0, 27)}…` : name}`;
    }
  } else if (agent.kind === "subagent") {
    const desc = typeof agent.description === "string"
      ? sanitize(agent.description).replace(/\s+/g, " ").trim()
      : "";
    const labelHasDesc = Boolean(desc) && String(agent.label ?? "").includes(desc.slice(0, 12));
    if (desc && !labelHasDesc) {
      extra = ` · ${desc.length > 28 ? `${desc.slice(0, 27)}…` : desc}`;
    }
  }

  const labelText = String(agent.label ?? "") + extra;
  if (!useColor) {
    return `${costText} · ${cacheText} cache · ${callsText} calls · ${labelText}`;
  }

  const cost = paint(METER.gold, costText, stream);
  const meta = paint(METER.ghost, `${cacheText} cache · ${callsText} calls`, stream);
  const label = active
    ? (agent.kind === "main" ? bold(labelText) : labelText)
    : paint(METER.ghost, labelText, stream);
  return `${cost} · ${meta} · ${label}`;
}

/**
 * Interactive agent list. Returns the chosen agent, RESUME, or null to quit.
 *
 * Keys: ↑/↓ move · Enter track · Esc resume · q quit
 *
 * @param {{
 *   sessionPath: string,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   refreshMs?: number,
 *   initialId?: string,
 *   trackingId?: string,
 *   trackingLabel?: string,
 *   listAgents?: typeof listSessionAgents,
 * }} opts
 */
export async function promptClaudeUsageAgent({
  sessionPath,
  input = process.stdin,
  output = process.stdout,
  refreshMs = 1000,
  initialId = "",
  trackingId = "",
  trackingLabel = "",
  listAgents = listSessionAgents,
} = {}) {
  if (!sessionPath) {
    throw new Error("sessionPath is required");
  }

  let agents = await listAgents(sessionPath);
  if (agents.length === 0) {
    throw new Error(`No agents found for session ${sessionPath}`);
  }
  if (!input?.isTTY || !output?.isTTY) {
    return agents[0];
  }

  const sessionId = path.basename(sessionPath, ".jsonl").slice(0, 8);
  // Labels come from session logs, so sanitize before they reach the TTY (same
  // rule as the choice rows) and cap the length so the subhead can't wrap.
  const trackingText = (() => {
    const clean = sanitize(trackingLabel ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    return clean.length > 44 ? `${clean.slice(0, 43)}…` : clean;
  })();
  let index = 0;
  if (initialId) {
    const found = agents.findIndex((a) => a.id === initialId);
    if (found >= 0) index = found;
  } else {
    const firstSub = agents.findIndex((a) => a.kind === "subagent");
    if (firstSub >= 0) index = firstSub;
  }

  return runPrompt({
    input,
    output,
    refreshMs,
    onRefresh: async () => {
      const next = await listAgents(sessionPath);
      if (next.length === 0) return;
      const prevId = agents[index]?.id;
      agents = next;
      const found = agents.findIndex((a) => a.id === prevId);
      index = found >= 0 ? found : Math.min(index, agents.length - 1);
    },
    renderLines: () => [
      `${accent("?", output)} ${bold(`Claude Code · Agents · session ${sessionId}…`)}`,
      // Say which agent the meter is on rather than asserting "Main is live":
      // that was still claimed while tracking a subagent, so the list gave no
      // hint that Main was the row to pick to get back.
      paint(
        METER.ghost,
        trackingText
          ? `Tracking ${trackingText} — pick another agent to switch`
          : "Pick an agent to live-track",
        output,
      ),
      "",
      ...agents.map((agent, i) => {
        const active = i === index;
        const body = formatClaudeUsageAgentChoice(agent, {
          stream: output,
          color: true,
          active,
        });
        // Mark the agent currently being metered, so "where am I / where do I
        // go back to" is answerable from the list alone. Both branches spend the
        // same two columns (pointer/blank + mark) so the rows stay aligned.
        const live = trackingId && agent.id === trackingId;
        const mark = live ? paint(METER.gold, "•", output) : " ";
        return active
          ? `${accent(symbols.pointer, output)}${mark} ${body}`
          : ` ${mark} ${body}`;
      }),
      "",
      dim("↑/↓ move · Enter live-track · Esc resume · q quit"),
    ],
    onKey: (seq) => {
      if (seq === KEY.UP || seq === "k") {
        index = (index - 1 + agents.length) % agents.length;
        return undefined;
      }
      if (seq === KEY.DOWN || seq === "j") {
        index = (index + 1) % agents.length;
        return undefined;
      }
      // One key per action, matching the in-frame pane: Enter picks, Esc resumes.
      if (seq === KEY.ENTER_CR || seq === KEY.ENTER_LF) {
        return { done: true, value: agents[index] };
      }
      if (seq === KEY.ESC) {
        return { done: true, value: CLAUDE_USAGE_AGENT_RESUME };
      }
      if (seq === "q") {
        return { done: true, value: null };
      }
      if (seq.length === 1 && seq >= "1" && seq <= "9") {
        const n = Number(seq) - 1;
        if (n < agents.length) {
          index = n;
          return { done: true, value: agents[index] };
        }
      }
      return undefined;
    },
  });
}

/**
 * Watch stdin while the live meter runs.
 *
 * Key model: Esc goes BACK the way you came (the session list), and Tab focuses
 * the in-frame agents pane. Arrow keys belong to the pane's cursor and nothing
 * else — a key meaning "move" in one mode and "leave the session" in another is a
 * trap, so there is exactly one binding per action.
 *
 * When `pane` is supplied, ↑/↓/Enter drive it in place — no modal picker, so a
 * subagent spawning while you watch is visible and one keystroke away. Focused,
 * the pane also takes over Esc (which unfocuses rather than leaving the session),
 * because a cursor you can see must be what the keys act on.
 *
 * @param {{
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WritableStream,
 *   onAgents: () => void,
 *   onQuit?: () => void,
 *   onSessions?: () => void,
 *   pane?: { list: any[], index: number, focused: boolean } | null,
 *   onPick?: (agent: any) => void,
 *   onPaneChange?: () => void,
 * }} opts
 */
export function attachAgentBackKey({
  input = process.stdin,
  output = process.stdout,
  onAgents,
  onQuit,
  onSessions,
  pane = null,
  onPick,
  onPaneChange,
} = {}) {
  if (!input?.isTTY || typeof input.on !== "function" || typeof onAgents !== "function") {
    return () => {};
  }
  // Repaint immediately on a cursor move: the meter's own redraw is on the poll
  // timer, so without this a keypress looked ignored for up to pollMs.
  const paneChanged = () => {
    if (typeof onPaneChange === "function") onPaneChange();
  };
  // Same predicate the meter renders by: Tab must never focus a pane that is not
  // on screen, or the arrow keys would be swallowed by an invisible cursor.
  const paneLive = () => Boolean(pane && agentPaneWorthShowing(pane.list));
  const movePane = (delta) => {
    const n = pane.list.length;
    pane.index = ((pane.index | 0) + delta + n) % n;
    paneChanged();
  };
  const parser = createKeyParser();
  /** @type {ReturnType<typeof setImmediate> | null} */
  let escFlush = null;
  const wasRaw = input.isRaw;
  // `isPaused()` before we resume: a flowing stdin belongs to whoever started
  // it, so detach must not pause a stream it did not start.
  const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : true;
  input.setRawMode?.(true);
  input.resume?.();
  input.setEncoding?.("utf8");

  const restoreTerminal = () => {
    if (output && typeof output.write === "function") {
      // Leave the alternate screen too: this handler calls process.exit, so the
      // meter's own teardown never runs. Without it Ctrl+C dropped back to the
      // shell with the last frame still painted over it.
      output.write(`${ANSI.showCursor}${ANSI.exitAltScreen}`);
    }
    input.setRawMode?.(false);
  };

  const onData = (chunk) => {
    if (escFlush) {
      clearImmediate(escFlush);
      escFlush = null;
    }
    for (const seq of parser.push(chunk)) {
      // Ctrl+C first: it must win over every mode, including a focused pane.
      if (seq === KEY.CTRL_C) {
        restoreTerminal();
        process.exit(130);
      }
      if (seq === "q") {
        // Footer advertises quit — never treat q as navigation.
        if (typeof onQuit === "function") onQuit();
        return;
      }
      // Tab toggles focus between the turn table and the agents pane.
      if (seq === "\t" && paneLive()) {
        pane.focused = !pane.focused;
        paneChanged();
        return;
      }
      if (pane?.focused && paneLive()) {
        if (seq === KEY.UP || seq === "k") { movePane(-1); return; }
        if (seq === KEY.DOWN || seq === "j") { movePane(1); return; }
        if (seq === KEY.ENTER_CR || seq === KEY.ENTER_LF) {
          const agent = pane.list[Math.min(Math.max(0, pane.index | 0), pane.list.length - 1)];
          pane.focused = false;
          if (agent && typeof onPick === "function") onPick(agent);
          else paneChanged();
          return;
        }
        // Swallow every other key while focused, so ← / → cannot reach the
        // session-list handler from inside the pane.
        continue;
      }
      if (seq === "a" || seq === "A") {
        // With a live pane, `a` focuses it instead of opening the modal picker:
        // same destination, no screen swap.
        if (paneLive()) {
          pane.focused = true;
          paneChanged();
          return;
        }
        onAgents();
        return;
      }
    }
    if (parser.hasPendingEsc()) {
      // A lone Esc only resolves once we know no CSI bytes follow, so decide on
      // the next tick — Esc is the sole "back" key, so it is only handled here.
      escFlush = setImmediate(() => {
        for (const seq of parser.flush()) {
          if (seq === KEY.ESC) {
            // Focused pane: Esc leaves the pane first. Only once the cursor is
            // gone does it mean "leave the session".
            if (pane?.focused && paneLive()) {
              pane.focused = false;
              paneChanged();
              return;
            }
            // Esc is the "back to the session list" key. When there is no
            // session list — the locked live-split meter, where `promptSession`
            // is withheld — it has no destination, so it is a no-op rather than
            // falling through to the agent modal and undoing the split lock.
            // (Tab / `a` already focus the in-frame agents pane.)
            if (typeof onSessions === "function") onSessions();
            return;
          }
        }
      });
    }
  };

  input.on("data", onData);
  return () => {
    if (escFlush) clearImmediate(escFlush);
    input.removeListener("data", onData);
    input.setRawMode?.(wasRaw);
    // Resuming stdin made it a ref'd handle holding the event loop open, so
    // `q` returned from the meter and then the process just sat there — only
    // Ctrl+C (which exits explicitly) could end it. Pause it back if we were
    // the ones who started it flowing.
    if (wasPaused) input.pause?.();
  };
}
