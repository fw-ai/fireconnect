import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock } from "node:test";

import { printHelp } from "../../../lib/cli/commands/global.mjs";
import { LIMITED_NOTE, WORKSPACE_NOTES } from "../../../lib/harnesses/claude-desktop/core.mjs";

const README = new URL("../../../../../README.md", import.meta.url);

function captureHelp(topic) {
  const log = mock.method(console, "log", () => {});
  try {
    printHelp(topic);
    return log.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
  } finally {
    log.mock.restore();
  }
}

test("claude-desktop help lists every workspace note", () => {
  const help = captureHelp("claude-desktop");
  assert.match(help, /What stays with your claude\.ai subscription:/);
  for (const note of WORKSPACE_NOTES) assert.ok(help.includes(note), `help is missing: ${note}`);
});

test("README mirrors every workspace note verbatim", async () => {
  const readme = await readFile(README, "utf8");
  for (const note of WORKSPACE_NOTES) assert.ok(readme.includes(note), `README is missing: ${note}`);
});

test("claude-desktop help and README say it's limited", async () => {
  assert.ok(captureHelp("claude-desktop").includes(LIMITED_NOTE));
  assert.ok((await readFile(README, "utf8")).includes(LIMITED_NOTE));
});

test("the harness list labels Claude Desktop limited, after the ChatGPT desktop app", () => {
  const rows = captureHelp("").split("\n").filter((line) => /^\s{2}\S/.test(line));
  const chatgpt = rows.findIndex((line) => /^\s+chatgpt\s/.test(line));
  const desktop = rows.findIndex((line) => /^\s+claude-desktop\s/.test(line));
  assert.ok(chatgpt >= 0 && desktop === chatgpt + 1, rows.join("\n"));
  assert.match(rows[desktop], /Claude Desktop \(Limited\)$/);
});
