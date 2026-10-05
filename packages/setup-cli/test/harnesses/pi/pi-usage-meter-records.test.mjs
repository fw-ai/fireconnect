import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  piMeterRecord,
} from "../../../lib/harnesses/pi/usage/meter-records.mjs";
import {
  claudeUsageFieldsFromPi,
} from "../../../lib/harnesses/pi/usage/report.mjs";

describe("piMeterRecord", () => {
  it("maps user messages to user records with content passthrough", () => {
    const rec = piMeterRecord({
      type: "message",
      id: "e0",
      parentId: null,
      timestamp: "t",
      message: { role: "user", content: "fix the bug" },
    });
    assert.deepEqual(rec, { type: "user", message: { content: "fix the bug" } });

    const arrayRec = piMeterRecord({
      type: "message",
      id: "e1",
      parentId: "e0",
      timestamp: "t",
      message: { role: "user", content: [{ type: "text", text: "array prompt" }] },
    });
    assert.deepEqual(arrayRec, {
      type: "user",
      message: { content: [{ type: "text", text: "array prompt" }] },
    });
  });

  it("maps assistant messages to assistant records with claude field names", () => {
    const rec = piMeterRecord({
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "t",
      message: {
        role: "assistant",
        model: "firerouter/opus",
        responseModel: "glm-5p2",
        responseId: "resp_9",
        stopReason: "stop",
        usage: { input: 1_000, output: 100, cacheRead: 20_000, cacheWrite: 500 },
      },
    });
    assert.deepEqual(rec, {
      type: "assistant",
      message: {
        id: "resp_9",
        model: "glm-5p2",
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 20_000,
          cache_creation_input_tokens: 500,
          output_tokens: 100,
        },
        stop_reason: "end_turn",
      },
    });
  });

  it("keeps the turn unsettled when the model went for tools", () => {
    const rec = piMeterRecord({
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "t",
      message: {
        role: "assistant",
        model: "glm-5p2",
        responseId: "resp_9",
        stopReason: "toolUse",
        usage: { input: 1, output: 1 },
      },
    });
    assert.equal(Object.hasOwn(rec.message, "stop_reason"), false, "toolUse must not look settled");
  });

  it("maps max-token stops to the settled max_tokens reason", () => {
    const rec = piMeterRecord({
      type: "message",
      id: "e",
      parentId: null,
      timestamp: "t",
      message: {
        role: "assistant",
        model: "glm-5p2",
        stopReason: "length",
        usage: { input: 1, output: 1 },
      },
    });
    assert.equal(rec.message.stop_reason, "max_tokens");
  });

  it("falls back to the entry id when no responseId exists", () => {
    const rec = piMeterRecord({
      type: "message",
      id: "e9",
      parentId: null,
      timestamp: "t",
      message: { role: "assistant", model: "glm-5p2", usage: { input: 1, output: 1 } },
    });
    assert.equal(rec.message.id, "e9");
  });

  it("maps usage entries (cache warming) to assistant records", () => {
    const rec = piMeterRecord({
      type: "usage",
      id: "u1",
      parentId: null,
      timestamp: "t",
      kind: "cache_warm",
      provider: "fireworks",
      model: "glm-5p2",
      usage: { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 0 },
    });
    assert.deepEqual(rec, {
      type: "assistant",
      message: {
        id: "",
        model: "glm-5p2",
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
  });

  it("skips non-call entries and assistant messages without usage", () => {
    assert.equal(piMeterRecord(null), null);
    assert.equal(piMeterRecord({}), null);
    assert.equal(piMeterRecord({ type: "session", id: "s" }), null);
    assert.equal(piMeterRecord({ type: "model_change", provider: "fireworks", modelId: "firerouter/opus" }), null);
    assert.equal(piMeterRecord({ type: "thinking_level_change", thinkingLevel: "high" }), null);
    assert.equal(piMeterRecord({ type: "compaction", summary: "…" }), null);
    assert.equal(piMeterRecord({
      type: "message",
      id: "e",
      parentId: null,
      timestamp: "t",
      message: { role: "assistant", content: "no usage" },
    }), null);
    assert.equal(piMeterRecord({
      type: "message",
      id: "e",
      parentId: null,
      timestamp: "t",
      message: { role: "toolResult", content: "…" },
    }), null);
    assert.equal(piMeterRecord({
      type: "message",
      id: "e",
      parentId: null,
      timestamp: "t",
      message: { role: "system", content: "" },
    }), null);
    assert.equal(piMeterRecord({ type: "usage", kind: "cache_warm", usage: { input: 1 } }), null, "model-less usage entry");
  });
});

describe("claudeUsageFieldsFromPi", () => {
  it("renames pi fields and zeroes missing ones", () => {
    assert.deepEqual(claudeUsageFieldsFromPi({ input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }), {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 40,
    });
    assert.deepEqual(claudeUsageFieldsFromPi(), {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    });
  });
});
