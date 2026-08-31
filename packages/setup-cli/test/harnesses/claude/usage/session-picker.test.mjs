import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { findClaudeSessionLogs } from "../../../../lib/harnesses/claude/usage/report.mjs";
import {
  CLAUDE_USAGE_PICKER_DAYS,
  formatClaudeUsageSessionChoice,
  formatSessionAge,
  listRecentClaudeUsageSessions,
  promptClaudeUsageSession,
} from "../../../../lib/harnesses/claude/usage/session-picker.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-pick-"));
  temps.push(home);
  return home;
}

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
}

function waitForWrites(writes) {
  return new Promise((resolve) => {
    const tick = () => (writes.length > 0 ? resolve() : setImmediate(tick));
    tick();
  });
}

function usageJsonl({ model = "accounts/fireworks/models/glm-5p2", input = 100, output = 10, title = "" } = {}) {
  const lines = [];
  if (title) {
    lines.push(JSON.stringify({ type: "custom-title", customTitle: title, sessionId: "x" }));
  }
  lines.push(JSON.stringify({ type: "user", message: { content: "hi" } }));
  lines.push(JSON.stringify({
    type: "assistant",
    message: {
      id: "m1",
      model,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0 },
    },
  }));
  return `${lines.join("\n")}\n`;
}


describe("findClaudeSessionLogs withinDays", () => {
  it("keeps only sessions touched inside the window", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const recent = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl");
    const old = path.join(projectDir, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl");
    await writeFile(recent, "\n");
    await writeFile(old, "\n");
    const fourDaysAgo = (Date.now() - 4 * 86_400_000) / 1000;
    await utimes(old, fourDaysAgo, fourDaysAgo);

    assert.deepEqual(
      await findClaudeSessionLogs({ home, withinDays: 3, lastN: 100 }),
      [recent],
    );

    await utimes(recent, fourDaysAgo, fourDaysAgo);
    assert.deepEqual(
      await findClaudeSessionLogs({ home, withinDays: 3, lastN: 100 }),
      [],
    );
  });
});

describe("formatSessionAge / choice labels", () => {
  it("formats relative ages", () => {
    const now = Date.parse("2026-08-06T12:00:00Z");
    assert.equal(formatSessionAge(now - 15_000, now), "15s ago");
    assert.equal(formatSessionAge(now - 5 * 60_000, now), "5m ago");
    assert.equal(formatSessionAge(now - 3 * 3600_000, now), "3h ago");
    assert.equal(formatSessionAge(now - 3 * 86_400_000, now), "3d ago");
  });

  it("includes cost, calls, id, name, and age", () => {
    const label = formatClaudeUsageSessionChoice({
      filePath: "/tmp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
      mtimeMs: Date.now() - 120_000,
      report: {
        sessionName: "FireRouter demo",
        requests: 4,
        grandRequests: 4,
        totals: { cost: 0.0751 },
        grandTotals: { cost: 0.0751 },
      },
    });
    assert.match(label, /\$0\.0751/);
    assert.match(label, /4 calls/);
    assert.match(label, /aaaaaaaa…/);
    assert.match(label, /FireRouter demo/);
    assert.match(label, /2m ago/);
  });

  it("reserves enough room for four-decimal totals over $100", () => {
    const label = formatClaudeUsageSessionChoice({
      filePath: "/tmp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
      mtimeMs: Date.now(),
      report: {
        grandRequests: 1,
        grandTotals: { cost: 116.9562 },
      },
    });
    assert.match(label, /^\s\$116\.9562 ·/);
  });

  it("shows n/a rather than zero for an unpriced session", () => {
    const label = formatClaudeUsageSessionChoice({
      filePath: "/tmp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
      mtimeMs: Date.now(),
      report: {
        requests: 1,
        grandRequests: 1,
        totals: { cost: null },
        grandTotals: { cost: null },
      },
    });
    assert.match(label, /^\s*n\/a ·/);
    assert.doesNotMatch(label, /\$0\.00/);
  });

  it("strips CSI/OSC escapes from session names", () => {
    const label = formatClaudeUsageSessionChoice({
      filePath: "/tmp/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl",
      mtimeMs: Date.now(),
      report: {
        sessionName: `evil\u001b[2J\u001b]0;hack\u0007 title`,
        requests: 1,
        grandRequests: 1,
        totals: { cost: 0.01 },
        grandTotals: { cost: 0.01 },
      },
    });
    assert.doesNotMatch(label, /\u001b/);
    assert.doesNotMatch(label, /\u0007/);
    assert.match(label, /evil title/);
  });
});

describe("listRecentClaudeUsageSessions / promptClaudeUsageSession", () => {
  it("lists usage for sessions in the default 3-day window", async () => {
    assert.equal(CLAUDE_USAGE_PICKER_DAYS, 3);
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sid = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    await writeFile(path.join(projectDir, `${sid}.jsonl`), usageJsonl({
      title: "Demo session",
      input: 1000,
      output: 50,
    }));

    const listed = await listRecentClaudeUsageSessions({ home, withinDays: 3 });
    assert.equal(listed.length, 1);
    assert.equal(path.basename(listed[0].filePath, ".jsonl"), sid);
    assert.ok(listed[0].report.grandTotals.cost > 0);
    assert.equal(listed[0].report.sessionName, "Demo session");
  });

  it("auto-selects when only one recent session exists", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sid = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const filePath = path.join(projectDir, `${sid}.jsonl`);
    await writeFile(filePath, usageJsonl());

    const chosen = await promptClaudeUsageSession({ home, withinDays: 3 });
    assert.equal(chosen, filePath);
  });

  it("auto-selects the newest session when stdin is not a TTY", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const older = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl");
    const newer = path.join(projectDir, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl");
    await writeFile(older, usageJsonl({ input: 10 }));
    await writeFile(newer, usageJsonl({ input: 20 }));
    const olderTs = (Date.now() - 3_600_000) / 1000;
    await utimes(older, olderTs, olderTs);

    const chosen = await promptClaudeUsageSession({
      home,
      withinDays: 3,
      input: { isTTY: false },
      output: { isTTY: true, write() { return true; } },
    });
    assert.equal(chosen, newer);
  });

  it("returns null when the picker is cancelled", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl"), usageJsonl({ input: 10 }));
    await writeFile(path.join(projectDir, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl"), usageJsonl({ input: 20 }));

    const input = new FakeInput();
    const writes = [];
    const output = {
      isTTY: true,
      columns: 100,
      write(chunk) {
        writes.push(chunk);
        return true;
      },
    };
    const pending = promptClaudeUsageSession({ home, withinDays: 3, input, output });
    // Listing sessions is async; wait until promptSelect has drawn before Esc.
    await waitForWrites(writes);
    setImmediate(() => input.emit("data", "\u001b"));
    assert.equal(await pending, null);
  });

  it("selects the highlighted session on Enter", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const older = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl");
    const newer = path.join(projectDir, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl");
    await writeFile(older, usageJsonl({ input: 10 }));
    await writeFile(newer, usageJsonl({ input: 20 }));
    const olderTs = (Date.now() - 3_600_000) / 1000;
    await utimes(older, olderTs, olderTs);

    const input = new FakeInput();
    const writes = [];
    const output = {
      isTTY: true,
      columns: 100,
      write(chunk) {
        writes.push(chunk);
        return true;
      },
    };
    const pending = promptClaudeUsageSession({ home, withinDays: 3, input, output });
    await waitForWrites(writes);
    // Newest is highlighted first; Down → older, then Enter.
    setImmediate(() => {
      input.emit("data", "\x1b[B");
      input.emit("data", "\r");
    });
    assert.equal(await pending, older);
  });

  it("errors when nothing falls in the lookback window", async () => {
    const home = await tempHome();
    await assert.rejects(
      () => promptClaudeUsageSession({ home, withinDays: 3 }),
      /No Claude Code sessions in the last 3 days/,
    );
  });
});
