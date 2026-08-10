import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runUsageMeter } from "../../../../lib/harnesses/claude/usage/meter.mjs";
import { sanitize } from "../../../../lib/ui/sanitize.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_8BIT = String.fromCharCode(0x9b);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

async function renderPrompts(prompts, model = "glm-5p2") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-esc-"));
  try {
    const log = path.join(dir, "s.jsonl");
    prompts.forEach((content, i) => {
      fs.appendFileSync(log, `${JSON.stringify({ type: "user", message: { content } })}\n`);
      fs.appendFileSync(log, `${JSON.stringify({
        type: "assistant",
        message: { id: `a${i}`, model, usage: { input_tokens: 100, output_tokens: 50 } },
      })}\n`);
    });
    fs.appendFileSync(log, `${JSON.stringify({ type: "user", message: { content: "trailing" } })}\n`);

    let text = "";
    const stream = {
      isTTY: false,
      // 132: the spelled-out token headings ("uncached"/"cached"/"cache write")
      // take 77 columns, so at 100 there is only ~22 left for prompt text and
      // these tests would be asserting against truncation rather than sanitizing.
      columns: 132,
      rows: 40,
      write(chunk) {
        text += String(chunk);
      },
    };
    await runUsageMeter({
      filePath: log,
      plain: true,
      fromStart: true,
      follow: false,
      stream,
      sleep: async () => {},
    });
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("usage meter strips terminal escapes from prompt text", () => {
  it("emits no control characters for any escape-bearing prompt", async () => {
    const out = await renderPrompts([
      `start ${ESC}[2J${ESC}[H PWNED`,
      `start ${ESC}[41;97m FAKE-ALERT ${ESC}[0m`,
      `start ${ESC}[10;1H OVERWRITE`,
      `start ${ESC}]0;HIJACKED${BEL} end`,
      `start ${ESC}]8;;http://evil${BEL} click ${ESC}]8;;${BEL}`,
      `start ${String.fromCharCode(0)}${String.fromCharCode(8)}${String.fromCharCode(127)} end`,
      `start ${CSI_8BIT}2J end`,
    ]);
    const leaking = out.split("\n").filter((l) => CONTROL.test(l));
    assert.deepEqual(leaking, [], "control characters reached the terminal");
  });

  it("keeps the surrounding text readable", async () => {
    const out = await renderPrompts([`hello ${ESC}[2J world`]);
    assert.match(out, /hello world/);
  });

  it("leaves ordinary prompts untouched", async () => {
    const out = await renderPrompts(["a normal prompt about routing"]);
    assert.match(out, /a normal prompt about routing/);
  });

  it("sanitizes the served model id too", async () => {
    const out = await renderPrompts(["a turn"], `evil${ESC}[2J${ESC}[H-model`);
    const leaking = out.split("\n").filter((l) => CONTROL.test(l));
    assert.deepEqual(leaking, [], "escapes in message.model reached the terminal");
  });

  it("exports sanitize for direct checks", () => {
    assert.equal(sanitize(`x${ESC}[2Jy`), "xy");
  });

  it("shows per-request cache hit % from cache_read tokens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-cache-"));
    try {
      const log = path.join(dir, "s.jsonl");
      fs.appendFileSync(log, `${JSON.stringify({ type: "user", message: { content: "first" } })}\n`);
      fs.appendFileSync(log, `${JSON.stringify({
        type: "assistant",
        message: {
          id: "a0",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 10 },
        },
      })}\n`);
      fs.appendFileSync(log, `${JSON.stringify({ type: "user", message: { content: "second" } })}\n`);
      fs.appendFileSync(log, `${JSON.stringify({
        type: "assistant",
        message: {
          id: "a1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 20, cache_read_input_tokens: 980, output_tokens: 5 },
        },
      })}\n`);
      fs.appendFileSync(log, `${JSON.stringify({ type: "user", message: { content: "trailing" } })}\n`);

      let text = "";
      const stream = {
        isTTY: false,
        columns: 120,
        rows: 40,
        write(chunk) {
          text += String(chunk);
        },
      };
      await runUsageMeter({
        filePath: log,
        plain: true,
        fromStart: true,
        follow: false,
        stream,
        sleep: async () => {},
      });
      assert.match(text, /cache%/);
      // Columns are uncached · cached · cache write · cache%; Fireworks has no
      // separate cache-write price, so that column reads 0 there.
      // Turn 1: no cache read → 0%
      assert.match(text, /GLM5\.2\s+1\.0k\s+0\s+0\s+0%\s+/);
      // Turn 2: 980 / (20+980) = 98%
      assert.match(text, /GLM5\.2\s+20\s+980\s+0\s+98%\s+/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to plain output on a TTY when colour is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-nocolor-"));
    const prevNoColor = process.env.NO_COLOR;
    try {
      process.env.NO_COLOR = "1";
      const log = path.join(dir, "s.jsonl");
      fs.appendFileSync(log, `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
      fs.appendFileSync(log, `${JSON.stringify({
        type: "assistant",
        message: { id: "a0", model: "glm-5p2", usage: { input_tokens: 10, output_tokens: 5 } },
      })}\n`);
      fs.appendFileSync(log, `${JSON.stringify({ type: "user", message: { content: "trailing" } })}\n`);

      let text = "";
      const stream = {
        isTTY: true,
        columns: 100,
        rows: 40,
        write(chunk) {
          text += String(chunk);
        },
      };
      await runUsageMeter({
        filePath: log,
        plain: false,
        fromStart: true,
        follow: false,
        stream,
        sleep: async () => {},
      });
      // Must not hide the cursor then no-op draw — plain banner + rows.
      assert.doesNotMatch(text, /\x1b\[\?25l/);
      assert.match(text, /Live Cost Meter/);
      assert.match(text, /hello/);
      assert.match(text, /GLM5\.2/);
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
