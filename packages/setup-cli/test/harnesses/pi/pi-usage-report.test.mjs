import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  NoPiSessionLogsError,
  PI_SESSIONS_RELATIVE_DIR,
  findPiSessionLog,
  findPiSessionLogs,
  formatPiUsageReport,
  listPiSessionLogPaths,
  parsePiSessionName,
  parsePiUsageLog,
  piUsageReportFromText,
  readPiUsage,
  readPiUsages,
  snapshotPiSessionLogs,
} from "../../../lib/harnesses/pi/usage/report.mjs";
import { FIREWORKS_STANDARD_PRICING } from "../../../lib/fireworks/pricing.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-usage-"));
  temps.push(home);
  return home;
}

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** A Pi session file name: `<timestamp>_<uuid>.jsonl`. */
function piSessionFileName(uuid = UUID) {
  return `2026-10-05T05-31-03-648Z_${uuid}.jsonl`;
}

/** One Pi assistant `message` entry with usage. */
function piAssistantEntry({
  id = "e1",
  model = "accounts/fireworks/models/glm-5p2",
  responseModel = "",
  input = 1000,
  output = 100,
  cacheRead = 0,
  cacheWrite = 0,
  stopReason = "stop",
  responseId = "resp_1",
} = {}) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-05T05:31:13.000Z",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "fireworks",
      ...(model ? { model } : {}),
      ...(responseModel ? { responseModel } : {}),
      responseId,
      stopReason,
      rawStopReason: "stop",
      thinkingLevel: "medium",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning: 0,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

function piUserEntry(content = "first question about retries", id = "e0") {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-05T05:31:12.000Z",
    message: { role: "user", content, timestamp: 1762335072000 },
  };
}

function piSessionEntry() {
  return {
    type: "session",
    version: 3,
    id: UUID,
    timestamp: "2026-10-05T05:31:03.648Z",
    cwd: "/repo",
  };
}

describe("pi usage report", () => {
  it("parses session names from session_info and the first user prompt", () => {
    assert.equal(parsePiSessionName(jsonl([
      piSessionEntry(),
      piUserEntry("first question about retries"),
      { type: "session_info", id: "e9", parentId: null, timestamp: "t", name: "Auth retry work" },
    ])), "Auth retry work");

    assert.equal(parsePiSessionName(jsonl([
      piSessionEntry(),
      piUserEntry("first question about retries"),
    ])), "first question about retries");

    assert.equal(parsePiSessionName(jsonl([
      piSessionEntry(),
    ])), "");
  });

  it("prefers the first user prompt text with array content", () => {
    assert.equal(parsePiSessionName(jsonl([
      piSessionEntry(),
      {
        type: "message",
        id: "e0",
        parentId: null,
        timestamp: "t",
        message: { role: "user", content: [{ type: "text", text: "array question" }] },
      },
    ])), "array question");
  });

  it("prices assistant calls with Pi usage field names", () => {
    const rows = parsePiUsageLog(jsonl([
      piSessionEntry(),
      piUserEntry("go"),
      piAssistantEntry({ input: 48_030, cacheRead: 8, output: 11 }),
    ]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].displayModel, "glm-5p2");
    assert.equal(rows[0].input, 48_030);
    assert.equal(rows[0].cacheRead, 8);
    assert.equal(rows[0].output, 11);
    assert.ok(rows[0].priced, "a catalog model must price");
    assert.ok(rows[0].cost > 0, "a call with real tokens must not price at zero");
  });

  it("prices by the response model when Pi recorded one", () => {
    const rows = parsePiUsageLog(jsonl([
      piUserEntry("go"),
      piAssistantEntry({
        model: "firerouter/opus",
        responseModel: "glm-5p2",
        input: 1000,
        output: 10,
      }),
    ]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "glm-5p2", "the model that served, not the slot asked for");
    assert.equal(rows[0].displayModel, "glm-5p2");
  });

  it("counts usage entries (cache warming) as billed calls", () => {
    const rows = parsePiUsageLog(jsonl([
      piUserEntry("go"),
      piAssistantEntry({ input: 10, output: 10 }),
      {
        type: "usage",
        id: "u1",
        parentId: null,
        timestamp: "t",
        kind: "cache_warm",
        provider: "fireworks",
        model: "glm-5p2",
        usage: { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 0, totalTokens: 50_000, cost: { total: 0 } },
      },
    ]));
    assert.equal(rows.length, 2);
    assert.equal(rows[1].cacheRead, 50_000);
    assert.ok(rows[1].cost > 0, "cache warming spends real money");
  });

  it("skips entries that cannot be priced and keeps zero-weight calls for the report filter", () => {
    // Parser keeps zero-weight calls (mirroring the Claude parser); the report
    // level filters them via rowHasUsage.
    const rows = parsePiUsageLog(jsonl([
      piUserEntry("go"),
      piAssistantEntry({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      { type: "usage", kind: "cache_warm", provider: "fireworks", model: "glm-5p2", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { type: "message", id: "x", parentId: null, timestamp: "t", message: { role: "assistant", content: "no usage recorded" } },
      { type: "usage", kind: "cache_warm", provider: "fireworks", usage: { input: 1, output: 0 } },
      { type: "model_change", id: "m", parentId: null, timestamp: "t", provider: "fireworks", modelId: "firerouter/opus" },
    ]));
    assert.equal(rows.length, 2, "zero-weight assistant + zero-weight usage entry; the model-less usage entry is skipped");
    const report = piUsageReportFromText("x.jsonl", jsonl([
      piUserEntry("go"),
      piAssistantEntry({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]));
    assert.equal(report.requests, 0, "the report filters zero-weight rows");
  });

  it("counts abandoned-branch calls — every entry in the file was billed", () => {
    const rows = parsePiUsageLog(jsonl([
      piUserEntry("go", "e0"),
      { ...piAssistantEntry({ id: "e1", parentId: "e0", responseId: "r1", input: 100, output: 10 }), parentId: "e0" },
      piUserEntry("other direction", "e2"),
      piAssistantEntry({ id: "e3", parentId: "e2", responseId: "r2", input: 200, output: 20 }),
    ]));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].input, 100);
    assert.equal(rows[1].input, 200);
  });

  it("builds a Claude-report-shaped report with grand-total aliases", () => {
    const report = piUsageReportFromText("/tmp/x.jsonl", jsonl([
      piSessionEntry(),
      { type: "session_info", id: "n", parentId: null, timestamp: "t", name: "Named session" },
      piUserEntry("go"),
      piAssistantEntry({ input: 48_030, cacheRead: 8, output: 11 }),
      piAssistantEntry({ id: "e2", responseId: "r2", model: "glm-5p2-flash", input: 100, output: 10 }),
    ]), { includeSessionName: true });
    assert.equal(report.requests, 2);
    assert.equal(report.sessionName, "Named session");
    assert.deepEqual(report.subagents, []);
    assert.equal(report.grandRequests, report.requests);
    assert.equal(report.grandTotals.cost, report.totals.cost);
    const perModel = new Set(report.rows.map((row) => row.displayModel));
    assert.deepEqual([...perModel].sort(), ["glm-5p2", "glm-5p2-flash"]);
  });

  it("prices with real Fireworks rates end to end", () => {
    const spec = FIREWORKS_STANDARD_PRICING["glm-5p2"];
    assert.ok(spec, "test needs a model with known built-in rates");
    const input = 200_000;
    const cacheRead = 400_000;
    const output = 1_000;
    const rows = parsePiUsageLog(jsonl([
      piUserEntry("go"),
      piAssistantEntry({ model: "accounts/fireworks/models/glm-5p2", responseModel: "", input, cacheRead, output }),
    ]));
    const expected = (input * spec.input + cacheRead * spec.cachedInput + output * spec.output) / 1_000_000;
    assert.equal(rows[0].cost, expected);
  });

  it("formats a plain report with per-model rows and a total", () => {
    const report = piUsageReportFromText("/tmp/repo/2026-01-01T00-00-00-000Z_deadbeef-0000-4000-8000-000000000000.jsonl", jsonl([
      piUserEntry("go"),
      piAssistantEntry({ input: 1_000, cacheRead: 20_000, output: 100 }),
      piAssistantEntry({ id: "e2", responseId: "r2", model: "glm-5p3-flash", responseModel: "glm-5p3-flash", input: 100, output: 10 }),
    ]));
    const text = formatPiUsageReport(report);
    assert.match(text, /^Pi session: 2026-01-01T00-00-00-000Z_deadbeef/);
    assert.match(text, /glm-5p2: 1 calls · in 1,000 · cached 20,000 · out 100 · \$/);
    assert.match(text, /glm-5p3-flash: 1 calls · in 100 · cached 0 · out 10 · \$/);
    assert.match(text, /total: 2 calls · in 1,100 · cached 20,000 · out 110 · \$/);
  });
});

describe("findPiSessionLogs", () => {
  async function seededHome() {
    const home = await tempHome();
    const projectDir = path.join(home, PI_SESSIONS_RELATIVE_DIR, "--Users-x-repo--");
    await mkdir(projectDir, { recursive: true });
    const newest = path.join(projectDir, `2026-10-05T05-31-03-648Z_${UUID}.jsonl`);
    const older = path.join(projectDir, `2026-10-01T00-00-00-000Z_ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl`);
    // Write order sets mtime; write the older log first so `newest` sorts first.
    await writeFile(older, jsonl([piUserEntry("older"), piAssistantEntry()]));
    await writeFile(newest, jsonl([piUserEntry("newest"), piAssistantEntry()]));
    return { home, projectDir, newest, older };
  }

  it("lists sessions newest first and honors lastN", async () => {
    const { home, newest, older } = await seededHome();
    assert.deepEqual(await listPiSessionLogPaths(home), [newest, older], "newest first");
    assert.equal((await findPiSessionLogs({ home, lastN: 1 }))[0], newest);
    assert.equal((await findPiSessionLogs({ home, lastN: 2 })).length, 2);
  });

  it("matches by uuid suffix, full basename, and substring", async () => {
    const { home, newest } = await seededHome();
    assert.equal(await findPiSessionLog({ home, session: UUID }), newest);
    assert.equal(await findPiSessionLog({ home, session: piSessionFileName() }), newest, "full basename with extension");
    assert.equal(await findPiSessionLog({ home, session: piSessionFileName().replace(/\.jsonl$/, "") }), newest, "full basename without extension");
    assert.equal(await findPiSessionLog({ home, session: "aaaaaaaa" }), newest, "prefix of the uuid matches");
  });

  it("prefers a suffix match over a fuzzy one", async () => {
    const { home, projectDir } = await seededHome();
    const sibling = path.join(projectDir, `2026-10-06T00-00-00-000Z_x-${UUID.slice(0, 8)}xxxx-4xxx-8xxx-xxxxxxxxxxxx.jsonl`);
    await writeFile(sibling, jsonl([piUserEntry("sibling")]));
    // `newest` (mtime later) fuzzy-contains the needle; the suffix rule still wins.
    assert.equal(await findPiSessionLog({ home, session: UUID }), path.join(projectDir, piSessionFileName()));
  });

  it("throws a typed error when the store is empty", async () => {
    const home = await tempHome();
    await assert.rejects(
      () => findPiSessionLogs({ home }),
      (error) => error instanceof NoPiSessionLogsError,
    );
  });

  it("throws on an unknown session needle", async () => {
    const { home } = await seededHome();
    await assert.rejects(
      () => findPiSessionLogs({ home, session: "no-such-session" }),
      /No Pi session log matching 'no-such-session'/,
    );
  });

  it("resolves an explicit session path", async () => {
    const { home, newest } = await seededHome();
    assert.deepEqual(await findPiSessionLogs({ home, session: newest }), [newest]);
  });

  it("keeps only sessions touched inside the window", async () => {
    const { home, newest, older } = await seededHome();
    const fourDaysAgo = (Date.now() - 4 * 86_400_000) / 1000;
    await utimes(newest, fourDaysAgo, fourDaysAgo);
    await utimes(older, fourDaysAgo, fourDaysAgo);
    assert.deepEqual(await findPiSessionLogs({ home, withinDays: 3, lastN: 100 }), []);
  });

  it("reads a report and a report group", async () => {
    const { home, newest } = await seededHome();
    const report = await readPiUsage({ home, session: newest });
    assert.ok(report.requests >= 1);
    assert.ok(report.totals.cost > 0);
    const group = await readPiUsages({ home, lastN: 2 });
    assert.equal(group.sessionCount, 2);
    assert.ok(group.grandTotals.cost > 0);
  });

  it("snapshots an empty store without throwing", async () => {
    const home = await tempHome();
    const snapshot = await snapshotPiSessionLogs(home);
    assert.deepEqual(snapshot.logs, []);
  });
});
