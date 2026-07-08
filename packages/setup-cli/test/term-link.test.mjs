import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hyperlinksEnabled, link } from "../lib/term.mjs";

const URL = "https://app.fireworks.ai/settings/users/api-keys";
const OSC8_PREFIX = `\u001b]8;;${URL}\u001b\\`;
const OSC8_SUFFIX = "\u001b]8;;\u001b\\";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("hyperlinksEnabled", () => {
  it("is off for non-TTY streams regardless of terminal", () => {
    assert.equal(hyperlinksEnabled(pipe, { TERM_PROGRAM: "iTerm.app" }), false);
  });

  it("is off on a TTY in an unknown terminal", () => {
    assert.equal(hyperlinksEnabled(tty, { TERM: "xterm-256color" }), false);
  });

  it("is on for allowlisted terminals", () => {
    assert.equal(hyperlinksEnabled(tty, { TERM_PROGRAM: "iTerm.app" }), true);
    assert.equal(hyperlinksEnabled(tty, { TERM_PROGRAM: "vscode" }), true);
    assert.equal(hyperlinksEnabled(tty, { TERM: "xterm-kitty" }), true);
    assert.equal(hyperlinksEnabled(tty, { WT_SESSION: "1" }), true);
    assert.equal(hyperlinksEnabled(tty, { VTE_VERSION: "6003" }), true);
  });

  it("is off for VTE builds older than 0.50", () => {
    assert.equal(hyperlinksEnabled(tty, { VTE_VERSION: "4205" }), false);
  });

  it("FORCE_HYPERLINK overrides in both directions", () => {
    assert.equal(hyperlinksEnabled(pipe, { FORCE_HYPERLINK: "1" }), true);
    assert.equal(hyperlinksEnabled(tty, { TERM_PROGRAM: "iTerm.app", FORCE_HYPERLINK: "0" }), false);
    assert.equal(hyperlinksEnabled(tty, { TERM_PROGRAM: "iTerm.app", FORCE_HYPERLINK: "" }), false);
  });
});

describe("link", () => {
  it("keeps the URL as visible text when unsupported (piped output)", () => {
    assert.equal(link(URL, pipe), URL);
  });

  it("wraps the URL in OSC 8 with the URL still visible when supported", () => {
    // process.env in tests has no allowlisted terminal; force support and
    // check the shape of the escape framing around the (possibly colored) URL.
    process.env.FORCE_HYPERLINK = "1";
    try {
      const wrapped = link(URL, pipe);
      assert.ok(wrapped.startsWith(OSC8_PREFIX), wrapped);
      assert.ok(wrapped.endsWith(OSC8_SUFFIX), wrapped);
      assert.ok(wrapped.includes(URL), wrapped);
    } finally {
      delete process.env.FORCE_HYPERLINK;
    }
  });
});
