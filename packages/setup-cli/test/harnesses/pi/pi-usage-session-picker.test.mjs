import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setImmediate } from "node:timers";

import {
  PI_SESSIONS_RELATIVE_DIR,
} from "../../../lib/harnesses/pi/usage/report.mjs";
import {
  PI_USAGE_PICKER_DAYS,
  formatPiUsageSessionChoice,
  formatSessionAge,
  listRecentPiUsageSessions,
  piShortSessionId,
  promptPiUsageSession,
} from "../../../lib/harnesses/pi/usage/session-picker.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-pick-"));
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

function usageJsonl({ model = "glm-5p2", responseModel = "glm-5p2", input = 100, output = 10, name = "" } = {}) {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "sid", timestamp: "t", cwd: "/repo" }),
  ];
  if (name) {
    lines.push(JSON.stringify({ type: "session_info", id: "n", parentId: null, timestamp: "t", name }));
  }
  lines.push(JSON.stringify({
    type: "message",
    id: "e0",
    parentId: null,
    timestamp: "t",
    message: { role: "user", content: "hi", timestamp: 1 },
  }));
  lines.push(JSON.stringify({
    type: "message",
    id: "e1",
    parentId: "e0",
    timestamp: "t",
    message: {
      role: "assistant",
      model,
      ...(responseModel ? { responseModel } : {}),
      responseId: "r1",
      stopReason: "stop",
      provider: "fireworks",
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
    },
  }));
  return `${lines.join("\n")}\n`;
}

async function piProjectDir(home) {
  const projectDir = path.join(home, PI_SESSIONS_RELATIVE_DIR, "--Users-x-repo--");
  await mkdir(projectDir, { recursive: true });
  return projectDir;
}

describe("piShortSessionId", () => {
  it("shortens the uuid part of a <timestamp>_<uuid> session file", () => {
    assert.equal(
      piShortSessionId("/tmp/sessions/repo/2026-10-05T05-31-03-648Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"),
      "aaaaaaaa…",
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
    const label = formatPiUsageSessionChoice({
      filePath: "/tmp/sessions/repo/2026-10-05T05-31-03-648Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
      mtimeMs: Date.now() - 120_000,
      report: {
        sessionName: "FireRouter demo",
        requests: 4,
        totals: { cost: 0.0751 },
      },
    });
    assert.match(label, /\$0\.0751/);
    assert.match(label, /4 calls/);
    assert.match(label, /aaaaaaaa…/);
    assert.match(label, /FireRouter demo/);
    assert.match(label, /2m ago/);
  });

  it("reserves enough room for four-decimal totals over $100", () => {
    const label = formatPiUsageSessionChoice({
      filePath: "/tmp/sessions/repo/2026-10-05T05-31-03-648Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
      mtimeMs: Date.now(),
      report: {
        requests: 1,
        totals: { cost: 116.9562 },
      },
    });
    assert.match(label, /^\s\$116\.9562 ·/);
  });

  it("shows n/a rather than zero for an unpriced session", () => {
    const label = formatPiUsageSessionChoice({
      filePath: "/tmp/sessions/repo/2026-10-05T05-31-03-648Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
      mtimeMs: Date.now(),
      report: {
        requests: 1,
        totals: { cost: null },
      },
    });
    assert.match(label, /^\s*n\/a ·/);
    assert.doesNotMatch(label, /\$0\.00/);
  });

  it("strips CSI/OSC escapes from session names", () => {
    const label = formatPiUsageSessionChoice({
      filePath: "/tmp/sessions/repo/2026-10-05T05-31-03-648Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
      mtimeMs: Date.now(),
      report: {
        sessionName: `evil\u001b[2J\u001b]0;hack\u0007 title`,
        requests: 1,
        totals: { cost: 0.01 },
      },
    });
    assert.doesNotMatch(label, /\u001b/);
    assert.doesNotMatch(label, /\u0007/);
    assert.match(label, /evil title/);
  });
});

describe("listRecentPiUsageSessions / promptPiUsageSession", () => {
  it("lists usage for sessions in the default 3-day window", async () => {
    assert.equal(PI_USAGE_PICKER_DAYS, 3);
    const home = await tempHome();
    const projectDir = await piProjectDir(home);
    const sid = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    await writeFile(
      path.join(projectDir, `2026-10-05T05-31-03-648Z_${sid}.jsonl`),
      usageJsonl({ name: "Demo session", input: 1000, output: 50 }),
    );

    const listed = await listRecentPiUsageSessions({ home, withinDays: 3 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].filePath, path.join(projectDir, `2026-10-05T05-31-03-648Z_${sid}.jsonl`));
    assert.ok(listed[0].report.totals.cost > 0);
    assert.equal(listed[0].report.sessionName, "Demo session");
  });

  it("treats an empty sessions store as an empty list", async () => {
    const home = await tempHome();
    assert.deepEqual(await listRecentPiUsageSessions({ home, withinDays: 3 }), []);
  });

  it("auto-selects when only one recent session exists", async () => {
    const home = await tempHome();
    const projectDir = await piProjectDir(home);
    const sid = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const filePath = path.join(projectDir, `2026-10-05T05-31-03-648Z_${sid}.jsonl`);
    await writeFile(filePath, usageJsonl());

    const chosen = await promptPiUsageSession({ home, withinDays: 3 });
    assert.equal(chosen, filePath);
  });

  it("auto-selects the newest session when stdin is not a TTY", async () => {
    const home = await tempHome();
    const projectDir = await piProjectDir(home);
    const older = path.join(projectDir, "2026-10-04T00-00-00-000Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
    const newer = path.join(projectDir, "2026-10-05T00-00-00-000Z_bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
    await writeFile(older, usageJsonl({ input: 10 }));
    await writeFile(newer, usageJsonl({ input: 20 }));
    const olderTs = (Date.now() - 3_600_000) / 1000;
    await utimes(older, olderTs, olderTs);

    const chosen = await promptPiUsageSession({
      home,
      withinDays: 3,
      input: { isTTY: false },
      output: { isTTY: true, write() { return true; } },
    });
    assert.equal(chosen, newer);
  });

  it("returns null when the picker is cancelled", async () => {
    const home = await tempHome();
    const projectDir = await piProjectDir(home);
    await writeFile(path.join(projectDir, "2026-10-04T00-00-00-000Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"), usageJsonl({ input: 10 }));
    await writeFile(path.join(projectDir, "2026-10-05T00-00-00-000Z_bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"), usageJsonl({ input: 20 }));

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
    const pending = promptPiUsageSession({ home, withinDays: 3, input, output });
    // Listing sessions is async; wait until promptSelect has drawn before Esc.
    await waitForWrites(writes);
    setImmediate(() => input.emit("data", "\u001b"));
    assert.equal(await pending, null);
  });

  it("selects the highlighted session on Enter", async () => {
    const home = await tempHome();
    const projectDir = await piProjectDir(home);
    const older = path.join(projectDir, "2026-10-04T00-00-00-000Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
    const newer = path.join(projectDir, "2026-10-05T00-00-00-000Z_bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
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
    const pending = promptPiUsageSession({ home, withinDays: 3, input, output });
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
      () => promptPiUsageSession({ home, withinDays: 3 }),
      /No Pi sessions in the last 3 days/,
    );
  });
});
