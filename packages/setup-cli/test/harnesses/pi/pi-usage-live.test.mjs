import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  PI_METER_TITLE,
  attachPiMeterKeys,
  piLiveMeterKeyHint,
  runPiUsageLive,
  shouldRunPiUsageLive,
} from "../../../lib/harnesses/pi/usage/live.mjs";
import {
  PI_SESSIONS_RELATIVE_DIR,
  parsePiUsageLog,
} from "../../../lib/harnesses/pi/usage/report.mjs";
import { runUsageMeter } from "../../../lib/harnesses/claude/usage/meter.mjs";
import { piMeterRecord } from "../../../lib/harnesses/pi/usage/meter-records.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-live-"));
  temps.push(home);
  return home;
}

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function writeSession(home, entries) {
  const dir = path.join(home, PI_SESSIONS_RELATIVE_DIR, "--Users-x-repo--");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `2026-10-05T05-31-03-648Z_${UUID}.jsonl`);
  await writeFile(file, jsonl(entries));
  return file;
}

function piSessionEntries() {
  return [
    { type: "session", version: 3, id: UUID, timestamp: "t", cwd: "/repo" },
    { type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "user", content: "go" } },
    {
      type: "message",
      id: "e1",
      parentId: "e0",
      timestamp: "t",
      message: {
        role: "assistant",
        model: "firerouter/opus",
        responseModel: "accounts/fireworks/models/glm-5p2",
        responseId: "resp_1",
        stopReason: "stop",
        usage: { input: 48_030, cacheRead: 8, cacheWrite: 0, output: 11 },
      },
    },
    {
      type: "usage",
      id: "u1",
      parentId: "e1",
      timestamp: "t",
      kind: "cache_warm",
      provider: "fireworks",
      model: "glm-5p2",
      usage: { input: 0, cacheRead: 50_000, cacheWrite: 0, output: 0 },
    },
  ];
}

function mockStream() {
  const chunks = [];
  return {
    isTTY: true,
    columns: 120,
    rows: 40,
    write(value) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

describe("shouldRunPiUsageLive", () => {
  const tty = { isTTY: true };
  const nonTty = { isTTY: false };

  it("runs live on a TTY without snapshot flags", () => {
    assert.equal(shouldRunPiUsageLive({}, tty), true);
  });

  it("stays one-shot for json, last-n, verbose, plain, and non-TTY", () => {
    assert.equal(shouldRunPiUsageLive({ json: true }, tty), false);
    assert.equal(shouldRunPiUsageLive({ lastN: "5" }, tty), false);
    assert.equal(shouldRunPiUsageLive({ verbose: true }, tty), false);
    assert.equal(shouldRunPiUsageLive({ plain: true }, tty), false);
    assert.equal(shouldRunPiUsageLive({}, nonTty), false);
  });
});

describe("piLiveMeterKeyHint", () => {
  it("advertises Esc only when a session list exists", () => {
    assert.equal(piLiveMeterKeyHint({ canPickSession: true }), "Esc sessions · q quit");
    assert.equal(piLiveMeterKeyHint({ canPickSession: false }), "q quit");
  });

  it("advertises quitting the whole layout inside a live split", () => {
    assert.equal(piLiveMeterKeyHint({ canPickSession: true, liveSplit: true }), "Esc sessions · q quit layout");
    assert.equal(piLiveMeterKeyHint({ liveSplit: true }), "q quit layout");
  });
});

describe("runUsageMeter with the pi record adapter", () => {
  it("meters a pi session file end to end in plain mode", async () => {
    const home = await tempHome();
    const file = await writeSession(home, piSessionEntries());
    const stream = mockStream();
    stream.isTTY = false;

    await runUsageMeter({
      filePath: file,
      plain: true,
      follow: false,
      stream,
      title: PI_METER_TITLE,
      mapRecord: piMeterRecord,
    });

    const text = stream.text();
    assert.match(text, /Pi · Live Cost Meter/, "the banner names the harness being metered");
    assert.match(text, /GLM ?5\.2/);
    assert.match(text, /TOTAL/);
  });

  it("meters the same totals the report parser computes", async () => {
    const home = await tempHome();
    const file = await writeSession(home, piSessionEntries());
    const stream = mockStream();
    stream.isTTY = false;

    const db = await runUsageMeter({
      filePath: file,
      plain: true,
      follow: false,
      stream,
      title: PI_METER_TITLE,
      mapRecord: piMeterRecord,
    });

    const rows = parsePiUsageLog(await (await import("node:fs/promises")).readFile(file, "utf8"));
    const reportTotal = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    let meterCost = 0;
    for (const tally of db.totals.values()) {
      meterCost += tally.cost ?? 0;
    }
    assert.ok(Math.abs(reportTotal - meterCost) < 1e-9, `report ${reportTotal} vs meter ${meterCost}`);
  });

  it("survives non-record lines and torn writes", async () => {
    const home = await tempHome();
    const dir = path.join(home, PI_SESSIONS_RELATIVE_DIR, "--Users-x-repo--");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `2026-10-05T05-31-03-648Z_${UUID}.jsonl`);
    // A torn trailing line: the meter must skip it without losing the turn.
    const text = `${jsonl(piSessionEntries()).trim()}\n{"type":"message","id":"torn`;
    await writeFile(file, text);
    const stream = mockStream();
    stream.isTTY = false;

    const db = await runUsageMeter({
      filePath: file,
      plain: true,
      follow: false,
      stream,
      title: PI_METER_TITLE,
      mapRecord: piMeterRecord,
    });
    assert.ok(db.turns.length >= 1, "the parsed records still meter");
  });
});

describe("runPiUsageLive", () => {
  it("tracks the newest session when none is named", async () => {
    const home = await tempHome();
    const file = await writeSession(home, piSessionEntries());
    const stream = mockStream();
    stream.isTTY = false;

    await runPiUsageLive({
      home,
      stream,
      follow: false,
      sleep: () => Promise.resolve(),
      resolveSession: async ({ session }) => {
        assert.equal(session, "");
        return file;
      },
    });
    // Non-TTY branch: the meter ran to completion on the resolved session.
    assert.match(stream.text(), /glm-5p2|TOTAL|usage/);
  });

  it("throws without a home", async () => {
    await assert.rejects(
      () => runPiUsageLive({ home: "" }),
      /HOME is required/,
    );
  });
});

describe("attachPiMeterKeys", () => {
  it("is a no-op without a TTY input", () => {
    const detach = attachPiMeterKeys({ input: { isTTY: false }, onQuit: () => {} });
    assert.equal(typeof detach, "function");
    detach();
  });
});
