/**
 * Live-meter billing accuracy: one row per API call, priced from the richest
 * usage payload Claude Code wrote for it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  Dashboard,
  ModelIndex,
  agentPaneWorthShowing,
  applyMeterStyle,
  runUsageMeter,
  syncAgentPane,
} from "../../../../lib/harnesses/claude/usage/meter.mjs";
import {
  formatUsageCachePct,
  roundCachePct,
} from "../../../../lib/harnesses/claude/usage/format.mjs";
import {
  COST_COL,
  money,
} from "../../../../lib/harnesses/claude/usage/meter-layout.mjs";

/** Render `entries` (raw JSONL records) through the meter and return the frame. */
async function render(entries, { columns = 130, readPeers, agentLabel = "Main" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-acc-"));
  try {
    const log = path.join(dir, "s.jsonl");
    fs.writeFileSync(log, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

    let text = "";
    const stream = {
      isTTY: false,
      columns,
      rows: 40,
      write(chunk) {
        text += String(chunk);
        return true;
      },
    };
    await runUsageMeter({
      filePath: log,
      plain: true,
      fromStart: true,
      follow: false,
      stream,
      agentLabel,
      readPeers,
    });
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Plain-text lines with SGR escapes removed. */
const plainLines = (frame) => frame.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

/** The `TOTAL COST` figure, as a number. */
function totalCost(frame) {
  const line = frame.split("\n").find((l) => l.includes("TOTAL"));
  assert.ok(line, "frame should have a TOTAL line");
  const m = line.match(/\$([0-9.]+)/);
  assert.ok(m, `TOTAL line should carry a cost: ${line}`);
  return Number(m[1]);
}

/**
 * Session spend summed from the TURN ROWS, at full 4-decimal precision.
 *
 * Totals render at 2 decimals, which is right for reading but useless for
 * asserting on cheap calls: two GLM calls and one GLM call can round to the same
 * cents, so a `total(two) > total(one)` check silently stops being able to catch
 * a dropped call. Turn rows keep 4 decimals, so sum those instead.
 */
function turnRowsCost(frame) {
  let sum = 0;
  let found = 0;
  for (const line of plainLines(frame)) {
    // Turn rows start with a status glyph and a number; footer rows start with ●
    // or a label, so anchor on the leading "<glyph> <n>" shape.
    if (!/^\s*[✓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\d+\s/.test(line)) continue;
    const m = line.match(/\$([0-9]+\.[0-9]{4})/);
    if (!m) continue;
    sum += Number(m[1]);
    found += 1;
  }
  assert.ok(found > 0, `expected at least one turn row:\n${frame}`);
  return sum;
}

const assistant = (id, usage, model = "accounts/fireworks/models/glm-5p2") => ({
  type: "assistant",
  message: { id, model, usage },
});

/** Printable width of a rendered cost cell, e.g. "$0.0018" — 4 decimals + "$0.". */
const money0Width = "$0.0018".length;

describe("live meter billing accuracy", () => {
  it("keeps four-decimal totals through $9999 inside the cost column", () => {
    assert.equal(COST_COL, "$1234.5678".length);
    assert.equal(money(1234.5678), "$1234.5678");
  });

  it("prices a call from its richest payload, not the first all-zero block", async () => {
    // Claude Code repeats a message.id across content blocks and attaches usage
    // to the last one. Counting the first billed real work at $0.00.
    const zeroFirst = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant("msg_1", { input_tokens: 7_023, cache_read_input_tokens: 92_799, output_tokens: 361 }),
    ]);

    // Same single call, written as one record — the reference price.
    const singleRecord = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 7_023, cache_read_input_tokens: 92_799, output_tokens: 361 }),
    ]);

    assert.ok(turnRowsCost(zeroFirst) > 0, "must not price a real call at zero");
    assert.equal(turnRowsCost(zeroFirst), turnRowsCost(singleRecord));
  });

  it("counts one call per message id, not one per content block", async () => {
    const frame = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 100, output_tokens: 10 }),
      assistant("msg_1", { input_tokens: 100, output_tokens: 10 }),
      assistant("msg_1", { input_tokens: 100, output_tokens: 10 }),
    ]);

    const once = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 100, output_tokens: 10 }),
    ]);

    assert.equal(turnRowsCost(frame), turnRowsCost(once), "repeats must not multiply cost");
  });

  it("sums distinct calls within one turn", async () => {
    // Token counts large enough that two calls differ well above the footer's
    // 4-decimal resolution, so the comparison isn't fighting rounding.
    const frame = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 1_000_000, output_tokens: 100_000 }),
      assistant("msg_2", { input_tokens: 1_000_000, output_tokens: 100_000 }),
    ]);

    const single = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 1_000_000, output_tokens: 100_000 }),
    ]);

    // Both figures are independently rounded to 4 decimals, so allow one unit
    // of that resolution on each side.
    const delta = Math.abs(turnRowsCost(frame) - 2 * turnRowsCost(single));
    assert.ok(delta <= 2e-4, `two identical calls should cost double: ${turnRowsCost(frame)} vs ${turnRowsCost(single)}`);
  });

  it("omits <synthetic> from the model breakdown and the unpriced list", async () => {
    const frame = await render([
      { type: "user", message: { content: "interrupted" } },
      assistant("msg_s", { input_tokens: 0, output_tokens: 0 }, "<synthetic>"),
      { type: "user", message: { content: "real" } },
      assistant("msg_1", { input_tokens: 500, output_tokens: 50 }),
    ]);

    assert.ok(!frame.includes("synthetic"), "synthetic must not reach the footer");
    assert.ok(!/unpriced/.test(frame), "synthetic must not be reported as unpriced");
    assert.ok(turnRowsCost(frame) > 0);
  });

  it("bills id-less calls in different turns separately", async () => {
    // `seen` lives for the whole session, so a GLOBAL token signature made two
    // id-less calls in different turns collide — and the tie rule keeps the
    // first, so the later call was dropped outright. Two identical billable
    // calls one turn apart lost one.
    const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 0, output_tokens: 100_000 };
    const two = await render([
      { type: "user", message: { content: "first" } },
      { type: "assistant", message: { model: "accounts/fireworks/models/glm-5p2", usage } },
      { type: "user", message: { content: "second" } },
      { type: "assistant", message: { model: "accounts/fireworks/models/glm-5p2", usage } },
    ]);
    const one = await render([
      { type: "user", message: { content: "first" } },
      { type: "assistant", message: { model: "accounts/fireworks/models/glm-5p2", usage } },
    ]);

    const delta = Math.abs(turnRowsCost(two) - 2 * turnRowsCost(one));
    assert.ok(delta <= 2e-4, `both turns must be billed: ${turnRowsCost(two)} vs ${turnRowsCost(one)}`);
  });

  it("still collapses repeated id-less blocks inside one turn", async () => {
    // The signature fallback exists for this case; scoping it per-turn must not
    // break it.
    const usage = { input_tokens: 1_000_000, cache_read_input_tokens: 0, output_tokens: 100_000 };
    const repeated = await render([
      { type: "user", message: { content: "go" } },
      { type: "assistant", message: { model: "accounts/fireworks/models/glm-5p2", usage } },
      { type: "assistant", message: { model: "accounts/fireworks/models/glm-5p2", usage } },
      { type: "assistant", message: { model: "accounts/fireworks/models/glm-5p2", usage } },
    ]);
    const once = await render([
      { type: "user", message: { content: "go" } },
      { type: "assistant", message: { model: "accounts/fireworks/models/glm-5p2", usage } },
    ]);

    assert.equal(turnRowsCost(repeated), turnRowsCost(once), "repeats within a turn are one call");
  });

  it("does not collapse calls that share an empty message id", async () => {
    // `??` would treat "" as a real key and bucket both calls together.
    const frame = await render([
      { type: "user", message: { content: "go" } },
      assistant("", { input_tokens: 1_000, output_tokens: 100 }),
      assistant("", { input_tokens: 2_000, output_tokens: 200 }),
    ]);

    const first = await render([
      { type: "user", message: { content: "go" } },
      assistant("", { input_tokens: 1_000, output_tokens: 100 }),
    ]);

    assert.ok(turnRowsCost(frame) > turnRowsCost(first), "both calls must be billed");
  });

  it("names the disjoint prompt buckets and shows cache writes as a count", async () => {
    // Anthropic's input_tokens is the UNCACHED remainder, so a cached turn
    // legitimately reads uncached 100 / cached 11.8M. The header has to say
    // so, and cache writes bill at 1.25x so they need a column, not just a ratio.
    //
    // The names are borrowed, not invented: Fireworks bills "cached" vs
    // "uncached" tokens, and Anthropic's usage output prints "Cache read tokens"
    // / "Cache write tokens".
    const frame = await render([
      { type: "user", message: { content: "go" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 900,
            cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 200 },
            output_tokens: 50,
          },
        },
      },
    ]);

    const header = frame.split("\n").find((l) => l.includes("cache%"));
    assert.ok(header, "frame should have a column header");
    assert.match(header, /uncached/, "uncached input must not be labelled plain 'input'");
    assert.match(header, /cached/, "cache reads are the discounted bucket");
    assert.match(header, /write/, "cache writes need their own column");
    // Price order: uncached (1x) · cached (0.1x) · cache write (1.25x).
    assert.ok(header.indexOf("uncached") < header.indexOf("write"), "buckets in price order");
    assert.ok(
      header.indexOf("uncached") < header.replace("uncached", "________").indexOf("cached"),
      "uncached comes before the cached column",
    );

    // 700 write tokens (500 + 200) surface as a count on the turn row.
    const row = frame.split("\n").find((l) => / 1 /.test(l) && l.includes("$"));
    assert.ok(row, "frame should have a turn row");
    assert.match(row, /\b700\b/, `cache-write count should appear: ${row}`);
  });

  it("keeps header and turn rows aligned across pane widths", async () => {
    for (const columns of [60, 72, 81, 100, 132]) {
      const frame = await render([
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 1_000, cache_read_input_tokens: 2_000, output_tokens: 100 }),
      ], { columns });

      const lines = frame.split("\n");
      const header = lines.find((l) => l.includes("cache%"));
      const row = lines.find((l) => / 1 /.test(l) && /GLM/.test(l));
      assert.ok(header && row, `width ${columns}: header and row present`);
      // The cost column is the anchor: the header's "cost" label and the row's
      // cost cell must end at the same column, or the numbers read against the
      // wrong headings. A pane too narrow for the fixed columns clips BOTH the
      // header and the row by design — at 60 cols the row is cut before its cost
      // cell — so only assert alignment where both survive.
      const plainRow = row.replace(/\x1b\[[0-9;]*m/g, "");
      if (header.includes("cost") && plainRow.includes("$")) {
        assert.equal(
          header.indexOf("cost") + "cost".length,
          plainRow.indexOf("$") + money0Width,
          `width ${columns}: cost column misaligned\n${header}\n${plainRow}`,
        );
      }
      for (const line of lines) {
        const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
        assert.ok(
          plain.length <= columns,
          `width ${columns}: line overflows pane (${plain.length}): ${plain}`,
        );
      }
    }
  });

  it("splits spend between the tracked agent and its siblings", async () => {
    // The meter tails ONE agent log, so a session whose work happened inside
    // subagents otherwise shows a small total and no clue where money went.
    //
    // Token counts large enough that the tracked agent's own spend is well above
    // the 2-decimal resolution of a summary row: at 1k tokens it rounds to $0.01
    // and the reconciliation check would be measuring rounding, not attribution.
    const frame = await render(
      [
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 2_000_000, output_tokens: 200_000 }),
      ],
      { readPeers: async () => ({ count: 3, calls: 12, cost: 0.5 }) },
    );

    const lines = plainLines(frame);
    const own = lines.find((l) => /^\s+Main\s/.test(l));
    const subs = lines.find((l) => l.includes("subagents"));
    const session = lines.find((l) => l.includes("SESSION COST"));
    assert.ok(own && subs && session, `expected all three summary rows:\n${frame}`);
    assert.match(subs, /3 subagents · 12 calls/);
    assert.match(subs, /\$0\.50/);
    // SESSION must reconcile: own + siblings. Summary rows render at 2 decimals,
    // so each addend carries up to half a cent of rounding — allow one cent of
    // slack rather than demanding exact arithmetic on displayed strings.
    const ownCost = Number(own.match(/\$([0-9.]+)/)[1]);
    const sessionCost = Number(session.match(/\$([0-9.]+)/)[1]);
    assert.ok(
      Math.abs(sessionCost - (ownCost + 0.5)) <= 0.01,
      `${sessionCost} != ${ownCost} + 0.5`,
    );
  });

  it("shows n/a when the tracked agent or a peer has an unpriced call", async () => {
    const unpricedTracked = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }, "accounts/fireworks/models/unknown"),
    ]);
    assert.match(unpricedTracked, /TOTAL COST\s+n\/a/);

    const unpricedPeer = await render(
      [
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
      ],
      { readPeers: async () => ({ count: 1, calls: 1, cost: null }) },
    );
    assert.match(unpricedPeer, /1 subagent · 1 call\s+n\/a/);
    assert.match(unpricedPeer, /SESSION COST\s+n\/a/);
    assert.doesNotMatch(unpricedPeer, /SESSION COST\s+\$0\.00/);

    const unpricedMain = await render(
      [
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
      ],
      {
        agentLabel: "Explore",
        readPeers: async () => ({
          count: 1,
          calls: 1,
          cost: 0.25,
          main: { label: "Main", calls: 1, cost: null },
        }),
      },
    );
    assert.match(unpricedMain, /Main · 1 call\s+n\/a/);
    assert.match(unpricedMain, /SESSION COST\s+n\/a/);
  });

  it("reports Main on its own row rather than as a subagent", async () => {
    // While tracking a subagent, Main is usually the largest spend in the
    // session. Folding it into "N subagents" inflated that count and filed the
    // cost under the wrong kind of agent.
    const frame = await render(
      [
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
      ],
      {
        agentLabel: "Explore · find things",
        readPeers: async () => ({
          count: 3,
          calls: 12,
          cost: 0.5,
          main: { label: "Main", calls: 40, cost: 9 },
        }),
      },
    );

    const lines = plainLines(frame);
    const mainRow = lines.find((l) => /^\s+Main · 40 calls/.test(l));
    const subRow = lines.find((l) => l.includes("subagents"));
    assert.ok(mainRow, `Main should have its own row:\n${frame}`);
    assert.match(mainRow, /\$9\.00/);
    assert.match(subRow, /3 subagents · 12 calls/, "Main must not inflate the subagent count");
    assert.match(subRow, /\$0\.50/, "Main's cost must not land in the subagent row");

    // SESSION COST still reconciles: tracked + Main + subagents.
    const own = Number(lines.find((l) => /Explore/.test(l)).match(/\$([0-9.]+)/)[1]);
    const session = Number(lines.find((l) => l.includes("SESSION COST")).match(/\$([0-9.]+)/)[1]);
    // One cent of slack: three 2-decimal addends against a 2-decimal total.
    assert.ok(
      Math.abs(session - (own + 9 + 0.5)) <= 0.01,
      `${session} != ${own} + 9 + 0.5`,
    );
  });

  it("omits the subagent row when Main is the only sibling", async () => {
    const frame = await render(
      [
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
      ],
      {
        agentLabel: "Explore",
        readPeers: async () => ({
          count: 0,
          calls: 0,
          cost: 0,
          main: { label: "Main", calls: 5, cost: 2 },
        }),
      },
    );

    assert.doesNotMatch(frame, /subagent/, "no subagents means no subagent row");
    assert.match(frame, /Main · 5 calls/);
    assert.match(frame, /SESSION COST/);
  });

  it("keeps the plain TOTAL row when there are no sibling agents", async () => {
    const noPeers = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
    ]);
    assert.match(noPeers, /TOTAL COST/);
    assert.doesNotMatch(noPeers, /SESSION COST/);

    // A session that reports zero siblings behaves the same way.
    const zero = await render(
      [
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
      ],
      { readPeers: async () => ({ count: 0, calls: 0, cost: 0 }) },
    );
    assert.match(zero, /TOTAL COST/);
    assert.doesNotMatch(zero, /SESSION COST/);
  });

  it("right-aligns summary costs with the model rows at any width", async () => {
    for (const columns of [60, 72, 100, 140]) {
      const frame = await render(
        [
          { type: "user", message: { content: "go" } },
          assistant("msg_1", { input_tokens: 1_000_000, output_tokens: 100_000 }),
        ],
        {
          columns,
          agentLabel: "Explore",
          // All four summary rows at once: tracked agent, Main, subagents, total.
          readPeers: async () => ({
            count: 13,
            calls: 149,
            cost: 0.8729,
            main: { label: "Main", calls: 40, cost: 12.5 },
          }),
        },
      );

      const lines = plainLines(frame).filter((l) => l.trim());
      const model = lines.find((l) => l.includes("●"));
      const summaries = lines.filter(
        (l) => /Explore|Main · |subagents|SESSION COST/.test(l) && !l.includes("●"),
      );
      assert.ok(model && summaries.length === 4, `width ${columns}: rows present`);
      for (const line of summaries) {
        assert.equal(
          line.length,
          model.length,
          `width ${columns}: summary cost not aligned with model row\n${model}\n${line}`,
        );
      }
    }
  });

  it("survives a peer lookup that fails", async () => {
    // Sibling spend is best-effort; a failed read must not break the frame.
    const frame = await render(
      [
        { type: "user", message: { content: "go" } },
        assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
      ],
      { readPeers: async () => { throw new Error("subagent dir vanished"); } },
    );
    assert.match(frame, /TOTAL COST/);
    assert.match(frame, /\$0\./);
  });

  it("attributes a revised payload to the turn that opened the call", async () => {
    // The richer record can arrive after the next prompt starts a new turn;
    // the cost belongs to the turn that made the call.
    const frame = await render([
      { type: "user", message: { content: "first prompt" } },
      assistant("msg_1", { input_tokens: 0, output_tokens: 0 }),
      { type: "user", message: { content: "second prompt" } },
      assistant("msg_1", { input_tokens: 4_000, output_tokens: 400 }),
    ]);

    const rows = frame.split("\n").filter((l) => /first prompt|second prompt/.test(l));
    assert.equal(rows.length, 2, "both prompts should render as turns");
    const firstRow = rows.find((l) => l.includes("first prompt"));
    assert.ok(!/\$0\.0000/.test(firstRow), `cost should land on turn 1: ${firstRow}`);
  });

  it("shows full footer model names so Flash does not collide with GLM 5.3", async () => {
    const usage = { input_tokens: 0, cache_read_input_tokens: 16_300, output_tokens: 3 };
    const frame = await render([
      { type: "user", message: { content: "go" } },
      assistant("a", usage, "accounts/fireworks/models/glm-5p3"),
      assistant("b", usage, "accounts/fireworks/models/glm-5p3-flash"),
    ]);

    const footer = plainLines(frame).filter((l) => l.includes("●"));
    assert.equal(footer.length, 2, `expected two model rows:\n${frame}`);
    assert.ok(footer.some((l) => /● GLM 5\.3 Flash/.test(l)), `flash label missing:\n${footer.join("\n")}`);
    assert.ok(
      footer.some((l) => /● GLM 5\.3\s+\d/.test(l) && !/Flash/.test(l)),
      `base GLM 5.3 row missing:\n${footer.join("\n")}`,
    );
  });

  it("drops an empty footer bucket when revision moves spend to another model", async () => {
    const usage = { input_tokens: 0, cache_read_input_tokens: 16_300, output_tokens: 3 };
    const zero = { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    const frame = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", zero, "accounts/fireworks/models/glm-5p3-flash"),
      assistant("msg_1", usage, "accounts/fireworks/models/glm-5p3"),
    ]);

    const footer = plainLines(frame).filter((l) => l.includes("●"));
    assert.equal(footer.length, 1, `orphan flash bucket should be gone:\n${frame}`);
    assert.match(footer[0], /GLM 5\.3/);
    assert.doesNotMatch(footer[0], /Flash/);
  });

  it("restarts cleanly when the log is truncated and rewritten", async () => {
    // Keeping the old byte offset skipped the head of the new content, so turns
    // written before that offset never appeared and stale turns lingered.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-trunc-"));
    try {
      const log = path.join(dir, "s.jsonl");
      const line = (o) => `${JSON.stringify(o)}\n`;
      fs.writeFileSync(
        log,
        line({ type: "user", message: { content: "OLD SESSION" } })
        + line(assistant("old_1", { input_tokens: 900_000, output_tokens: 90_000 })),
      );

      let text = "";
      const stream = {
        isTTY: false,
        columns: 130,
        rows: 40,
        write(chunk) { text += String(chunk); return true; },
      };
      const controller = new AbortController();
      let polls = 0;
      await runUsageMeter({
        filePath: log,
        plain: true,
        fromStart: true,
        follow: true,
        pollMs: 0,
        stream,
        signal: controller.signal,
        sleep: async () => {
          polls += 1;
          if (polls === 1) {
            // Rewrite shorter than the current offset.
            fs.writeFileSync(
              log,
              line({ type: "user", message: { content: "NEW SESSION" } })
              + line(assistant("new_1", { input_tokens: 1_000, output_tokens: 100 })),
            );
            return;
          }
          if (polls >= 4) controller.abort();
        },
      });

      // Totals prove the rewrite was read from byte 0 AND that the stale tally
      // was dropped: the new log's single 1k call prices well under a dollar,
      // whereas the old 900k call alone was ~$1.65. (In plain+follow mode only
      // completed turns print a row, so assert on the footer, not the prompt.)
      const total = totalCost(text);
      assert.ok(total > 0, "the rewritten log's head must not be skipped");
      assert.ok(total < 1, `stale turns should be dropped: $${total}`);
      assert.doesNotMatch(text, /OLD SESSION/, "old turns must not linger");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("alternate screen buffer", () => {
  /** Run the meter over a TTY-ish stream and return everything written. */
  async function fullscreenWrites() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-alt-"));
    const prevNoColor = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    try {
      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = "1";
      const log = path.join(dir, "s.jsonl");
      fs.writeFileSync(log, [
        JSON.stringify({ type: "user", message: { content: "go" } }),
        JSON.stringify(assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 })),
      ].join("\n") + "\n");

      let text = "";
      await runUsageMeter({
        filePath: log,
        fromStart: true,
        follow: false,
        stream: { isTTY: true, columns: 120, rows: 30, write(c) { text += String(c); return true; } },
        agentLabel: "Main",
      });
      return text;
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
      if (prevForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForce;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("enters on start and leaves on exit so frames don't fill scrollback", async () => {
    // The meter repaints the whole frame every poll. On the normal buffer each
    // repaint scrolls into history — a few seconds of tailing added ~1000 lines
    // and the pane became an endless canvas of stale frames.
    const text = await fullscreenWrites();
    const enter = text.indexOf("[?1049h");
    const exit = text.lastIndexOf("[?1049l");
    assert.ok(enter >= 0, "must enter the alternate screen");
    assert.ok(exit > enter, "must leave it again on the way out");
    // Cursor comes back before the buffer switch, so the shell isn't left blind.
    assert.ok(text.lastIndexOf("[?25h") <= exit, "show cursor at/ before exit");
  });

  it("stays on the normal buffer in plain mode", async () => {
    // Plain output is meant to be piped or scrolled; switching buffers would
    // hide it entirely.
    const text = await render([
      { type: "user", message: { content: "go" } },
      assistant("msg_1", { input_tokens: 1_000, output_tokens: 100 }),
    ]);
    assert.ok(!text.includes("[?1049h"), "plain mode must not switch buffers");
  });
});

describe("model badge column", () => {
  it("never exceeds its 8-column field, however many models a turn used", () => {
    // turnRow pads with `8 - blen`, which floors at 0, so an over-wide badge
    // shifted every numeric column left of its heading. blen must also match
    // the real printable width or the padding is wrong by that difference.
    applyMeterStyle(false);
    const db = new Dashboard("/tmp/s.jsonl", new ModelIndex(), {
      fullscreen: false,
      stream: { columns: 130, rows: 40, write() { return true; } },
    });

    for (const n of [1, 2, 3, 5, 9, 15]) {
      const models = Array.from({ length: n }, (_, i) => `Model${i + 1}`);
      const [badges, blen] = db.badges({ models });
      const plain = badges.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(blen, plain.length, `${n} models: reported width must match rendered`);
      assert.ok(blen <= 8, `${n} models: badge overflows the column (${blen}): ${plain}`);
    }
  });

  it("clears sibling spend on reset so it can't outlive its session", () => {
    // A truncation reset drops the session's turns; leaving `peers` would
    // attribute the old session's subagent cost to the new one until the next
    // refresh, up to peersMs later.
    applyMeterStyle(false);
    const db = new Dashboard("/tmp/s.jsonl", new ModelIndex(), {
      fullscreen: false,
      stream: { columns: 130, rows: 40, write() { return true; } },
    });
    db.peers = { count: 3, calls: 5, cost: 1.5 };
    db.reset();
    assert.equal(db.peers, null);
  });

  it("marks dropped models with a trailing +", () => {
    applyMeterStyle(false);
    const db = new Dashboard("/tmp/s.jsonl", new ModelIndex(), {
      fullscreen: false,
      stream: { columns: 130, rows: 40, write() { return true; } },
    });
    const [badges] = db.badges({ models: Array.from({ length: 9 }, (_, i) => `Model${i + 1}`) });
    assert.match(badges.replace(/\x1b\[[0-9;]*m/g, ""), /\+$/);
  });
});


describe("cache% never claims a perfect hit it didn't get", () => {
  it("shows 99%, not 100%, when fresh tokens were still billed", () => {
    // Real numbers from a session log: 81 fresh + 21,685,390 read + 31,887 write
    // is 99.85%, which Math.round reported as "100%" — asserting nothing was
    // billed at the full prompt rate while three buckets were.
    assert.equal(
      formatUsageCachePct({ input: 81, cacheRead: 21_685_390, cacheWrite: 31_887 }),
      "99%",
    );
    assert.equal(roundCachePct(0.9985), 99);
    assert.equal(roundCachePct(0.999999), 99);
  });

  it("reserves 100% for a prompt served entirely from cache", () => {
    assert.equal(formatUsageCachePct({ input: 0, cacheRead: 1000, cacheWrite: 0 }), "100%");
    assert.equal(roundCachePct(1), 100);
  });

  it("shows 1%, not 0%, when the cache did return tokens", () => {
    // The same lie at the other end: "0%" reads as "the cache did nothing".
    assert.equal(roundCachePct(0.0001), 1);
    assert.equal(formatUsageCachePct({ input: 1_000_000, cacheRead: 1, cacheWrite: 0 }), "1%");
  });

  it("shows 0% only for a genuinely cold prompt", () => {
    assert.equal(formatUsageCachePct({ input: 1000, cacheRead: 0, cacheWrite: 0 }), "0%");
    assert.equal(roundCachePct(0), 0);
  });

  it("caps the meter's own cache% column the same way", async () => {
    const frame = await render([
      { type: "user", message: { content: "well cached" } },
      assistant("msg_1", {
        input_tokens: 81,
        cache_read_input_tokens: 21_685_390,
        cache_creation_input_tokens: 31_887,
        output_tokens: 100,
      }),
    ]);
    // The cache% cell sits between the cwrite and out columns, so anchor on
    // "31.9k" (cwrite) and read the next percentage. The footer's share column
    // legitimately reads 100% when one model is the session's only spend, so a
    // bare /100%/ search would flag that instead.
    const rows = plainLines(frame).filter((l) => l.includes("31.9k"));
    assert.ok(rows.length >= 2, `expected turn + footer rows:\n${frame}`);
    for (const row of rows) {
      const cache = row.slice(row.indexOf("31.9k")).match(/(\d+)%/);
      assert.ok(cache, `row should carry a cache%: ${row}`);
      assert.equal(cache[1], "99", `cache% must not claim a perfect hit:\n${frame}`);
    }
  });
});

describe("idle vs working", () => {
  /** Fullscreen frame text for `entries`, following once. */
  async function frameOf(entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-idle-"));
    const prevNoColor = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    try {
      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = "1";
      const log = path.join(dir, "s.jsonl");
      fs.writeFileSync(log, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
      let text = "";
      await runUsageMeter({
        filePath: log,
        fromStart: true,
        follow: false,
        stream: { isTTY: true, columns: 120, rows: 30, write(c) { text += String(c); return true; } },
        agentLabel: "Main",
      });
      return text.replace(/\[[0-9;]*[A-Za-z]/g, "");
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
      if (prevForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForce;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const withStop = (id, usage, stop) => ({
    type: "assistant",
    message: { id, model: "accounts/fireworks/models/glm-5p2", usage, stop_reason: stop },
  });

  it("says idle once the model has stopped, instead of spinning forever", async () => {
    // A turn used to be marked done only when the NEXT prompt arrived, so on an
    // idle session the spinner never stopped and finished work looked hung.
    const frame = await frameOf([
      { type: "user", message: { content: "all done" } },
      withStop("msg_1", { input_tokens: 1000, output_tokens: 50 }, "end_turn"),
    ]);
    assert.match(frame, /idle/, `expected an idle marker:\n${frame}`);
    assert.ok(!/working/.test(frame), "must not claim to be working");
  });

  it("still says working while a tool call is in flight", async () => {
    const frame = await frameOf([
      { type: "user", message: { content: "keep going" } },
      withStop("msg_1", { input_tokens: 1000, output_tokens: 50 }, "tool_use"),
    ]);
    assert.match(frame, /working/, `expected a working marker:\n${frame}`);
  });

  it("treats a null stop_reason as still going, not as settled", async () => {
    // Streaming records land with stop_reason null; calling that settled would
    // flicker the spinner off mid-turn.
    const frame = await frameOf([
      { type: "user", message: { content: "mid stream" } },
      withStop("msg_1", { input_tokens: 1000, output_tokens: 50 }, null),
    ]);
    assert.match(frame, /working/, `expected a working marker:\n${frame}`);
  });

  it("prints a settled turn in plain output without waiting for the next prompt", async () => {
    // `--plain` printed a row only once a LATER prompt superseded the turn, so an
    // idle session showed nothing for work that had already finished.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-idle-plain-"));
    try {
      const log = path.join(dir, "s.jsonl");
      fs.writeFileSync(log, `${[
        JSON.stringify({ type: "user", message: { content: "only turn" } }),
        JSON.stringify(withStop("msg_1", { input_tokens: 1000, output_tokens: 50 }, "end_turn")),
      ].join("\n")}\n`);
      let text = "";
      const controller = new AbortController();
      let polls = 0;
      await runUsageMeter({
        filePath: log,
        plain: true,
        fromStart: true,
        follow: true,
        pollMs: 0,
        stream: { isTTY: false, columns: 120, rows: 30, write(c) { text += String(c); return true; } },
        signal: controller.signal,
        sleep: async () => { polls += 1; if (polls >= 2) controller.abort(); },
      });
      assert.match(text, /only turn/, `settled turn should print:\n${text}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agents pane", () => {
  const paneFrame = (list, { focused = false, index = 0, trackingId = "main", columns = 120 } = {}) => {
    applyMeterStyle(false);
    const db = new Dashboard("/tmp/abcd1234.jsonl", new ModelIndex(), {
      fullscreen: false,
      stream: { columns, rows: 40, write() { return true; } },
      agentLabel: "Main",
    });
    db.agents = { list, index, focused, trackingId };
    return db.agentPane(columns).join("\n");
  };

  const main = {
    kind: "main",
    id: "main",
    label: "Main",
    report: { requests: 4, totals: { cost: 1.5, input: 10, cacheRead: 90 } },
  };
  const sub = (id, label, cost) => ({
    kind: "subagent",
    id,
    label,
    report: { requests: 2, totals: { cost, input: 10, cacheRead: 90 } },
  });

  it("draws nothing for a session whose only agent is Main", () => {
    // Every session lists Main, so a length check gave a solo session a pane
    // whose one row was the agent already being metered.
    assert.equal(paneFrame([main]), "");
    assert.equal(agentPaneWorthShowing([main]), false);
    assert.equal(agentPaneWorthShowing([]), false);
  });

  it("lists every agent once a subagent exists", () => {
    const frame = paneFrame([main, sub("a1", "Explore", 0.25)]);
    assert.match(frame, /Main/);
    assert.match(frame, /Explore/);
    assert.match(frame, /\$0\.25/);
    assert.equal(agentPaneWorthShowing([main, sub("a1", "Explore", 0.25)]), true);
  });

  it("marks the tracked agent and, separately, the cursor", () => {
    // Two different questions: what am I metering, vs what would Enter pick.
    const frame = paneFrame([main, sub("a1", "Explore", 0.25)], {
      focused: true,
      index: 1,
      trackingId: "main",
    });
    const lines = frame.split("\n");
    const mainLine = lines.find((l) => l.includes("Main"));
    const subLine = lines.find((l) => l.includes("Explore"));
    assert.match(mainLine, /•/, "tracked agent keeps the dot");
    assert.match(subLine, /❯/, "cursor sits on the highlighted row");
    assert.ok(!subLine.includes("•"), "cursor row is not the tracked row here");
  });

  it("keeps rows aligned whether or not a row is marked", () => {
    const frame = paneFrame([main, sub("a1", "Explore", 0.25)], { trackingId: "main" });
    const lines = frame.split("\n").filter((l) => l.includes("$"));
    assert.equal(lines.length, 2);
    assert.equal(
      lines[0].indexOf("$"),
      lines[1].indexOf("$"),
      `cost columns must line up:\n${frame}`,
    );
  });

  it("windows a long list around the cursor and says how many are hidden", () => {
    const many = [main, ...Array.from({ length: 12 }, (_, i) => sub(`a${i}`, `Agent${i}`, 0.01 * i))];
    const frame = paneFrame(many, { focused: true, index: 11 });
    assert.match(frame, /Agent11/, "the selected row must be visible");
    assert.match(frame, /more agents/, "the rest are counted, not dropped");
  });

  it("strips escapes from agent labels before they reach the terminal", () => {
    const frame = paneFrame([main, sub("a1", `Ex${String.fromCharCode(27)}[2Jplore`, 0.25)]);
    assert.ok(!frame.includes("[2J"), "label escapes must not survive");
    assert.match(frame, /Explore/);
  });
});

describe("syncAgentPane", () => {
  it("keeps the cursor on the same agent as the list grows", () => {
    // Subagents are appended while you read, so a positional cursor would stay
    // put while the row under it changed identity — Enter would then track
    // whatever had shifted into that slot.
    const pane = { list: [{ id: "main" }, { id: "a1" }], index: 1 };
    syncAgentPane(pane, [{ id: "main" }, { id: "a0" }, { id: "a1" }]);
    assert.equal(pane.list[pane.index].id, "a1", "cursor follows the agent, not the row");
  });

  it("clamps when the selected agent disappears", () => {
    const pane = { list: [{ id: "main" }, { id: "a1" }, { id: "a2" }], index: 2 };
    syncAgentPane(pane, [{ id: "main" }]);
    assert.equal(pane.index, 0);
  });

  it("survives an empty listing without going out of bounds", () => {
    const pane = { list: [{ id: "main" }], index: 0 };
    syncAgentPane(pane, []);
    assert.equal(pane.index, 0);
    assert.deepEqual(pane.list, []);
  });
});


describe("terminal stop reasons (Bugbot: refusal leaves meter spinning)", () => {
  /** Fullscreen frame for a single turn ending with `stop`. */
  async function frameForStop(stop) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-stop-"));
    const prevNoColor = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    try {
      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = "1";
      const log = path.join(dir, "s.jsonl");
      fs.writeFileSync(log, `${[
        JSON.stringify({ type: "user", message: { content: "go" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            id: "m1",
            model: "accounts/fireworks/models/glm-5p2",
            usage: { input_tokens: 1000, output_tokens: 50 },
            stop_reason: stop,
          },
        }),
      ].join("\n")}\n`);
      let text = "";
      await runUsageMeter({
        filePath: log,
        fromStart: true,
        follow: false,
        stream: { isTTY: true, columns: 120, rows: 30, write(c) { text += String(c); return true; } },
        agentLabel: "Main",
      });
      return text.replace(/\[[0-9;]*[A-Za-z]/g, "");
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
      if (prevForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForce;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Every terminal value in Anthropic's stop-reason reference. `refusal` and
  // `model_context_window_exceeded` were missing, so a refused turn kept the
  // header on "working" until the next prompt — the exact perpetual-spinner bug
  // the settled flag exists to prevent.
  for (const stop of [
    "end_turn",
    "stop_sequence",
    "max_tokens",
    "refusal",
    "model_context_window_exceeded",
  ]) {
    it(`treats ${stop} as settled`, async () => {
      const frame = await frameForStop(stop);
      assert.match(frame, /idle/, `${stop} should read idle:\n${frame}`);
      assert.ok(!/working/.test(frame), `${stop} must not keep spinning`);
    });
  }

  // The continuation reasons: more calls follow in the SAME turn, so the spinner
  // has to keep going. `pause_turn` is a server-tool loop hitting its iteration
  // limit, not the model finishing.
  for (const stop of ["tool_use", "pause_turn"]) {
    it(`keeps ${stop} unsettled`, async () => {
      const frame = await frameForStop(stop);
      assert.match(frame, /working/, `${stop} should still read working:\n${frame}`);
    });
  }

  it("treats an unrecognised stop_reason as still going", async () => {
    // A future continuation reason should keep the spinner honest rather than
    // claim the turn finished.
    const frame = await frameForStop("some_future_reason");
    assert.match(frame, /working/, `unknown reasons should read working:\n${frame}`);
  });
});

describe("pane focus cannot outlive the pane (Bugbot: stale pane focus)", () => {
  const main = { kind: "main", id: "main", label: "Main" };
  const sub = { kind: "subagent", id: "a1", label: "Explore" };

  it("drops focus when the last subagent disappears", () => {
    // The pane hides when only Main is left, but `focused` survived — so the next
    // subagent spawn silently captured ↑/↓/Enter/Esc with no Tab, and the turn
    // table's keys stopped working for no visible reason.
    const pane = { list: [main, sub], index: 1, focused: true, trackingId: "main" };
    syncAgentPane(pane, [main]);
    assert.equal(pane.focused, false, "hiding the pane must drop focus");

    syncAgentPane(pane, [main, sub]);
    assert.equal(pane.focused, false, "a respawn must not auto-capture the keys");
  });

  it("drops focus when the listing goes empty", () => {
    const pane = { list: [main, sub], index: 1, focused: true, trackingId: "main" };
    syncAgentPane(pane, []);
    assert.equal(pane.focused, false);
    assert.equal(pane.index, 0);
  });

  it("keeps focus while the pane is still showable", () => {
    const pane = { list: [main, sub], index: 1, focused: true, trackingId: "main" };
    syncAgentPane(pane, [main, sub, { kind: "subagent", id: "a2", label: "Other" }]);
    assert.equal(pane.focused, true, "focus survives a refresh that keeps the pane up");
    assert.equal(pane.list[pane.index].id, "a1", "and the cursor stays on its agent");
  });

  it("drops focus and the cursor when the session resets", () => {
    // `reset` empties the list directly rather than going through syncAgentPane,
    // so it has to clear focus itself or the keys go to an invisible cursor.
    applyMeterStyle(false);
    const db = new Dashboard("/tmp/abcd1234.jsonl", new ModelIndex(), {
      fullscreen: false,
      stream: { columns: 120, rows: 40, write() { return true; } },
      agentLabel: "Main",
    });
    db.agents = { list: [main, sub], index: 1, focused: true, trackingId: "main" };
    db.reset();
    assert.deepEqual(db.agents.list, []);
    assert.equal(db.agents.focused, false, "reset must drop focus");
    assert.equal(db.agents.index, 0);
  });
});


describe("column layout is derived, not duplicated", () => {
  // The header, turn rows, footer rows, and the footer's right-align anchor all
  // come from one column table. Before that they were four sets of literals that
  // had to agree, and they stopped agreeing the moment the headings changed.
  const widest = {
    input: 235_800_000,
    cacheRead: 254_900_000,
    cacheWrite: 1_700_000,
    output: 374_300,
  };

  it("aligns every numeric cell under its heading, for the widest values tok() emits", async () => {
    const frame = await render([
      { type: "user", message: { content: "widest" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: widest.input,
            cache_read_input_tokens: widest.cacheRead,
            cache_creation_input_tokens: widest.cacheWrite,
            output_tokens: widest.output,
          },
        },
      },
    ]);

    const lines = plainLines(frame);
    const header = lines.find((l) => l.includes("cache%"));
    const turn = lines.find((l) => /^\s*[✓⠋]\s+\d+\s/.test(l));
    const footer = lines.find((l) => l.trimStart().startsWith("●"));
    assert.ok(header && turn && footer, `need header, turn and footer rows:\n${frame}`);

    // Each heading's right edge must line up with its cell's right edge on the
    // turn row. Footer model names use a wider label block, so footer numeric
    // columns start further right on purpose.
    for (const head of ["uncached", "cached", "write", "cache%", "out"]) {
      const at = header.indexOf(head) + head.length;
      assert.equal(
        turn.slice(0, at).trimEnd().length,
        at,
        `${head} not right-aligned on the turn row at col ${at}:\n${header}\n${turn}`,
      );
    }
  });

  it("keeps the numeric block no wider than its headings need", async () => {
    // Every column here is one the prompt text does not get, so the block must
    // not quietly grow. 6 chars is the widest tok() output ("235.8M").
    const frame = await render([
      { type: "user", message: { content: "x" } },
      assistant("msg_1", { input_tokens: 1000, output_tokens: 100 }),
    ]);
    const header = plainLines(frame).find((l) => l.includes("cache%"));
    const block = header.slice(header.indexOf("uncached"), header.indexOf("cost")).trimEnd();
    // uncached(8) cached(6) write(6) cache%(6) out(6) + 4 gutters = 36.
    assert.equal(block.length, 36, `numeric block width drifted: [${block}]`);
  });
});
