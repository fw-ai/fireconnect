import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  attachAgentBackKey,
  CLAUDE_USAGE_AGENT_RESUME,
  formatClaudeUsageAgentChoice,
  promptClaudeUsageAgent,
} from "../../../../lib/harnesses/claude/usage/agent-picker.mjs";
import {
  formatSubagentLabel,
  formatUsageCachePct,
  listSessionAgents,
  parseClaudeSubagentMeta,
  parseParentSubagentSpawnMeta,
} from "../../../../lib/harnesses/claude/usage/agents.mjs";
import { runClaudeUsageLive } from "../../../../lib/harnesses/claude/usage/live.mjs";
import { Dashboard, ModelIndex } from "../../../../lib/harnesses/claude/usage/meter.mjs";
import { METER } from "../../../../lib/ui/palette.mjs";
import {
  formatLiveCost,
  formatLiveCostTotal,
} from "../../../../lib/harnesses/claude/usage/format.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-agent-pick-"));
  temps.push(home);
  return home;
}

function usageJsonl({ model = "accounts/fireworks/models/glm-5p2", input = 1000, output = 50, cread = 500 } = {}) {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      id: `m-${input}-${output}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cread,
        cache_creation_input_tokens: 0,
      },
    },
  })}\n`;
}

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(v) { this.isRaw = v; return this; }
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

/**
 * Run `fn` with colour forced on.
 *
 * The suite's global setup pins NO_COLOR=1, and the meter falls back to plain
 * scrolling output when colour is off — so a fullscreen-only feature like the
 * agents pane is never built. These tests passed alone and failed under `npm
 * test` until they asked for colour explicitly.
 */
async function withColor(fn) {
  const prevNo = process.env.NO_COLOR;
  const prevForce = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  try {
    return await fn();
  } finally {
    if (prevNo === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNo;
    if (prevForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prevForce;
  }
}

describe("formatUsageCachePct / agent choice labels", () => {
  it("matches meter cache-hit formula", () => {
    assert.equal(formatUsageCachePct({ input: 100, cacheRead: 900, cacheWrite5m: 0, cacheWrite1h: 0 }), "90%");
    assert.equal(formatUsageCachePct({ input: 0, cacheRead: 0 }), "—");
  });

  it("formats Main with spend, cache%, and calls", () => {
    const label = formatClaudeUsageAgentChoice({
      kind: "main",
      id: "main",
      label: "Main",
      report: {
        sessionName: "FireRouter demo",
        requests: 4,
        totals: { cost: 0.0563, input: 1000, cacheRead: 9000, cacheWrite5m: 0, cacheWrite1h: 0 },
      },
    });
    assert.match(label, /\$0\.06/);
    assert.match(label, /90% cache/);
    assert.match(label, /4 calls/);
    assert.match(label, /Main/);
    assert.match(label, /FireRouter demo/);
  });

  it("strips escapes from session names on Main", () => {
    const label = formatClaudeUsageAgentChoice({
      kind: "main",
      id: "main",
      label: "Main",
      report: {
        sessionName: `x\u001b[2Jy`,
        requests: 1,
        totals: { cost: 0.01, input: 1, cacheRead: 0 },
      },
    });
    assert.doesNotMatch(label, /\u001b/);
    assert.match(label, /xy/);
  });

  it("prefers subagent name over id in choice label", () => {
    const label = formatClaudeUsageAgentChoice({
      kind: "subagent",
      id: "a1b2c3d4",
      label: "Explore · Find .ts files",
      name: "Explore",
      description: "Find .ts files",
      report: {
        requests: 2,
        totals: { cost: 0.01, input: 10, cacheRead: 90 },
      },
    });
    assert.match(label, /Explore/);
    assert.doesNotMatch(label, /a1b2c3d4/);
  });

  it("paints cost with METER gold when color is enabled", () => {
    const prevForce = process.env.FORCE_COLOR;
    const prevNo = process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    try {
      const label = formatClaudeUsageAgentChoice({
        kind: "main",
        id: "main",
        label: "Main",
        report: {
          requests: 1,
          totals: { cost: 0.0563, input: 100, cacheRead: 0 },
        },
      }, { stream: { isTTY: true }, color: true, active: true });
      assert.ok(label.includes(METER.gold), `expected gold in ${JSON.stringify(label)}`);
      assert.ok(label.includes(METER.ghost), `expected ghost in ${JSON.stringify(label)}`);
      // Per-call keeps 4 decimals; the picker row is a total, so 2.
      assert.equal(formatLiveCost(0.0563), "$0.0563");
      assert.equal(formatLiveCostTotal(0.0563), "$0.06");
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForce;
      if (prevNo === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNo;
    }
  });
});

describe("subagent naming", () => {
  it("formatSubagentLabel strips CSI/OSC from name and description", () => {
    const label = formatSubagentLabel("abcdef12", {
      name: `Explore\u001b[2J`,
      description: `Find files\u001b]0;hack\u0007`,
    });
    assert.doesNotMatch(label, /\u001b/);
    assert.doesNotMatch(label, /\u0007/);
    assert.match(label, /^Explore · Find files/);
  });

  it("formatSubagentLabel prefers name (+ description) over id", () => {
    assert.equal(formatSubagentLabel("abcdef12", { name: "Explore" }), "Explore");
    assert.match(formatSubagentLabel("abcdef12", {
      name: "Explore",
      description: "Find .ts files under src",
    }), /^Explore · Find/);
    assert.match(formatSubagentLabel("abcdef12", {}), /sub-agent abcdef12/);
  });

  it("parseClaudeSubagentMeta reads attributionAgent", () => {
    const meta = parseClaudeSubagentMeta([
      JSON.stringify({ type: "user", message: { content: "Search the tree" } }),
      JSON.stringify({
        type: "assistant",
        attributionAgent: "Explore",
        message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ].join("\n"));
    assert.equal(meta.name, "Explore");
    assert.equal(meta.description, "Search the tree");
  });

  it("parseParentSubagentSpawnMeta maps agentId from Agent tool_use", () => {
    const text = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu_1",
            name: "Agent",
            input: {
              subagent_type: "Explore",
              description: "Find .ts files under src",
              prompt: "long prompt…",
            },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { tool_use_id: "toolu_1", agentId: "explore1" },
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      }),
    ].join("\n");
    const map = parseParentSubagentSpawnMeta(text);
    assert.equal(map.get("explore1")?.name, "Explore");
    assert.equal(map.get("explore1")?.description, "Find .ts files under src");
  });
});

describe("listSessionAgents", () => {
  it("lists Main plus named subagent logs", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    const subDir = path.join(projectDir, sid, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "parent-1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 },
          content: [{
            type: "tool_use",
            id: "toolu_x",
            name: "Agent",
            input: { subagent_type: "Explore", description: "Find auth middleware" },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        toolUseResult: { tool_use_id: "toolu_x", agentId: "explore1" },
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "done" }] },
      }),
    ].join("\n") + "\n");
    await writeFile(
      path.join(subDir, "agent-explore1.jsonl"),
      `${JSON.stringify({ type: "user", message: { content: "long task prompt" } })}\n${usageJsonl({ input: 50, output: 5, cread: 200 })}`,
    );

    const agents = await listSessionAgents(sessionPath);
    assert.equal(agents.length, 2);
    assert.equal(agents[0].kind, "main");
    assert.equal(agents[0].label, "Main");
    assert.equal(agents[1].kind, "subagent");
    assert.equal(agents[1].id, "explore1");
    assert.equal(agents[1].name, "Explore");
    assert.match(agents[1].label, /Explore/);
    assert.doesNotMatch(agents[1].label, /sub-agent/);
    assert.ok(agents[1].report.totals.cost > 0);
  });

  it("labels subagents from the .meta.json sidecar", async () => {
    // Claude Code writes agent-<id>.meta.json beside each subagent log. It is
    // the only clean source of the spawn's type/description — without it the
    // label degrades to a slice of the agent's system prompt.
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    const subDir = path.join(projectDir, sid, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());
    await writeFile(
      path.join(subDir, "agent-sub1.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: { content: "You are performing the Efficiency check. Read the whole diff and…" },
      })}\n${usageJsonl({ input: 50, output: 5, cread: 200 })}`,
    );
    await writeFile(
      path.join(subDir, "agent-sub1.meta.json"),
      JSON.stringify({
        agentType: "Explore",
        description: "Confirm efficiency hotspots",
        parentAgentId: "parent7",
        spawnDepth: 3,
      }),
    );

    const [, sub] = await listSessionAgents(sessionPath);
    assert.equal(sub.name, "Explore");
    assert.equal(sub.description, "Confirm efficiency hotspots");
    assert.equal(sub.parentId, "parent7");
    assert.equal(sub.depth, 3);
    assert.equal(sub.label, "Explore · Confirm efficiency hotspots");
    // The prompt excerpt must not leak into the label.
    assert.doesNotMatch(sub.label, /You are performing/);
  });

  it("prefers the sidecar skill name over the agent type", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    const subDir = path.join(projectDir, sid, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());
    await writeFile(path.join(subDir, "agent-sub2.jsonl"), usageJsonl({ input: 10, output: 1 }));
    await writeFile(
      path.join(subDir, "agent-sub2.meta.json"),
      JSON.stringify({ agentType: "general-purpose", name: "code-review", description: "/code-review", spawnDepth: 1 }),
    );

    const [, sub] = await listSessionAgents(sessionPath);
    assert.equal(sub.name, "code-review");
    assert.match(sub.label, /code-review/);
  });

  it("falls back to log-derived labels when the sidecar is missing or corrupt", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    const subDir = path.join(projectDir, sid, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());
    // Corrupt sidecar: a partially written file is normal mid-spawn.
    await writeFile(path.join(subDir, "agent-sub3.jsonl"), usageJsonl({ input: 10, output: 1 }));
    await writeFile(path.join(subDir, "agent-sub3.meta.json"), "{not json");
    // No sidecar at all: older logs predate them.
    await writeFile(path.join(subDir, "agent-sub4.jsonl"), usageJsonl({ input: 10, output: 1 }));

    const agents = await listSessionAgents(sessionPath);
    assert.equal(agents.length, 3, "both subagents still listed");
    for (const sub of agents.slice(1)) {
      assert.ok(sub.label, "a label is always produced");
      assert.match(sub.label, /sub-agent/, "degrades to the id-based label");
    }
  });
});

describe("promptClaudeUsageAgent", () => {
  it("returns Main when stdin is not a TTY", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());

    const chosen = await promptClaudeUsageAgent({
      sessionPath,
      input: { isTTY: false },
      output: { isTTY: true, write() { return true; } },
    });
    assert.equal(chosen.kind, "main");
    assert.equal(chosen.filePath, sessionPath);
  });

  it("selects a subagent with Enter when already highlighted", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    const subDir = path.join(projectDir, sid, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());
    const subPath = path.join(subDir, "agent-worker.jsonl");
    await writeFile(subPath, usageJsonl({ input: 10 }));

    const input = new FakeInput();
    const writes = [];
    const output = {
      isTTY: true,
      write(chunk) { writes.push(chunk); return true; },
    };
    const pending = promptClaudeUsageAgent({
      sessionPath,
      input,
      output,
      refreshMs: 60_000,
    });
    await waitForWrites(writes);
    // Default highlight is first subagent.
    setImmediate(() => input.emit("data", "\r"));
    const chosen = await pending;
    assert.equal(chosen.kind, "subagent");
    assert.equal(chosen.filePath, subPath);
  });

  it("returns resume sentinel on Esc", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());

    const input = new FakeInput();
    const writes = [];
    const output = {
      isTTY: true,
      write(chunk) { writes.push(chunk); return true; },
    };
    const pending = promptClaudeUsageAgent({
      sessionPath,
      input,
      output,
      refreshMs: 60_000,
    });
    await waitForWrites(writes);
    setImmediate(() => input.emit("data", "\u001b"));
    assert.equal(await pending, CLAUDE_USAGE_AGENT_RESUME);
  });

  it("returns null on q (quit)", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "ffffffff-ffff-4fff-ffff-ffffffffffff";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());

    const input = new FakeInput();
    const writes = [];
    const output = {
      isTTY: true,
      write(chunk) { writes.push(chunk); return true; },
    };
    const pending = promptClaudeUsageAgent({
      sessionPath,
      input,
      output,
      refreshMs: 60_000,
    });
    await waitForWrites(writes);
    setImmediate(() => input.emit("data", "q"));
    assert.equal(await pending, null);
  });
});

describe("attachAgentBackKey", () => {
  it("treats Esc as back to the session list, not as open-agents", async () => {
    // You reach the meter FROM the session list, skipping agents — so back has
    // to mean sessions. Agents is a sideways move on its own key.
    const input = new FakeInput();
    let agents = 0;
    let sessions = 0;
    const detach = attachAgentBackKey({
      input,
      onAgents: () => { agents += 1; },
      onSessions: () => { sessions += 1; },
    });
    input.emit("data", "\x1b");
    await new Promise((r) => setImmediate(r));
    assert.equal(sessions, 1, "Esc goes back to sessions");
    assert.equal(agents, 0, "Esc must not open the agent list");
    detach();
  });

  it("leaves ← and → unbound so they cannot leave the session", async () => {
    // Arrow keys belong to the agents pane cursor. A key that means "move" in
    // one mode and "leave the session" in another is a trap, so ← no longer
    // doubles as back.
    const input = new FakeInput();
    let agents = 0;
    let sessions = 0;
    const detach = attachAgentBackKey({
      input,
      onAgents: () => { agents += 1; },
      onSessions: () => { sessions += 1; },
    });
    input.emit("data", "\x1b[D");
    input.emit("data", "\x1b[C");
    await new Promise((r) => setImmediate(r));
    assert.equal(sessions, 0, "← must not navigate");
    assert.equal(agents, 0, "→ must not navigate");
    detach();
  });

  it("opens the agent list on a", async () => {
    const input = new FakeInput();
    let agents = 0;
    let sessions = 0;
    const detach = attachAgentBackKey({
      input,
      onAgents: () => { agents += 1; },
      onSessions: () => { sessions += 1; },
    });
    input.emit("data", "a");
    assert.equal(agents, 1);
    assert.equal(sessions, 0);
    detach();
  });

  it("does not open agents on Esc when there is no session list", async () => {
    // The locked live-split meter withholds `promptSession`, so Esc has no
    // session list to go back to. It must be a no-op — not fall through to the
    // agent modal, which would swap the pane and undo the live-split lock.
    // (`usage --session <id>` outside a live split always gets a session list,
    // so this no-onSessions path is exclusive to the locked meter.)
    const input = new FakeInput();
    let agents = 0;
    const detach = attachAgentBackKey({ input, onAgents: () => { agents += 1; } });
    input.emit("data", "\x1b");
    await new Promise((r) => setImmediate(r));
    assert.equal(agents, 0, "Esc must not open the agent list when locked");
    detach();
  });

  it("focuses the pane on Tab and moves its cursor with ↑/↓ only when focused", async () => {
    const input = new FakeInput();
    const pane = {
      list: [
        { kind: "main", id: "main" },
        { kind: "subagent", id: "a1" },
        { kind: "subagent", id: "a2" },
      ],
      index: 0,
      focused: false,
    };
    let sessions = 0;
    const detach = attachAgentBackKey({
      input,
      pane,
      onAgents: () => {},
      onSessions: () => { sessions += 1; },
    });

    // Unfocused: ↓ must not move the pane cursor.
    input.emit("data", "\x1b[B");
    assert.equal(pane.index, 0, "↓ must not move an unfocused pane");

    input.emit("data", "\t");
    assert.equal(pane.focused, true);
    input.emit("data", "\x1b[B");
    assert.equal(pane.index, 1, "↓ moves the focused pane");
    input.emit("data", "\x1b[A");
    assert.equal(pane.index, 0, "↑ moves back");

    // Focused Esc unfocuses instead of leaving the session.
    input.emit("data", "\x1b");
    await new Promise((r) => setImmediate(r));
    assert.equal(pane.focused, false, "Esc leaves the pane first");
    assert.equal(sessions, 0, "focused Esc must not leave the session");

    // Now unfocused, Esc does go back.
    input.emit("data", "\x1b");
    await new Promise((r) => setImmediate(r));
    assert.equal(sessions, 1);
    detach();
  });

  it("picks the highlighted agent on Enter and unfocuses the pane", async () => {
    const input = new FakeInput();
    const pane = {
      list: [
        { kind: "main", id: "main" },
        { kind: "subagent", id: "a1" },
        { kind: "subagent", id: "a2" },
      ],
      index: 0,
      focused: false,
    };
    const picks = [];
    const detach = attachAgentBackKey({
      input,
      pane,
      onAgents: () => {},
      onPick: (agent) => { picks.push(agent.id); },
    });
    input.emit("data", "\t");
    input.emit("data", "\x1b[B");
    input.emit("data", "\x1b[B");
    input.emit("data", "\r");
    assert.deepEqual(picks, ["a2"], "Enter tracks the highlighted agent");
    assert.equal(pane.focused, false, "picking closes the pane");
    detach();
  });

  it("wraps the pane cursor at both ends", async () => {
    const input = new FakeInput();
    const pane = {
      list: [{ kind: "main", id: "m" }, { kind: "subagent", id: "a" }],
      index: 0,
      focused: true,
    };
    const detach = attachAgentBackKey({ input, pane, onAgents: () => {} });
    input.emit("data", "\x1b[A");
    assert.equal(pane.index, 1, "↑ from the top wraps to the bottom");
    input.emit("data", "\x1b[B");
    assert.equal(pane.index, 0, "↓ from the bottom wraps to the top");
    detach();
  });

  it("ignores Tab and pane keys when the pane has no agents", async () => {
    // A pane object exists before the first listing lands; Tab must not focus an
    // empty pane, or the arrow keys would be swallowed with nothing to move.
    const input = new FakeInput();
    const pane = { list: [], index: 0, focused: false };
    let sessions = 0;
    const detach = attachAgentBackKey({
      input,
      pane,
      onAgents: () => {},
      onSessions: () => { sessions += 1; },
    });
    input.emit("data", "\t");
    assert.equal(pane.focused, false, "Tab must not focus an empty pane");
    input.emit("data", "\x1b");
    await new Promise((r) => setImmediate(r));
    assert.equal(sessions, 1, "Esc still navigates with an empty pane");
    detach();
  });

  it("lets q quit and Ctrl+C exit even while the pane is focused", async () => {
    const input = new FakeInput();
    const pane = {
      list: [{ kind: "main", id: "m" }, { kind: "subagent", id: "a" }],
      index: 0,
      focused: true,
    };
    let quits = 0;
    const detach = attachAgentBackKey({
      input,
      pane,
      onAgents: () => {},
      onQuit: () => { quits += 1; },
    });
    input.emit("data", "q");
    assert.equal(quits, 1, "q must quit from inside the pane");
    detach();
  });

  it("restores the cursor and leaves raw mode before exiting on Ctrl+C", async () => {
    const input = new FakeInput();
    input.isRaw = true;
    const writes = [];
    const output = { write(chunk) { writes.push(String(chunk)); return true; } };
    const exitCodes = [];
    const realExit = process.exit;
    process.exit = /** @type {typeof process.exit} */ ((code) => {
      exitCodes.push(code);
      throw new Error(`exit:${code}`);
    });
    const detach = attachAgentBackKey({
      input,
      output,
      onAgents: () => {},
      onQuit: () => {},
    });
    try {
      assert.throws(() => input.emit("data", "\x03"), /exit:130/);
      assert.equal(input.isRaw, false);
      assert.deepEqual(exitCodes, [130]);
      assert.ok(writes.some((w) => w.includes("\u001b[?25h")), `expected showCursor in ${JSON.stringify(writes)}`);
    } finally {
      process.exit = realExit;
      detach();
    }
  });

  it("invokes onQuit on q (not navigation)", () => {
    const input = new FakeInput();
    let back = 0;
    let quit = 0;
    const detach = attachAgentBackKey({
      input,
      onAgents: () => { back += 1; },
      onQuit: () => { quit += 1; },
    });
    input.emit("data", "q");
    assert.equal(back, 0);
    assert.equal(quit, 1);
    detach();
  });

  it("does not open agents on q when onQuit is omitted", () => {
    const input = new FakeInput();
    let back = 0;
    const detach = attachAgentBackKey({
      input,
      onAgents: () => { back += 1; },
    });
    input.emit("data", "q");
    assert.equal(back, 0);
    detach();
  });
});

describe("promptClaudeUsageAgent refresh race", () => {
  it("does not redraw after the picker closes", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "12121212-1212-4121-8212-121212121212";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());

    /** @type {(value: unknown) => void} */
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    let listCalls = 0;
    const listAgents = async () => {
      listCalls += 1;
      if (listCalls === 1) {
        return [{
          kind: "main",
          id: "main",
          label: "Main",
          filePath: sessionPath,
          report: { requests: 1, totals: { cost: 0.01, input: 1, cacheRead: 0 } },
        }];
      }
      await refreshGate;
      return [{
        kind: "main",
        id: "main",
        label: "Main-AFTER",
        filePath: sessionPath,
        report: { requests: 2, totals: { cost: 0.02, input: 2, cacheRead: 0 } },
      }];
    };

    const input = new FakeInput();
    const writes = [];
    const output = {
      isTTY: true,
      write(chunk) { writes.push(String(chunk)); return true; },
    };
    const pending = promptClaudeUsageAgent({
      sessionPath,
      input,
      output,
      refreshMs: 20,
      listAgents,
    });
    await waitForWrites(writes);
    // Wait until an in-flight refresh is parked on the gate.
    await new Promise((resolve) => {
      const tick = () => (listCalls >= 2 ? resolve() : setImmediate(tick));
      tick();
    });
    setImmediate(() => input.emit("data", "q"));
    assert.equal(await pending, null);

    const afterClose = writes.length;
    releaseRefresh();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(writes.length, afterClose, "late refresh must not write after close");
    assert.doesNotMatch(writes.join(""), /Main-AFTER/);
  });
});

describe("runClaudeUsageLive agent loop", () => {
  it("live-tracks Main by default without opening the agent picker", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({
      type: "user",
      message: { content: "main work" },
    })}\n${usageJsonl({ input: 2000, output: 100, cread: 8000 })}`);

    const chunks = [];
    const stream = {
      isTTY: true,
      columns: 100,
      rows: 40,
      write(c) { chunks.push(String(c)); return true; },
    };

    let prompted = 0;
    const controller = new AbortController();
    await runClaudeUsageLive({
      home,
      session: sessionPath,
      stream,
      input: { isTTY: true },
      promptAgent: async () => {
        prompted += 1;
        return null;
      },
      resolveSession: async () => sessionPath,
      listAgents: async () => [{
        kind: "main",
        id: "main",
        label: "Main",
        filePath: sessionPath,
      }],
      sleep: async () => { controller.abort(); },
      signal: controller.signal,
    });
    assert.equal(prompted, 0);
    const text = chunks.join("");
    assert.match(text, /main work|Live Cost|GLM|\$0\./);
  });

  it("live-tracks a subagent picked from the in-frame pane, without a modal", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "abababab-abab-4aba-abab-abababababab";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    const subDir = path.join(projectDir, sid, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl({ input: 1, output: 1, cread: 0 }));
    const subPath = path.join(subDir, "agent-alpha.jsonl");
    await writeFile(subPath, `${JSON.stringify({
      type: "user",
      message: { content: "subagent work" },
    })}\n${JSON.stringify({
      type: "assistant",
      attributionAgent: "Explore",
      message: {
        id: "sub-1",
        model: "accounts/fireworks/models/glm-5p2",
        usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 8000 },
      },
    })}\n`);

    const chunks = [];
    const stream = {
      isTTY: true,
      columns: 100,
      rows: 40,
      write(c) { chunks.push(String(c)); return true; },
    };

    const input = new FakeInput();
    const controller = new AbortController();
    let polls = 0;
    let prompted = 0;

    const pending = withColor(() => runClaudeUsageLive({
      home,
      session: sessionPath,
      stream,
      input,
      // Must stay at 0: the whole point of the pane is that switching agent no
      // longer swaps the screen for a modal list.
      promptAgent: async () => {
        prompted += 1;
        return null;
      },
      resolveSession: async () => sessionPath,
      listAgents: async () => [
        { kind: "main", id: "main", label: "Main", filePath: sessionPath },
        { kind: "subagent", id: "alpha", label: "Explore", filePath: subPath },
      ],
      sleep: async () => {
        polls += 1;
        // Tab into the pane, ↓ onto the subagent, Enter to track it.
        if (polls === 1) {
          input.emit("data", "\t");
          input.emit("data", "\x1b[B");
          input.emit("data", "\r");
          return;
        }
        if (polls >= 3) controller.abort();
      },
      signal: controller.signal,
      pollMs: 0,
    }));

    await pending;
    assert.equal(prompted, 0, "the pane must not open the modal picker");
    const text = chunks.join("");
    // The subagent's own log is now the tail, so its turn text shows up.
    assert.match(text, /subagent work|Explore/);
  });

  it("shows the agents pane only once a subagent exists", async () => {
    // Every session lists Main, so a bare length check gave a solo session a pane
    // whose only row was the agent already being metered.
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "cdcdcdcd-cdcd-4cdc-cdcd-cdcdcdcdcdcd";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl({ input: 1, output: 1, cread: 0 }));

    const render = async (agents) => {
      const chunks = [];
      const controller = new AbortController();
      let polls = 0;
      await withColor(() => runClaudeUsageLive({
        home,
        session: sessionPath,
        stream: {
          isTTY: true,
          columns: 120,
          rows: 40,
          write(c) { chunks.push(String(c)); return true; },
        },
        input: new FakeInput(),
        resolveSession: async () => sessionPath,
        listAgents: async () => agents,
        promptAgent: async () => null,
        sleep: async () => { polls += 1; if (polls >= 2) controller.abort(); },
        signal: controller.signal,
        pollMs: 0,
      }));
      return chunks.join("");
    };

    const solo = await render([
      { kind: "main", id: "main", label: "Main", filePath: sessionPath },
    ]);
    assert.doesNotMatch(solo, /agents · Tab to focus/, "no pane for a solo session");

    const withSub = await render([
      { kind: "main", id: "main", label: "Main", filePath: sessionPath },
      { kind: "subagent", id: "alpha", label: "Explore", filePath: sessionPath },
    ]);
    assert.match(withSub, /agents · Tab to focus/, "pane appears with a subagent");
  });

  it("tells the modal picker which agent is live and where to point", async () => {
    // `initialId`/`trackingId` are what let the list answer "where am I, and
    // what gets me back". From Main, point at the first live subagent; from a
    // subagent, point at Main — highlighting the row already being metered put
    // the cursor on the one row nobody needs.
    //
    // Driven with `a`: with a subagent pane on screen the pane handles switching,
    // so `a` is the surviving route into the modal list.
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "66666666-6666-4666-6666-666666666666";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    const subDir = path.join(projectDir, sid, "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl({ input: 1, output: 1, cread: 0 }));
    const subPath = path.join(subDir, "agent-alpha.jsonl");
    await writeFile(subPath, usageJsonl({ input: 100, output: 10 }));

    const input = new FakeInput();
    const controller = new AbortController();
    let polls = 0;
    /** @type {string[]} */
    const initialIds = [];
    /** @type {string[]} */
    const trackingIds = [];

    await withColor(() => runClaudeUsageLive({
      home,
      session: sessionPath,
      stream: { isTTY: true, columns: 110, rows: 40, write() { return true; } },
      input,
      resolveSession: async () => sessionPath,
      listAgents: async () => [
        { kind: "main", id: "main", label: "Main", filePath: sessionPath },
        { kind: "subagent", id: "alpha", label: "Explore", filePath: subPath },
      ],
      promptAgent: async (opts) => {
        initialIds.push(opts.initialId);
        trackingIds.push(opts.trackingId);
        // First open: switch to the subagent. Second: stop.
        if (initialIds.length === 1) {
          return { kind: "subagent", id: "alpha", label: "Explore", filePath: subPath };
        }
        return null;
      },
      sleep: async () => {
        polls += 1;
        if (polls === 1 || polls === 3) {
          input.emit("data", "a");
          return;
        }
        if (polls >= 6) controller.abort();
      },
      signal: controller.signal,
      pollMs: 0,
    }));

    // `a` with a live pane focuses it rather than opening the modal, so the modal
    // stays shut here — the pane is the switcher whenever it is on screen.
    assert.equal(initialIds.length, 0, "a focuses the pane instead of a modal");
    assert.deepEqual(trackingIds, []);
  });

  it("opens the modal agent list on a when there is no subagent pane", async () => {
    // The modal survives for sessions whose agents are Main-only, where there is
    // no pane to focus. This is the path that still needs initialId/trackingId.
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "77777777-7777-4777-7777-777777777777";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl({ input: 1, output: 1, cread: 0 }));

    const input = new FakeInput();
    const controller = new AbortController();
    let polls = 0;
    /** @type {string[]} */
    const initialIds = [];
    /** @type {string[]} */
    const trackingIds = [];

    await runClaudeUsageLive({
      home,
      session: sessionPath,
      stream: { isTTY: true, columns: 110, rows: 40, write() { return true; } },
      input,
      resolveSession: async () => sessionPath,
      listAgents: async () => [
        { kind: "main", id: "main", label: "Main", filePath: sessionPath },
      ],
      promptAgent: async (opts) => {
        initialIds.push(opts.initialId);
        trackingIds.push(opts.trackingId);
        return null;
      },
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          input.emit("data", "a");
          return;
        }
        if (polls >= 4) controller.abort();
      },
      signal: controller.signal,
      pollMs: 0,
    });

    assert.equal(initialIds.length, 1, "a opens the modal list with no pane");
    assert.equal(initialIds[0], "", "from Main: highlight the first live subagent");
    assert.deepEqual(trackingIds, ["main"], "picker is told which agent is live");
  });

  it("opens the session list on Esc and tracks the chosen session", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const firstPath = path.join(projectDir, "11111111-1111-4111-1111-111111111111.jsonl");
    const secondPath = path.join(projectDir, "22222222-2222-4222-2222-222222222222.jsonl");
    await writeFile(firstPath, `${JSON.stringify({
      type: "user",
      message: { content: "first session work" },
    })}\n${usageJsonl({ input: 1000, output: 50 })}`);
    await writeFile(secondPath, `${JSON.stringify({
      type: "user",
      message: { content: "second session work" },
    })}\n${usageJsonl({ input: 2000, output: 100 })}`);

    const chunks = [];
    const stream = {
      isTTY: true,
      columns: 110,
      rows: 40,
      write(c) { chunks.push(String(c)); return true; },
    };

    const input = new FakeInput();
    const controller = new AbortController();
    let polls = 0;
    let sessionPrompts = 0;

    await runClaudeUsageLive({
      home,
      session: firstPath,
      stream,
      input,
      resolveSession: async () => firstPath,
      listAgents: async (logPath) => [
        { kind: "main", id: "main", label: "Main", filePath: logPath },
      ],
      promptAgent: async () => null,
      promptSession: async () => {
        sessionPrompts += 1;
        return secondPath;
      },
      sleep: async () => {
        polls += 1;
        // A lone Esc: no CSI bytes follow, so it is not an arrow prefix.
        if (polls === 1) {
          input.emit("data", "\x1b");
          return;
        }
        if (polls >= 4) controller.abort();
      },
      signal: controller.signal,
      pollMs: 0,
    });

    assert.equal(sessionPrompts, 1, "Esc should open the session list");
    // NO_COLOR is set for tests, so the meter renders its plain (scrolling)
    // form: no key-hint footer, and turn rows only once a turn completes. The
    // switch shows up in the token columns: 2.0k input is the second session,
    // whereas the first billed 1.0k. Cost can't be the discriminator here —
    // both of these fixtures are under a cent, so both totals read "<$0.01".
    const text = chunks.join("");
    assert.match(text, /2\.0k/, "should track the newly chosen session");
  });

  it("resumes the current agent when the session list is cancelled", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, "33333333-3333-4333-3333-333333333333.jsonl");
    await writeFile(sessionPath, `${JSON.stringify({
      type: "user",
      message: { content: "only session" },
    })}\n${usageJsonl({ input: 1000, output: 50 })}`);

    const chunks = [];
    const stream = {
      isTTY: true,
      columns: 110,
      rows: 40,
      write(c) { chunks.push(String(c)); return true; },
    };

    const input = new FakeInput();
    const controller = new AbortController();
    let polls = 0;
    let sessionPrompts = 0;

    await runClaudeUsageLive({
      home,
      session: sessionPath,
      stream,
      input,
      resolveSession: async () => sessionPath,
      listAgents: async (logPath) => [
        { kind: "main", id: "main", label: "Main", filePath: logPath },
      ],
      promptAgent: async () => null,
      // null = user pressed Esc/q in the picker; the meter should resume.
      promptSession: async () => {
        sessionPrompts += 1;
        return null;
      },
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          input.emit("data", "\x1b");
          return;
        }
        if (polls >= 4) controller.abort();
      },
      signal: controller.signal,
      pollMs: 0,
    });

    assert.equal(sessionPrompts, 1);
    // Cancelling returns to the same log, so the meter re-renders its figures
    // rather than exiting. Assert on the token column: this fixture costs well
    // under a cent, so its total renders "<$0.01" and carries no digits to match.
    assert.match(chunks.join(""), /1\.0k/, "meter resumed after cancel");
  });

  it("resumes the meter when the session picker throws", async () => {
    // The session list is rebuilt on open, so an empty lookback window or an
    // unreadable log throws. Esc must not be able to kill a working meter.
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, "55555555-5555-4555-5555-555555555555.jsonl");
    await writeFile(sessionPath, `${JSON.stringify({
      type: "user",
      message: { content: "still tracking" },
    })}\n${usageJsonl({ input: 1000, output: 50 })}`);

    const chunks = [];
    const input = new FakeInput();
    const controller = new AbortController();
    let polls = 0;
    let sessionPrompts = 0;

    await runClaudeUsageLive({
      home,
      session: sessionPath,
      stream: {
        isTTY: true,
        columns: 110,
        rows: 40,
        write(c) { chunks.push(String(c)); return true; },
      },
      input,
      resolveSession: async () => sessionPath,
      listAgents: async (logPath) => [
        { kind: "main", id: "main", label: "Main", filePath: logPath },
      ],
      promptAgent: async () => null,
      promptSession: async () => {
        sessionPrompts += 1;
        throw new Error("No Claude Code sessions in the last 3 days");
      },
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          input.emit("data", "\x1b");
          return;
        }
        if (polls >= 4) controller.abort();
      },
      signal: controller.signal,
      pollMs: 0,
    });

    assert.equal(sessionPrompts, 1, "Esc opened the picker");
    assert.match(chunks.join(""), /1\.0k/, "meter kept running after the throw");
  });

  it("ignores Esc when there is no session list to return to", async () => {
    // Mirrors the locked live-split meter: no `promptSession` was supplied, so
    // Esc has nowhere to go. It must be a no-op — not open the agent modal and
    // swap the pane — so the meter keeps running until it is aborted.
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, "44444444-4444-4444-4444-444444444444.jsonl");
    await writeFile(sessionPath, `${JSON.stringify({
      type: "user",
      message: { content: "explicit session" },
    })}\n${usageJsonl({ input: 1000, output: 50 })}`);

    const input = new FakeInput();
    const controller = new AbortController();
    let polls = 0;
    let agentPrompts = 0;

    await runClaudeUsageLive({
      home,
      session: sessionPath,
      stream: { isTTY: true, columns: 110, rows: 40, write() { return true; } },
      input,
      resolveSession: async () => sessionPath,
      listAgents: async (logPath) => [
        { kind: "main", id: "main", label: "Main", filePath: logPath },
      ],
      promptAgent: async () => {
        agentPrompts += 1;
        return null;
      },
      // No promptSession supplied.
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          input.emit("data", "\x1b");
          return;
        }
        if (polls >= 4) controller.abort();
      },
      signal: controller.signal,
      pollMs: 0,
    });

    assert.equal(agentPrompts, 0, "Esc is a no-op with no session list");
  });
});

describe("agent picker tracking cues", () => {
  /** Capture the picker's first rendered frame, then cancel it. */
  async function firstFrame(opts) {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    const sid = "77777777-7777-4777-7777-777777777777";
    const sessionPath = path.join(projectDir, `${sid}.jsonl`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, usageJsonl());

    const chunks = [];
    const input = new FakeInput();
    const pending = promptClaudeUsageAgent({
      sessionPath,
      input,
      output: { isTTY: true, columns: 120, rows: 40, write(c) { chunks.push(String(c)); return true; } },
      refreshMs: 0,
      listAgents: async () => [
        { kind: "main", id: "main", label: "Main", filePath: sessionPath, report: { totals: { cost: 1 }, requests: 5 } },
        { kind: "subagent", id: "alpha", label: "Explore", filePath: "/tmp/a.jsonl", report: { totals: { cost: 0.1 }, requests: 2 } },
      ],
      ...opts,
    });
    await new Promise((r) => setTimeout(r, 30));
    input.emit("data", "q");
    await pending;
    return chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
  }

  it("names the live agent instead of always claiming Main is live", async () => {
    const fromSub = await firstFrame({ initialId: "main", trackingId: "alpha", trackingLabel: "Explore" });
    assert.match(fromSub, /Tracking Explore/);
    assert.doesNotMatch(fromSub, /Main is live by default/);
  });

  it("marks the agent currently being metered", async () => {
    const fromSub = await firstFrame({ initialId: "main", trackingId: "alpha", trackingLabel: "Explore" });
    // The bullet sits on the subagent row, the pointer on Main.
    // runPrompt prefixes each line with a clear-line escape; drop it so the
    // row's own first column is what gets asserted.
    const rows = fromSub.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
    const mainRow = rows.find((l) => /Main/.test(l) && /\$/.test(l));
    const subRow = rows.find((l) => /Explore/.test(l) && /\$/.test(l));
    assert.ok(mainRow && subRow, `both rows present:\n${fromSub}`);
    assert.match(mainRow, /^❯/, "cursor on Main");
    assert.doesNotMatch(mainRow, /•/, "Main is not the tracked agent here");
    assert.match(subRow, /•/, "bullet marks the tracked subagent");
    // Row LENGTHS differ (the labels do), so align on where the cost cell
    // starts: the pointer and the bullet must occupy the same two columns.
    assert.equal(
      mainRow.indexOf("$"),
      subRow.indexOf("$"),
      `cost column must line up\n${mainRow}\n${subRow}`,
    );
  });

  it("sanitizes the tracking label before rendering it", async () => {
    const ESC = String.fromCharCode(27);
    const frame = await firstFrame({
      initialId: "main",
      trackingId: "alpha",
      trackingLabel: `Ex${ESC}[2Jplore`,
    });
    assert.doesNotMatch(frame.split("Tracking")[1] ?? "", /\[2J/);
    assert.match(frame, /Tracking Explore/);
  });
});

describe("attachAgentBackKey stdin lifecycle", () => {
  it("pauses stdin on detach so the process can exit", () => {
    // Resuming stdin makes it a ref'd handle that holds the event loop open. The
    // meter returned on `q` and then the CLI just sat there — only Ctrl+C, which
    // calls process.exit, could end it. Only reproducible against a real TTY, so
    // assert the lifecycle directly.
    const input = new FakeInput();
    input.paused = true;
    input.isPaused = () => input.paused;
    input.resume = () => { input.paused = false; return input; };
    input.pause = () => { input.paused = true; return input; };

    const detach = attachAgentBackKey({
      input,
      output: { write() { return true; } },
      onAgents() {},
    });
    assert.equal(input.paused, false, "watcher must start stdin flowing");

    detach();
    assert.equal(input.paused, true, "detach must pause stdin again");
    assert.equal(input.listenerCount("data"), 0, "and drop its listener");
  });

  it("leaves an already-flowing stdin alone", () => {
    // Someone else started it; pausing it would break their reader.
    const input = new FakeInput();
    input.paused = false;
    input.isPaused = () => input.paused;
    input.resume = () => { input.paused = false; return input; };
    input.pause = () => { input.paused = true; return input; };

    const detach = attachAgentBackKey({
      input,
      output: { write() { return true; } },
      onAgents() {},
    });
    detach();
    assert.equal(input.paused, false, "must not pause a stream it did not start");
  });
});

describe("live meter key hint", () => {
  it("advertises Esc only when a session list is reachable", () => {
    // The fullscreen footer is the only place these keys are documented, and
    // NO_COLOR test runs take the plain path, so assert on the Dashboard.
    const stream = { isTTY: true, columns: 110, rows: 40, write() { return true; } };
    const withSessions = new Dashboard("/tmp/s.jsonl", new ModelIndex(), {
      fullscreen: false,
      stream,
      keyHint: "← agents · Esc sessions · q quit",
    });
    assert.match(withSessions.keyHint, /Esc sessions/);

    const withoutSessions = new Dashboard("/tmp/s.jsonl", new ModelIndex(), {
      fullscreen: false,
      stream,
    });
    assert.equal(withoutSessions.keyHint, "← agents · q quit");
  });
});
