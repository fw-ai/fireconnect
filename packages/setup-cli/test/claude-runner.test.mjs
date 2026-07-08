import test from "node:test";
import assert from "node:assert/strict";

import { parseStreamJson } from "../lib/demo/claude-runner.mjs";

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

test("parseStreamJson: non-text deltas (thinking, tool input) are ignored for the race", () => {
  const out = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
  });
  assert.deepEqual(out.deltas, []);
  const out2 = parseStreamJson({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
  });
  assert.deepEqual(out2.deltas, []);
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
  assert.match(start.status, /responding/i);

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
  assert.match(thinking.status, /thinking/i);
});

test("parseStreamJson: non-object input is a no-op", () => {
  assert.deepEqual(parseStreamJson(null), {});
  assert.deepEqual(parseStreamJson("not an object"), {});
});
