import assert from "node:assert/strict";
import { describe, it } from "node:test";

import fireconnectPiUsageExtension, {
  legendModels,
  renderUsageStatus,
  rowFromAssistantMessage,
  rowsFromSessionEntries,
  usageTableLines,
} from "../../../lib/harnesses/pi/extension/main.mjs";

const glmUsage = (over = {}) => ({
  input: 1_000,
  output: 100,
  cacheRead: 20_000,
  cacheWrite: 500,
  reasoning: 0,
  totalTokens: 21_600,
  cost: { total: 0 },
  ...over,
});

function assistantMessage(over = {}) {
  return {
    role: "assistant",
    model: "firerouter/opus",
    responseModel: "glm-5p2",
    responseId: "resp_1",
    stopReason: "stop",
    provider: "fireworks",
    usage: glmUsage(),
    ...over,
  };
}

function mockTheme() {
  return { fg: (_token, text) => text };
}

function mockCtx({ entries = [], mode = "tui" } = {}) {
  const statuses = new Map();
  const notifications = [];
  let customFactory = null;
  return {
    mode,
    hasUI: true,
    statuses,
    notifications,
    ui: {
      setStatus: (key, text) => statuses.set(key, text),
      notify: (message) => notifications.push(message),
      custom: async (factory) => {
        customFactory = factory;
      },
    },
    get customFactory() {
      return customFactory;
    },
    sessionManager: {
      getEntries: () => entries,
    },
  };
}

function mockPi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
  };
}

describe("pi usage-bar extension", () => {
  it("registers the event handlers and the /usage command", () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    assert.ok(pi.handlers.has("session_start"));
    assert.ok(pi.handlers.has("message_end"));
    assert.ok(pi.commands.has("usage"));
  });

  it("seeds from stored entries on session_start and renders the status line", async () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    const ctx = mockCtx({
      entries: [
        { type: "session", version: 3, id: "s", timestamp: "t", cwd: "/repo" },
        { type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "user", content: "go" } },
        { type: "message", id: "e1", parentId: "e0", timestamp: "t", message: assistantMessage() },
        {
          type: "usage",
          id: "u1",
          parentId: "e1",
          timestamp: "t",
          kind: "cache_warm",
          provider: "fireworks",
          model: "glm-5p2",
          usage: { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 0 },
        },
      ],
    });

    await pi.handlers.get("session_start")({}, ctx);
    const status = ctx.statuses.get("fireconnect");
    assert.ok(status, "a seeded session renders immediately");
    assert.match(status, /━/);
    assert.match(status, /GLM 5\.2/);
    assert.match(status, /\$/);
    assert.match(status, /cache/);
  });

  it("tallies message_end calls live and skips zero-usage messages", async () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    const ctx = mockCtx({ entries: [] });

    await pi.handlers.get("session_start")({}, ctx);
    assert.equal(ctx.statuses.get("fireconnect"), undefined, "no billed calls yet — no status line");

    await pi.handlers.get("message_end")({ message: assistantMessage() }, ctx);
    let status = ctx.statuses.get("fireconnect");
    assert.match(status, /GLM 5\.2/);
    assert.match(status, /\$/);

    const before = status;
    await pi.handlers.get("message_end")({ message: { role: "assistant", content: "no usage" } }, ctx);
    assert.equal(ctx.statuses.get("fireconnect"), before, "a message without usage does not churn the line");

    await pi.handlers.get("message_end")({
      message: assistantMessage({
        responseId: "resp_2",
        responseModel: "glm-5p3-flash",
        model: "glm-5p3-flash",
        usage: glmUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }),
      }),
    }, ctx);
    status = ctx.statuses.get("fireconnect");
    assert.match(status, /GLM 5\.3 Flash/, "a second model joins the legend");
  });

  it("prices by the response model, not the requested slot", async () => {
    const row = rowFromAssistantMessage(assistantMessage({
      model: "firerouter/opus",
      responseModel: "glm-5p2",
    }));
    assert.equal(row.model, "glm-5p2");
  });

  it("re-seeds cleanly on a fresh session_start (no leak across sessions)", async () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    const ctx = mockCtx({ entries: [{ type: "message", id: "e1", parentId: null, timestamp: "t", message: assistantMessage() }] });
    await pi.handlers.get("session_start")({}, ctx);
    assert.ok(ctx.statuses.get("fireconnect"));
    const fresh = mockCtx({ entries: [] });
    await pi.handlers.get("session_start")({}, fresh);
    assert.equal(fresh.statuses.get("fireconnect"), undefined, "the tally did not leak across sessions");
  });

  it("renders n/a when a model has no published rate", () => {
    const rows = [
      rowFromAssistantMessage(assistantMessage({ responseModel: "glm-5p2" })),
      rowFromAssistantMessage(assistantMessage({
        responseId: "r2",
        responseModel: "totally-unknown-model",
        model: "totally-unknown-model",
      })),
    ];
    const status = renderUsageStatus(rows);
    assert.match(status, /n\/a/);
    assert.doesNotMatch(status, /\$0\.0000/);
  });

  it("collapses to plain glyphs under NO_COLOR", async () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    const ctx = mockCtx({ entries: [{ type: "message", id: "e1", parentId: null, timestamp: "t", message: assistantMessage() }] });
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      // Re-render through the live path: seed again while NO_COLOR is set.
      const freshPi = mockPi();
      fireconnectPiUsageExtension(freshPi);
      const freshCtx = mockCtx({ entries: [{ type: "message", id: "e1", parentId: null, timestamp: "t", message: assistantMessage() }] });
      await freshPi.handlers.get("session_start")({}, freshCtx);
      const status = freshCtx.statuses.get("fireconnect");
      assert.doesNotMatch(status, /\x1b\[/);
      assert.match(status, /━/);
      void ctx;
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  it("seeds from session entries only, ignoring prompts and system entries", () => {
    const rows = rowsFromSessionEntries([
      { type: "session", version: 3, id: "s", timestamp: "t" },
      { type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "user", content: "go" } },
      { type: "message", id: "e1", parentId: "e0", timestamp: "t", message: assistantMessage() },
      { type: "model_change", id: "m", parentId: null, timestamp: "t", provider: "fireworks", modelId: "firerouter/opus" },
      { type: "message", id: "e2", parentId: null, timestamp: "t", message: { role: "system", content: "" } },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "glm-5p2");
    assert.deepEqual(rowsFromSessionEntries(null), []);
  });

  it("aggregates per-model legend entries with token totals", () => {
    const rows = [
      rowFromAssistantMessage(assistantMessage()),
      rowFromAssistantMessage(assistantMessage({
        responseId: "r2",
        responseModel: "glm-5p3-flash",
        model: "glm-5p3-flash",
        usage: glmUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }),
      })),
    ];
    const models = legendModels(rows);
    assert.equal(models.length, 2);
    assert.equal(models[0].label, "GLM 5.2", "largest spend first");
    assert.equal(models[0].calls, 1);
    assert.equal(models[0].cacheRead, 20_000);
    assert.ok(models[0].costShare > models[1].costShare);
  });

  it("renders the /usage table with a TOTAL row", () => {
    const rows = [
      rowFromAssistantMessage(assistantMessage()),
      rowFromAssistantMessage(assistantMessage({
        responseId: "r2",
        responseModel: "glm-5p3-flash",
        model: "glm-5p3-flash",
        usage: glmUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }),
      })),
    ];
    const lines = usageTableLines(rows);
    assert.match(lines[0], /model/);
    assert.match(lines[0], /calls/);
    assert.ok(lines.some((line) => /GLM 5\.2/.test(line)));
    assert.ok(lines.some((line) => /TOTAL/.test(line)));
    assert.ok(lines.some((line) => /cache/.test(line)));
  });

  it("serves /usage as a dismissable overlay with the table", async () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    const ctx = mockCtx({
      entries: [{ type: "message", id: "e1", parentId: null, timestamp: "t", message: assistantMessage() }],
    });
    await pi.handlers.get("session_start")({}, ctx);

    const command = pi.commands.get("usage");
    await command.handler("", ctx);
    assert.ok(ctx.customFactory, "rows present + tui mode → overlay");
    let doneValue = "not-called";
    const component = ctx.customFactory({}, mockTheme(), {}, (value) => {
      doneValue = value;
    });
    const lines = component.render(100);
    assert.ok(lines.some((line) => /FireConnect usage/.test(line)));
    assert.ok(lines.some((line) => /TOTAL/.test(line)));
    component.handleInput("q");
    assert.equal(doneValue, undefined, "any key dismisses the overlay");
    assert.equal(typeof component.invalidate, "function");
  });

  it("notifies instead of an overlay when nothing was billed", async () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    const ctx = mockCtx({ entries: [] });
    await pi.handlers.get("session_start")({}, ctx);

    await pi.commands.get("usage").handler("", ctx);
    assert.deepEqual(ctx.notifications, ["No billed calls yet this session."]);
  });

  it("skips the overlay outside tui mode", async () => {
    const pi = mockPi();
    fireconnectPiUsageExtension(pi);
    const ctx = mockCtx({
      mode: "rpc",
      entries: [{ type: "message", id: "e1", parentId: null, timestamp: "t", message: assistantMessage() }],
    });
    await pi.handlers.get("session_start")({}, ctx);
    await pi.commands.get("usage").handler("", ctx);
    assert.equal(ctx.customFactory, null);
  });
});
