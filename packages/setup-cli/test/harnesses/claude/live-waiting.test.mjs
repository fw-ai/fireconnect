import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  drawLiveWaitingScreen,
  drawSessionLockedScreen,
  enterLiveWaitingScreen,
  LIVE_METER_TITLE,
} from "../../../lib/harnesses/claude/live-waiting.mjs";

function mockStream({ cols = 100, rows = 24, tty = true } = {}) {
  const chunks = [];
  return {
    isTTY: tty,
    columns: cols,
    rows,
    write(value) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

describe("live waiting screens", () => {
  it("draws a static split diagram with no spinner", () => {
    const stream = mockStream();
    drawLiveWaitingScreen(stream);
    const out = stream.text();
    assert.match(out, new RegExp(LIVE_METER_TITLE.trim()));
    assert.match(out, /Claude Code/);
    assert.match(out, /Live cost/);
    assert.match(out, /q quit layout/);
    assert.match(out, /send your first prompt on the left/);
    // Static waiting screen: no braille spinner frame chars (they implied a
    // "loading" state and required the repaint loop that broke text selection).
    assert.doesNotMatch(out, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it("draws a session lock handoff screen", () => {
    const stream = mockStream();
    drawSessionLockedScreen(stream, "abc12345", 2);
    const out = stream.text();
    assert.match(out, /locked session abc12345/);
    assert.match(out, /starting live cost meter/);
  });

  it("enters and restores the alternate screen on a TTY", () => {
    const stream = mockStream();
    const restore = enterLiveWaitingScreen(stream);
    assert.match(stream.text(), /\x1b\[\?1049h/);
    restore();
    assert.match(stream.text(), /\x1b\[\?1049l/);
  });

  it("skips alternate screen when not a TTY", () => {
    const stream = mockStream({ tty: false });
    const restore = enterLiveWaitingScreen(stream);
    assert.doesNotMatch(stream.text(), /\x1b\[\?1049h/);
    restore();
  });

  it("aligns the split diagram body columns with the frame", () => {
    const stream = mockStream();
    drawLiveWaitingScreen(stream);
    const stripAnsi = (line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const lines = stream.text().split("\n").map(stripAnsi);
    const top = lines.find((line) => line.startsWith("╭") && line.includes("┬"));
    const labelRow = lines.find((line) => line.includes("Claude Code") && line.includes("Live cost"));
    const bodyRow = lines.find((line) => line.includes("your session") && line.includes("waiting"));
    const bottom = lines.find((line) => line.startsWith("╰") && line.includes("┴"));
    assert.ok(top && labelRow && bodyRow && bottom, "split diagram rows should be present");
    // A single divider between cells keeps the body the same width as the frame.
    assert.equal(labelRow.length, top.length, "label row must match frame width");
    assert.equal(bodyRow.length, top.length, "body row must match frame width");
    assert.equal(bottom.length, top.length, "bottom border must match frame width");
  });
});
