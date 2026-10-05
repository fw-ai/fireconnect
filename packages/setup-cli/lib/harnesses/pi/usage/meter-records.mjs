/**
 * Pi session JSONL → the record shape the shared live meter's Dashboard
 * accumulates (`claude/usage/meter.mjs`).
 *
 * The Dashboard speaks the Claude Code log's record shape: `type: "user"` /
 * `type: "assistant"` records with `message.usage` in Anthropic field names.
 * Pi writes `type: "message"` entries (role inside the message) with usage in
 * its own field names (`input` / `cacheRead` / …) plus the model that actually
 * served (`responseModel`). This adapter is the only place those shapes meet,
 * so the meter itself stays single-shape.
 */

import { claudeUsageFieldsFromPi, servedModelOf } from "./report.mjs";

/**
 * Pi `stopReason` → the settled-stop names the meter understands. Pi stops a
 * turn with `stop` / `length`; anything else (`toolUse`, `error`, `aborted`,
 * `pending`, `deferred`) means the turn continues, so it maps to nothing and
 * the meter keeps its spinner honest.
 */
const SETTLED_STOP_REASON = new Map([
  ["stop", "end_turn"],
  ["length", "max_tokens"],
]);

/**
 * Map one parsed Pi session entry to a meter record, or null to skip it.
 *
 * - user message → a `user` record (a new turn; the meter reads the prompt text)
 * - assistant message with usage → an `assistant` record priced by the model
 *   that actually served, with a stable id (`responseId`) so a re-delivered or
 *   revised message replaces rather than double-counts
 * - `usage` entry (cache warming) → an `assistant` record, so live spend the
 *   report counts shows up in the meter too
 * - everything else (system, tool results, model changes, …) → null
 *
 * @param {any} entry one parsed line of a Pi session JSONL file
 * @returns {{ type: string, message: object } | null}
 */
export function piMeterRecord(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  if (entry.type === "usage" && entry.usage && typeof entry.usage === "object") {
    const model = typeof entry.model === "string" && entry.model.trim() ? entry.model : "";
    if (!model) {
      return null;
    }
    return {
      type: "assistant",
      message: {
        id: "",
        model,
        usage: claudeUsageFieldsFromPi(entry.usage),
      },
    };
  }

  if (entry.type !== "message") {
    return null;
  }
  const message = entry.message && typeof entry.message === "object" ? entry.message : {};
  if (message.role === "user") {
    // A toolResult is the harness answering itself, not a new turn — the
    // meter's prompt reader already ignores tool_result blocks, but skipping
    // here also keeps id-less tool results from being fed at all.
    return { type: "user", message: { content: message.content } };
  }
  if (message.role === "assistant") {
    const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
    if (!usage) {
      return null;
    }
    const settled = SETTLED_STOP_REASON.get(String(message.stopReason ?? ""));
    return {
      type: "assistant",
      message: {
        id: message.responseId || entry.id || "",
        model: servedModelOf(message, entry),
        usage: claudeUsageFieldsFromPi(usage),
        ...(settled ? { stop_reason: settled } : {}),
      },
    };
  }
  return null;
}
