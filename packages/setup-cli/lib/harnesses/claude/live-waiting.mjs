/**
 * Waiting and handoff screens for the live split's right pane — matches the
 * cost meter frame and uses the same palette.
 */

import { ANSI } from "../../ui/palette.mjs";
import { colorEnabled } from "../../ui/term.mjs";
import {
  ACCENT,
  applyMeterStyle,
  B,
  BL,
  BR,
  clip,
  D,
  GHOST,
  GOLD,
  H,
  R,
  SPIN,
  TL,
  TR,
  V,
  vislen,
} from "./usage/meter-style.mjs";

export const LIVE_METER_TITLE = "  ✦  Claude Code · Live Cost Meter  ";

const TIPS = [
  "send your first prompt on the left — costs stream here live",
  "Ctrl+b then arrow keys switch between Claude and the meter",
  "exit Claude with /exit to close this split layout",
  "token counts and cost update on every model response",
];

/**
 * @param {NodeJS.WriteStream} stream
 */
export function enterLiveWaitingScreen(stream) {
  if (!stream.isTTY) {
    return () => {};
  }
  stream.write(`${ANSI.enterAltScreen}${ANSI.hideCursor}`);
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    stream.write(`${ANSI.showCursor}${ANSI.exitAltScreen}`);
  };
}

/**
 * @param {NodeJS.WriteStream} stream
 * @param {number} inner printable width inside the frame
 */
function splitDiagramLines(stream, inner) {
  const leftW = Math.max(14, Math.floor((inner - 3) * 0.55));
  const rightW = Math.max(10, inner - leftW - 3);
  const leftLabel = clip(" Claude Code ", leftW - 2);
  const rightLabel = clip(" Live cost ", rightW - 2);
  const leftBody = clip(" your session ", leftW - 2);
  const rightBody = clip(" waiting… ", rightW - 2);
  const pad = (text, width) => `${text}${" ".repeat(Math.max(0, width - vislen(text)))}`;

  return [
    `${ACCENT}${TL}${H.repeat(leftW)}${ACCENT}${"┬"}${H.repeat(rightW)}${TR}${R}`,
    `${ACCENT}${V}${R}${GHOST}${pad(leftLabel, leftW)}${ACCENT}${V}${R}${B}${pad(rightLabel, rightW)}${R}${ACCENT}${V}${R}`,
    `${ACCENT}${V}${R}${GHOST}${pad(leftBody, leftW)}${ACCENT}${V}${R}${GHOST}${pad(rightBody, rightW)}${R}${ACCENT}${V}${R}`,
    `${ACCENT}${BL}${H.repeat(leftW)}${ACCENT}${"┴"}${H.repeat(rightW)}${BR}${R}`,
  ];
}

/**
 * Static waiting screen — drawn ONCE, no spinner and no repaint loop, so it
 * does not read as a "loading" state while the session idles and the user can
 * select text in the pane. (It is redrawn only when the session locks.)
 *
 * @param {NodeJS.WriteStream} stream
 */
export function drawLiveWaitingScreen(stream) {
  applyMeterStyle(colorEnabled(stream));
  const cols = stream.columns || 100;
  const rows = stream.rows || 24;
  const w = Math.min(cols, 132);
  const inner = w - 2;
  const meta = clip("  waiting for your first prompt on the left…", inner);
  const tip = clip(`  ${TIPS[0]}`, inner);

  const out = [`${ANSI.homeCursor}${ANSI.clearScreen}`];
  out.push(`${ACCENT}${TL}${H.repeat(inner)}${TR}${R}`);
  out.push(`${ACCENT}${V}${R}${B}${clip(LIVE_METER_TITLE, inner)}${R}${" ".repeat(Math.max(0, inner - vislen(clip(LIVE_METER_TITLE, inner))))}${ACCENT}${V}${R}`);
  out.push(`${ACCENT}${V}${R}${GHOST}${meta}${R}${" ".repeat(Math.max(0, inner - vislen(meta)))}${ACCENT}${V}${R}`);
  out.push(`${ACCENT}${BL}${H.repeat(inner)}${BR}${R}`);
  out.push("");
  out.push(...splitDiagramLines(stream, inner));
  out.push("");
  out.push(`${GHOST}${tip}${R}`);
  for (let i = out.length; i < Math.max(rows - 2, 12); i += 1) {
    out.push("");
  }
  out.push(`${D}${clip("  q quit layout", w - 2)}${R}`);
  stream.write(out.join("\n"));
}

/**
 * Brief handoff when a session log appears — before the live meter starts.
 *
 * @param {NodeJS.WriteStream} stream
 * @param {string} sessionId 8-char session prefix
 * @param {number} [tick]
 */
export function drawSessionLockedScreen(stream, sessionId, tick = 0) {
  applyMeterStyle(colorEnabled(stream));
  const cols = stream.columns || 100;
  const rows = stream.rows || 24;
  const w = Math.min(cols, 132);
  const inner = w - 2;
  const spin = SPIN[tick % SPIN.length];
  const meta = clip(`  ${spin} locked session ${sessionId}`, inner);
  const hint = clip("  starting live cost meter…", inner);

  const out = [`${ANSI.homeCursor}${ANSI.clearScreen}`];
  out.push(`${ACCENT}${TL}${H.repeat(inner)}${TR}${R}`);
  out.push(`${ACCENT}${V}${R}${B}${clip(LIVE_METER_TITLE, inner)}${R}${" ".repeat(Math.max(0, inner - vislen(clip(LIVE_METER_TITLE, inner))))}${ACCENT}${V}${R}`);
  out.push(`${ACCENT}${V}${R}${GOLD}${meta}${R}${" ".repeat(Math.max(0, inner - vislen(meta)))}${ACCENT}${V}${R}`);
  out.push(`${ACCENT}${BL}${H.repeat(inner)}${BR}${R}`);
  out.push("");
  out.push(`${GHOST}${hint}${R}`);
  for (let i = out.length; i < Math.max(rows - 1, 8); i += 1) {
    out.push("");
  }
  stream.write(out.join("\n"));
}
