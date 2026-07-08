import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeClaudeUsageCost,
  findClaudeSessionLog,
  findClaudeSessionLogs,
  formatClaudeUsageReport,
  formatClaudeUsageReports,
  parseClaudeUsageLog,
  readClaudeUsage,
  readClaudeUsages,
} from "../lib/claude-usage.mjs";
import { runFireconnect } from "./helpers.mjs";

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("claude usage", () => {
  it("dedupes repeated assistant log lines by message id", () => {
    const text = jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 48_030, cache_read_input_tokens: 8, output_tokens: 11 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 48_030, cache_read_input_tokens: 8, output_tokens: 11 },
        },
      },
    ]);

    const rows = parseClaudeUsageLog(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].displayModel, "glm-5p2");
    assert.equal(rows[0].input, 48_030);
  });

  it("computes Anthropic cache write, cache read, geo, batch, and web-search costs", () => {
    const row = computeClaudeUsageCost("claude-opus-4-8", {
      input_tokens: 100,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 300,
      },
      cache_read_input_tokens: 400,
      output_tokens: 500,
      inference_geo: "us",
      service_tier: "batch",
      server_tool_use: { web_search_requests: 2 },
    });

    const tokenCost = (100 * 5 + 200 * 6.25 + 300 * 10 + 400 * 0.5 + 500 * 25) / 1_000_000;
    const expected = tokenCost * 1.1 * 0.5 + 0.02;
    assert.ok(Math.abs(row.cost - expected) < 1e-12);
  });

  it("finds newest top-level session logs under ~/.claude and ignores subagent logs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sessionDir = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    await mkdir(path.join(sessionDir, "subagents"), { recursive: true });
    const older = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl");
    const newer = path.join(home, ".claude", "sessions", "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl");
    const subagent = path.join(sessionDir, "subagents", "agent-newer.jsonl");
    await writeFile(older, "\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mkdir(path.dirname(newer), { recursive: true });
    await writeFile(newer, "\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(subagent, "\n");

    assert.equal(await findClaudeSessionLog({ home }), newer);
    assert.equal(await findClaudeSessionLog({ home, session: "aaaaaaaa" }), older);
    assert.equal(await findClaudeSessionLog({ home, session: older }), older);
  });

  it("does not treat a bare session id prefix as a local file path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-prefix-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionLog = path.join(projectDir, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl");
    await writeFile(sessionLog, "\n");

    const cwd = await mkdtemp(path.join(os.tmpdir(), "fc-usage-cwd-"));
    const localConflict = path.join(cwd, "aaaaaaaa");
    const localJsonl = path.join(cwd, "local.jsonl");
    await writeFile(localConflict, "\n");
    await writeFile(localJsonl, "\n");

    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      assert.equal(await findClaudeSessionLog({ home, session: "aaaaaaaa" }), sessionLog);
      assert.equal(path.basename(await findClaudeSessionLog({ home, session: "local.jsonl" })), "local.jsonl");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("reads and formats the latest N parent session logs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-last-n-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });

    const oldest = path.join(projectDir, "11111111-1111-4111-9111-111111111111.jsonl");
    const middle = path.join(projectDir, "22222222-2222-4222-9222-222222222222.jsonl");
    const newest = path.join(projectDir, "33333333-3333-4333-9333-333333333333.jsonl");
    await writeFile(oldest, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_oldest",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(middle, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_middle",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(newest, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_newest",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 0, output_tokens: 1_000_000 },
        },
      },
    ]));

    assert.deepEqual(await findClaudeSessionLogs({ home, lastN: 2 }), [newest, middle]);

    const reportGroup = await readClaudeUsages({ home, lastN: 2 });
    assert.equal(reportGroup.sessions.length, 2);
    assert.equal(reportGroup.lastN, 2);
    assert.equal(reportGroup.requestedLastN, 2);
    assert.equal(reportGroup.grandRequests, 2);
    assert.ok(Math.abs(reportGroup.grandTotals.cost - 5.8) < 1e-12);

    const text = formatClaudeUsageReports(reportGroup);
    assert.match(text, /================ start session 33333333-3333-4333-9333-333333333333 ================/);
    assert.match(text, /================ end session 33333333-3333-4333-9333-333333333333 ================/);
    assert.match(text, /================ start session 22222222-2222-4222-9222-222222222222 ================/);
    assert.match(text, /================ end session 22222222-2222-4222-9222-222222222222 ================/);
    assert.doesNotMatch(text, /11111111-1111-4111-9111-111111111111/);
    assert.match(text, /Session totals for last 2 sessions:/);
    assert.match(text, /Session\s+\|\s+Calls\s+\|\s+Input\s+\|\s+Output\s+\|\s+Cost \(USD\)/);
    assert.match(text, /33333333-3333-4333-9333-333333333333\s+\|\s+1\s+\|\s+0\s+\|\s+1,000,000\s+\|\s+4\.40/);
    assert.match(text, /22222222-2222-4222-9222-222222222222\s+\|\s+1\s+\|\s+1,000,000\s+\|\s+0\s+\|\s+1\.40/);
    assert.match(text, /\+-+\+-+\+-+\+-+\+-+\+\n\| GRAND TOTAL/);
    assert.match(text, /GRAND TOTAL\s+\|\s+2\s+\|\s+1,000,000\s+\|\s+1,000,000\s+\|\s+5\.80/);

    const tooMany = await readClaudeUsages({ home, lastN: 5 });
    assert.equal(tooMany.sessions.length, 3);
    assert.equal(tooMany.lastN, 3);
    assert.equal(tooMany.requestedLastN, 5);

    const narrowed = await readClaudeUsages({ home, session: "33333333", lastN: 5 });
    assert.equal(narrowed.sessions.length, 1);
    assert.equal(narrowed.lastN, 1);
    assert.equal(narrowed.requestedLastN, 5);
  });

  it("omits latest sessions and rows with no usage data", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-empty-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });

    const withData = path.join(projectDir, "11111111-1111-4111-9111-111111111111.jsonl");
    const zeroData = path.join(projectDir, "22222222-2222-4222-9222-222222222222.jsonl");
    const empty = path.join(projectDir, "33333333-3333-4333-9333-333333333333.jsonl");
    await writeFile(withData, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_with_data",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_zero",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(zeroData, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_zero_session",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(empty, "\n");

    const reportGroup = await readClaudeUsages({ home, lastN: 3 });
    assert.equal(reportGroup.sessions.length, 1);
    assert.equal(reportGroup.sessions[0].path, withData);
    assert.equal(reportGroup.sessions[0].requests, 1);
    assert.equal(reportGroup.lastN, 1);
    assert.equal(reportGroup.requestedLastN, 3);

    const text = formatClaudeUsageReports(reportGroup);
    assert.match(text, /11111111-1111-4111-9111-111111111111/);
    assert.doesNotMatch(text, /22222222-2222-4222-9222-222222222222/);
    assert.doesNotMatch(text, /33333333-3333-4333-9333-333333333333/);
  });

  it("formats a summary text report by default", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-report-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const logPath = path.join(projectDir, "12345678-1234-4234-9234-123456789abc.jsonl");
    await writeFile(logPath, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 3_000 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_2",
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]));

    const report = await readClaudeUsage({ home, session: "12345678" });
    const text = formatClaudeUsageReport(report);
    assert.match(text, /Cost estimate:/);
    assert.match(text, /Fireworks-served model estimate per request/);
    assert.match(text, /Reference: https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
    assert.match(text, /Anthropic model usage is fetched from session logs; estimated cost is calculated from local rates/);
    assert.match(text, /\*\*\*All pricing shown below are estimates based on token usage/);
    assert.match(text, /Session log:/);
    assert.match(text, /Usage summary:/);
    assert.match(text, /Parent\/Sub-agent ID\s+\|\s+Model\s+\|\s+Calls\s+\|\s+Input\s+\|\s+Output\s+\|\s+Cost \(USD\)/);
    assert.match(text, /Parent\s+\|\s+accounts\/fireworks\/models\/glm-5p2\s+\|\s+1\s+\|\s+1,000\s+\|\s+3,000/);
    assert.match(text, /Parent\s+\|\s+claude-opus-4-8\s+\|\s+1\s+\|\s+2\s+\|\s+4/);
    const parentGlmRow = text.match(/\| Parent\s+\| accounts\/fireworks\/models\/glm-5p2/);
    const parentOpusRow = text.match(/\| Parent\s+\| claude-opus-4-8/);
    assert.ok(parentGlmRow.index < parentOpusRow.index);
    assert.doesNotMatch(text, /Role/);
    assert.doesNotMatch(text, /Parent session model served/);
    assert.doesNotMatch(text, /Grand total usage summary:/);
    assert.doesNotMatch(text, /Rates used for models in this session/);
    assert.match(text, /\+-+\+-+\+-+\+-+\+-+\+-+\+\n\| TOTAL/);
    assert.match(text, /TOTAL/);
    assert.match(text, /Grand requests: 2/);
  });

  it("formats a verbose text report with request-level rows and rates", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-verbose-report-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const logPath = path.join(projectDir, "12345678-1234-4234-9234-123456789abc.jsonl");
    await writeFile(logPath, jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 3_000 },
        },
      },
    ]));

    const report = await readClaudeUsage({ home, session: "12345678" });
    const text = formatClaudeUsageReport(report, { verbose: true });
    assert.match(text, /Session log:/);
    assert.match(text, /Cost estimate:/);
    assert.match(text, /Reference: https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing/);
    assert.match(text, /Fireworks-served model estimate per request/);
    assert.match(text, /Anthropic model usage is fetched from session logs; estimated cost is calculated from local rates/);
    assert.match(text, /\*\*\*All pricing shown below are estimates based on token usage/);
    assert.match(text, /Usage columns:/);
    assert.match(text, /Request #: request number within this section/);
    assert.match(text, /Input: non-cached input tokens billed at the input rate/);
    assert.match(text, /5m Cache Write: input tokens written to a five-minute prompt cache/);
    assert.match(text, /Cost \(USD\): estimated cost for that request/);
    assert.match(text, /Rates used for models in this session/);
    assert.doesNotMatch(text, /inference_geo/);
    assert.doesNotMatch(text, /Web search requests add/);
    assert.match(text, /glm-5p2/);
    assert.match(text, /\$1\.4\s+\|\s+-\s+\|\s+-\s+\|\s+\$0\.14\s+\|\s+\$4\.4/);
    assert.doesNotMatch(text, /glm-5p2-fast/);
    assert.match(text, /Request #\s+\|\s+Model/);
    assert.match(text, /Requests: 1/);
  });

  it("adds subagent sections for child agent logs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-subagent-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sessionId = "12345678-1234-4234-9234-123456789abc";
    await mkdir(path.join(projectDir, sessionId, "subagents"), { recursive: true });
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_parent",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 3_000 },
        },
      },
    ]));
    await writeFile(path.join(projectDir, sessionId, "subagents", "agent-alpha.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_child",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
      {
        type: "assistant",
        message: {
          id: "msg_child_2",
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]));
    await writeFile(path.join(projectDir, sessionId, "subagents", "agent-empty.jsonl"), "\n");
    await writeFile(path.join(projectDir, sessionId, "subagents", "agent-zero.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_zero_child",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]));

    const report = await readClaudeUsage({ home, session: "12345678" });
    assert.equal(report.subagents.length, 1);
    assert.equal(report.subagents[0].id, "alpha");
    assert.equal(report.grandRequests, 3);
    assert.ok(report.grandTotals.cost > report.totals.cost);

    const text = formatClaudeUsageReport(report);
    assert.doesNotMatch(text, /---- sub-agent alpha ----/);
    assert.doesNotMatch(text, /sub-agent empty/);
    assert.doesNotMatch(text, /sub-agent zero/);
    assert.match(text, /accounts\/fireworks\/models\/glm-5p2/);
    assert.match(text, /alpha\s+\|\s+claude-haiku-4-5\s+\|\s+1\s+\|\s+10\s+\|\s+20/);
    assert.match(text, /alpha\s+\|\s+claude-opus-4-8\s+\|\s+1\s+\|\s+2\s+\|\s+4/);
    const parentRow = text.match(/\| Parent\s+\| accounts\/fireworks\/models\/glm-5p2/);
    const haikuRow = text.match(/\| alpha\s+\| claude-haiku-4-5/);
    const opusRow = text.match(/\| alpha\s+\| claude-opus-4-8/);
    assert.ok(parentRow.index < haikuRow.index);
    assert.ok(haikuRow.index < opusRow.index);
    assert.doesNotMatch(text, /Sub-agent usage summary:/);
    assert.doesNotMatch(text, /Grand total usage summary:/);
    assert.doesNotMatch(text, /Sub-agent model usage/);
    assert.doesNotMatch(text, /Sub-agent total cost:/);
    assert.doesNotMatch(text, /Grand total cost:/);
  });

  it("is exposed through fireconnect claude usage --json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-cli-"));
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "9b86bac5-1234-4234-9234-123456789abc.jsonl"), jsonl([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ]));

    const result = await runFireconnect(["claude", "usage", "--session", "9b86", "--json"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.requests, 1);
    assert.equal(parsed.rows[0].model, "claude-opus-4-8");
    assert.equal(parsed.rows[0].rates.inputPerMillion, 5);
  });
});
