import test from "node:test";
import assert from "node:assert/strict";

import {
  parseStreamJson,
  priceClaudeUsage,
} from "../../lib/demo/claude-runner.mjs";
import { computeClaudeUsageCost } from "../../lib/harnesses/claude/usage/pricing.mjs";
import {
  getServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";

test("demo and transcript/statusline pricing use the same serverless rates", () => {
  const usage = {
    input_tokens: 17_319,
    cache_read_input_tokens: 0,
    output_tokens: 11,
  };
  const demo = priceClaudeUsage({
    model: "glm-5p3[1m]",
    resolvedModel: "accounts/fireworks/models/glm-5p3",
    usage,
  });
  const transcript = computeClaudeUsageCost("accounts/fireworks/models/glm-5p3", usage);

  assert.equal(demo.cost, 0.024295);
  assert.equal(demo.cost, transcript.cost);
  assert.deepEqual(demo.rates, transcript.rates);
});

test("demo returns no price when neither selected nor resolved model has a rate", () => {
  const pricing = priceClaudeUsage({
    model: "firerouter",
    resolvedModel: "accounts/fireworks/models/not-in-the-catalog",
    usage: { input_tokens: 10_000, output_tokens: 100 },
  });
  assert.equal(pricing.cost, null);
  assert.equal(pricing.rates, null);
});

test("demo prices FireRouter from its served backend even if the router has a catalog rate", () => {
  const previousSnapshot = getServerlessCatalogSnapshot();
  setServerlessCatalogSnapshot({
    entries: [],
    pricingById: new Map([[
      "accounts/fireworks/routers/firerouter",
      {
        slug: "firerouter",
        label: "FireRouter",
        input: 99,
        cachedInput: 99,
        output: 99,
        tier: "standard",
        source: "test",
      },
    ]]),
    inputModalitiesById: new Map(),
    routerBaseModelById: new Map(),
    contextLengthById: new Map(),
    supportsToolsById: new Map(),
  });
  try {
    const pricing = priceClaudeUsage({
      model: "firerouter[1m]",
      resolvedModel: "accounts/fireworks/models/glm-5p3",
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    assert.equal(pricing.cost, 1.4);
    assert.equal(pricing.rates.label, "GLM 5.3");
  } finally {
    setServerlessCatalogSnapshot(previousSnapshot);
  }
});

test("parseStreamJson: text_delta yields a delta", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
  });
  assert.deepEqual(out.deltas, ["Hello"]);
});

test("parseStreamJson: empty text_delta is not emitted", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } },
  });
  assert.deepEqual(out.deltas, []);
});

test("parseStreamJson: non-text deltas (tool input) are ignored for app output", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
  });
  assert.deepEqual(out.deltas, []);
  assert.deepEqual(out.thinkingDeltas, []);
});

test("parseStreamJson: thinking_delta is surfaced separately from app output", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
  });
  assert.deepEqual(out.deltas, []);
  assert.deepEqual(out.thinkingDeltas, ["hmm"]);
  assert.match(out.status, /thinking/i);
});

test("parseStreamJson: message_start carries input_tokens and marks a boundary", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "message_start", message: { usage: { input_tokens: 42, output_tokens: 1 } } },
  });
  assert.equal(out.inputTokens, 42);
  assert.equal(out.messageStart, true);
});

test("parseStreamJson: message_start without usage still marks a boundary", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "message_start", message: {} },
  });
  assert.equal(out.messageStart, true);
  assert.equal(out.inputTokens, undefined);
});

test("parseStreamJson: message_delta carries cumulative output_tokens", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "message_delta", usage: { output_tokens: 128 } },
  });
  assert.equal(out.outputTokens, 128);
});

test("parseStreamJson: result event sets isResult + result text + usage", () => {
  const out = parseStreamJson({
    type: "result",
    result: "<html>final</html>",
    usage: { input_tokens: 100, output_tokens: 500 },
  });
  assert.equal(out.isResult, true);
  assert.equal(out.result, "<html>final</html>");
  assert.equal(out.inputTokens, 100);
  assert.equal(out.outputTokens, 500);
});

test("parseStreamJson: result event usage under total_usage shape", () => {
  const out = parseStreamJson({
    type: "result",
    result: "done",
    total_usage: { input_tokens: 7, output_tokens: 9 },
  });
  assert.equal(out.inputTokens, 7);
  assert.equal(out.outputTokens, 9);
});

test("parseStreamJson: result event preserves Claude Code's diagnostic costUsd", () => {
  // Claude Code reports its own cost via total_cost_usd (and a per-model
  // modelUsage breakdown). Keep it for diagnostics, but the demo must price the
  // result usage through the resolved model's provider rates instead.
  const out = parseStreamJson({
    type: "result",
    result: "done",
    total_cost_usd: 0.134824,
    usage: { input_tokens: 26894, cache_read_input_tokens: 358, output_tokens: 7 },
    modelUsage: { "firerouter[1m]": { costUSD: 0.134824, canonicalModel: "firerouter[1m]" } },
  });
  assert.equal(out.costUsd, 0.134824);
});

test("parseStreamJson: costUsd falls back to modelUsage sum when total_cost_usd absent", () => {
  const out = parseStreamJson({
    type: "result",
    result: "done",
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {
      "claude-opus-5[1m]": { costUSD: 0.88 },
      "claude-haiku-4-5[1m]": { costUSD: 0.01 },
    },
  });
  assert.equal(out.costUsd, 0.89);
});

test("parseStreamJson: result event splits cache write (by TTL) and read buckets", () => {
  // Real Anthropic runs report cache_creation with a per-TTL breakdown
  // (ephemeral_1h / ephemeral_5m) and cache_read_input_tokens. Writes are billed
  // at a premium (differing by TTL); reads at a discount — they must stay separate.
  const out = parseStreamJson({
    type: "result",
    result: "done",
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 87990,
      cache_read_input_tokens: 1500,
      output_tokens: 12,
      cache_creation: { ephemeral_1h_input_tokens: 80000, ephemeral_5m_input_tokens: 7990 },
    },
  });
  assert.equal(out.inputTokens, 2);
  assert.equal(out.cacheWrite1hTokens, 80000);
  assert.equal(out.cacheWrite5mTokens, 7990);
  assert.equal(out.cacheReadTokens, 1500);
  assert.equal(out.outputTokens, 12);
});

test("parseStreamJson: cache write without per-TTL breakdown assumes 5m", () => {
  // Matches computeClaudeUsageCost (usage/report.mjs): a flat cache_creation_input_tokens
  // with no per-TTL breakdown is bucketed as 5m, not 1h — 1h bills at a premium,
  // so assuming 1h would overprice. The two functions must agree on identical data.
  const out = parseStreamJson({
    type: "result",
    result: "done",
    usage: { input_tokens: 2, cache_creation_input_tokens: 87990, cache_read_input_tokens: 0, output_tokens: 12 },
  });
  assert.equal(out.cacheWrite5mTokens, 87990);
  assert.equal(out.cacheWrite1hTokens, undefined);
  assert.equal(out.cacheReadTokens, undefined);
});

test("parseStreamJson: message_start cache buckets are extracted too", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 1000,
          cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 1000 },
        },
      },
    },
  });
  assert.equal(out.inputTokens, 3);
  assert.equal(out.cacheWrite1hTokens, 4000);
  assert.equal(out.cacheWrite5mTokens, 1000);
  assert.equal(out.cacheReadTokens, 1000);
});

test("parseStreamJson: tool_use start and streaming input_json_delta are surfaced", () => {
  // Agentic models (Opus 5) write the app with the Write tool, so the file body
  // arrives as input_json_delta — NOT text_delta. Without surfacing these the
  // pane sits empty for the whole tool phase while tokens and cost climb.
  const start = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name: "Write" } },
  });
  assert.deepEqual(start.toolUseStart, { name: "Write" });
  assert.match(start.status, /Write/);

  const chunk = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"content":"<!DOC' } },
  });
  assert.equal(chunk.toolInputJson, '{"content":"<!DOC');
  // Tool content must NOT be reported as a normal text delta — the runner routes
  // it to the display only, keeping the extraction buffer a single clean copy.
  assert.deepEqual(chunk.deltas, []);

  const stop = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_stop" },
  });
  assert.equal(stop.contentBlockStop, true);
});

test("parseStreamJson: assistant/message_start surface the model that actually ran", () => {
  // The --model argument is often an alias that resolves to something else:
  // firerouter[1m] AND glm-fast-latest[1m] both report glm-5p2. Pricing must key
  // off this resolved id, not the requested alias.
  const asst = parseStreamJson({
    type: "assistant",
    message: { model: "accounts/fireworks/models/glm-5p2" },
  });
  assert.equal(asst.resolvedModel, "accounts/fireworks/models/glm-5p2");

  const start = parseStreamJson({
    type: "stream_event",
    event: { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 5 } } },
  });
  assert.equal(start.resolvedModel, "claude-opus-5");

  // An assistant message with no model must not clobber a previously resolved id.
  const bare = parseStreamJson({ type: "assistant", message: {} });
  assert.equal(bare.resolvedModel, undefined);
});

test("parseStreamJson: api_retry is flagged so a transient error can be cleared", () => {
  // A 529 (Overloaded) arrives as an in-stream error, then Claude Code retries
  // and succeeds. streamError used to be sticky, so a race that actually
  // completed fine was reported as failed. api_retry is the signal to clear it.
  const retry = parseStreamJson({ type: "system", subtype: "api_retry" });
  assert.equal(retry.apiRetry, true);
  assert.match(retry.status, /retry/i);

  // A clean result event carries no error, which is what lets the runner clear
  // a sticky earlier failure.
  const ok = parseStreamJson({ type: "result", subtype: "success", result: "<html></html>" });
  assert.equal(ok.isResult, true);
  assert.equal(ok.error, undefined);
});

test("parseStreamJson: result-event errors surface the actual cause", () => {
  // Claude Code usually sets neither `error` nor `result` on a failure, so the
  // old `obj.error || obj.result || "<generic>"` collapsed every failure to
  // "claude result event indicated an error" while the real cause sat unread in
  // the event.
  assert.match(
    parseStreamJson({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 12 }).error,
    /error_max_turns.*12 turns/,
  );
  assert.match(
    parseStreamJson({ type: "result", subtype: "error", is_error: true, api_error_status: 529 }).error,
    /api status 529/,
  );
  assert.match(
    parseStreamJson({ type: "result", subtype: "error", is_error: true, stop_reason: "refusal", result: "I cannot help." }).error,
    /refusal.*I cannot help/,
  );
  // A direct error string still wins over the assembled description.
  assert.equal(
    parseStreamJson({ type: "result", is_error: true, error: "Overloaded" }).error,
    "Overloaded",
  );
  // Nothing to report at all still points somewhere useful.
  assert.match(
    parseStreamJson({ type: "result", subtype: "error", is_error: true }).error,
    /FC_DEBUG/,
  );
});

test("parseStreamJson: in-stream error event surfaces a message", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  });
  assert.equal(out.error, "Overloaded");
});

test("parseStreamJson: system init / api_retry carry no deltas or error, but a phase status", () => {
  const init = parseStreamJson({ type: "system", subtype: "init" });
  assert.deepEqual(init.deltas, []);
  assert.equal(init.error, undefined);
  assert.match(init.status, /ready/i);
  const retry = parseStreamJson({ type: "system", subtype: "api_retry", attempt: 1 });
  assert.deepEqual(retry.deltas, []);
  assert.match(retry.status, /retry/i);
});

test("parseStreamJson: phase statuses for message_start, tool_use, and thinking", () => {
  const start = parseStreamJson({
    type: "stream_event",
    event: { type: "message_start", message: {} },
  });
  // message_start fires before any content — the status must not claim the model
  // is already producing output (Opus can reason silently for a long time).
  assert.match(start.status, /reasoning/i);

  const tool = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name: "Write" } },
  });
  assert.match(tool.status, /Running Write/);

  const thinking = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
  });
  assert.deepEqual(thinking.deltas, []);
  assert.deepEqual(thinking.thinkingDeltas, ["hmm"]);
  assert.match(thinking.status, /thinking/i);
});

test("parseStreamJson: non-object input is a no-op", () => {
  assert.deepEqual(parseStreamJson(null), {});
  assert.deepEqual(parseStreamJson("not an object"), {});
});
