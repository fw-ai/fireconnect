/**
 * Real-tool driver for `fireconnect demo`'s race.
 *
 * Spawns a `claude -p` (Claude Code, headless) process in an isolated
 * CLAUDE_CONFIG_DIR, and parses its `--output-format stream-json` stdout into a
 * delta/usage/result shape the demo's TUI, measurement, and output-dir writes
 * consume. Token-level streaming comes from `--include-partial-messages`, which
 * emits a `text_delta` `stream_event` per content-block delta.
 *
 * Nothing here touches `~/.claude/settings.json`: routing lives entirely in the
 * tmp `--settings` file for the lifetime of this child. Auth comes from the
 * shared HOME / keychain (no re-login, no second key).
 */

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import { FIRST_TOKEN_TIMEOUT_MS, HARD_RUN_CAP_MS } from "./constants.mjs";
import { FIREWORKS_ENV_KEYS } from "../fireconnect-core.mjs";
import { CLAUDE_FIREROUTER_ENV_KEYS } from "../firerouter-core.mjs";

// Env keys to strip from the child's inherited process env so the isolated
// CLAUDE_CONFIG_DIR's settings.json is the sole source of routing/model/auth.
// Without this, a leaked ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_SONNET_MODEL
// from the parent's Fireworks-routed session would override the clean settings.
const STRIP_CHILD_ENV_KEYS = new Set([...FIREWORKS_ENV_KEYS, ...CLAUDE_FIREROUTER_ENV_KEYS]);

/**
 * Build the child process env for an isolated `claude -p` run: the parent env
 * with all Fireworks/firerouter-owned keys stripped, plus CLAUDE_CONFIG_DIR
 * pointed at the side's clean config dir.
 * @param {Record<string, string>} env
 * @param {string} configDir
 * @returns {Record<string, string>}
 */
function buildChildEnv(env, configDir) {
  const next = {};
  for (const [k, v] of Object.entries(env)) {
    if (!STRIP_CHILD_ENV_KEYS.has(k)) {
      next[k] = v;
    }
  }
  next.CLAUDE_CONFIG_DIR = configDir;
  return next;
}

/**
 * Pure parser for one `stream-json` event (a single decoded JSON object from
 * the tool's stdout). Returns the bits the runner accumulates. Exported for
 * unit testing — no `claude` binary needed.
 *
 * @param {any} obj
 * @returns {{
 *   deltas?: string[],
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   result?: string,
 *   isResult?: boolean,
 *   error?: string,
 *   status?: string,
 * }}
 */
export function parseStreamJson(obj) {
  if (!obj || typeof obj !== "object") {
    return {};
  }
  const out = { deltas: [] };

  if (obj.type === "stream_event" && obj.event) {
    const ev = obj.event;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta"
        && typeof ev.delta.text === "string" && ev.delta.text.length > 0) {
      out.deltas.push(ev.delta.text);
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
      // Reasoning tokens (GLM 5.2, Claude thinking): not shown as app output,
      // but a useful "still working" phase for the pre-first-token panel.
      out.status = "Thinking…";
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      out.status = `Running ${ev.content_block.name || "tool"}…`;
    } else if (ev.type === "message_start") {
      // A new assistant message begins — a boundary for token accumulation
      // across an agentic (multi-message) turn.
      out.messageStart = true;
      out.status = "Model responding…";
      if (typeof ev.message?.usage?.input_tokens === "number") {
        out.inputTokens = ev.message.usage.input_tokens;
      }
    } else if (ev.type === "message_delta" && ev.usage) {
      // message_delta.usage.output_tokens is cumulative for the turn.
      if (typeof ev.usage.output_tokens === "number") {
        out.outputTokens = ev.usage.output_tokens;
      }
    } else if (ev.type === "error" || ev.error) {
      out.error = ev.error?.message || ev.message || JSON.stringify(ev);
    }
    return out;
  }

  if (obj.type === "system") {
    // System events carry no deltas, but their subtype is a phase we can show
    // while waiting on the first token (init = tool booted, api_retry = a
    // transient upstream retry the tool handles itself).
    if (obj.subtype === "init") {
      out.status = "Claude Code ready · sending prompt";
    } else if (obj.subtype === "api_retry") {
      out.status = "Retrying…";
    }
    return out;
  }

  if (obj.type === "result") {
    out.isResult = true;
    out.result = typeof obj.result === "string" ? obj.result : "";
    // The result event may carry total usage under any of these shapes.
    const u = obj.usage || obj.total_usage || obj.result?.usage;
    if (u) {
      if (typeof u.input_tokens === "number") out.inputTokens = u.input_tokens;
      if (typeof u.output_tokens === "number") out.outputTokens = u.output_tokens;
    }
    if (obj.subtype === "error" || obj.is_error) {
      out.error = obj.error || obj.result || "claude result event indicated an error";
    }
    return out;
  }

  // `system` events (init / api_retry / plugin_install) carry no deltas; an
  // api_retry is non-fatal (the tool retries automatically). Nothing to emit.
  return out;
}

/**
 * @typedef {Object} ClaudeRunResult
 * @property {boolean} ok
 * @property {string} text
 * @property {number | null} inputTokens
 * @property {number | null} outputTokens
 * @property {number} seconds
 * @property {{ t: number, text: string }[]} tokenLog
 * @property {string} [error]
 * @property {number} httpStatus
 * @property {string} [errorBody]
 */

/**
 * Spawn a routed `claude -p` headless run and parse its stream-json stdout.
 *
 * @param {{
 *   configDir: string,
 *   cwd: string,
 *   prompt: string,
 *   signal?: AbortSignal,
 *   onDelta?: (text: string, msSinceStart: number) => void,
 *   onTokens?: (tokens: { inputTokens?: number, outputTokens?: number }) => void,
 *   onError?: (result: ClaudeRunResult) => void,
 *   onStatus?: (label: string) => void,
 *   env?: Record<string, string>,
 *   model?: string,
 *   firstTokenTimeoutMs?: number,
 *   hardCapMs?: number,
 * }} args
 * @returns {Promise<ClaudeRunResult>}
 */
export async function runClaude({
  configDir,
  cwd,
  prompt,
  signal,
  onDelta,
  onTokens,
  onError,
  onStatus,
  env = process.env,
  model = "",
  firstTokenTimeoutMs = FIRST_TOKEN_TIMEOUT_MS,
  hardCapMs = HARD_RUN_CAP_MS,
}) {
  const start = performance.now();
  /** @type {{ t: number, text: string }[]} */
  const tokenLog = [];
  // Token accounting across a possibly-agentic (multi-message) turn: sum input
  // over every message_start, and sum each message's final (cumulative) output
  // at the next message boundary. The `result` event's totals, when present, are
  // authoritative and override the accumulators.
  let sumInput = 0;
  let sumOutput = 0;   // banked output of completed messages
  let curOutput = 0;   // cumulative output of the in-flight message
  let resultInput = null;
  let resultOutput = null;
  let text = "";
  let resultText = "";
  let gotResult = false;
  let streamError = "";   // set by an in-stream or result-subtype error event
  let firstDeltaAt = null;
  let stderrTail = "";
  let timedOut = false;

  // Run `claude -p` in an isolated CLAUDE_CONFIG_DIR (the side's clean config
  // dir) so it loads ONLY that dir's settings.json — no merge with the user's
  // ~/.claude/settings.json. Strip Fireworks/firerouter env from the inherited
  // process env so a leaked ANTHROPIC_BASE_URL / model-mapping var can't
  // override the clean settings. The side's settings.json provides routing +
  // auth (inline API key).
  const childEnv = buildChildEnv(env, configDir);
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  // Pin the incumbent model explicitly (the incumbent's clean settings carries
  // no model). The challenger's settings.json sets its own Fireworks model.
  if (model) {
    args.push("--model", model);
  }
  const child = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  // First visible phase — the process is up but Claude Code hasn't emitted any
  // stream events yet. Keeps the pane alive from t=0 instead of dead-air.
  onStatus?.("Starting Claude Code…");

  const recordDelta = (delta) => {
    const t = performance.now() - start;
    tokenLog.push({ t, text: delta });
    text += delta;
    onDelta?.(delta, t);
  };

  // Backstops: first-token stall + hard run cap. Cleared on exit.
  let firstTokenTimer = null;
  let hardCapTimer = null;
  const clearTimers = () => {
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    if (hardCapTimer) clearTimeout(hardCapTimer);
    firstTokenTimer = hardCapTimer = null;
  };
  // The first-token watchdog only fires during the pre-text warm-up. Agentic
  // runs can spend a long time thinking / running tools before the first
  // text_delta, so reset it on any progress signal (status phase, thinking
  // delta, tool-use start) — a true stall is NO activity for the whole window.
  // The hard cap (hardCapMs) still bounds the whole run regardless.
  const resetFirstTokenTimer = () => {
    if (!firstTokenTimer || timedOut || gotResult || firstDeltaAt) return;
    clearTimeout(firstTokenTimer);
    firstTokenTimer = setTimeout(() => {
      if (!firstDeltaAt && !gotResult && !timedOut) {
        timedOut = true;
        child.kill("SIGTERM");
      }
    }, firstTokenTimeoutMs);
  };
  firstTokenTimer = setTimeout(() => {
    if (!firstDeltaAt && !gotResult && !timedOut) {
      timedOut = true;
      child.kill("SIGTERM");
    }
  }, firstTokenTimeoutMs);
  hardCapTimer = setTimeout(() => {
    // Don't kill a child that already produced a result event — it's just
    // finishing its shutdown flush, and killing it would flip a successful run
    // to failed despite complete output + usage.
    if (!timedOut && !gotResult) {
      timedOut = true;
      child.kill("SIGTERM");
    }
  }, hardCapMs);

  // Parent abort (Ctrl-C) → kill the child.
  const onParentAbort = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  if (signal) {
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // non-JSON line (banner/etc.) — ignore
    }
    const parsed = parseStreamJson(obj);
    if (parsed.error) {
      // An in-stream error event OR a `result` event with subtype error. Don't
      // treat the run as successful just because a result event arrived.
      streamError = parsed.error;
    }
    if (parsed.status) {
      onStatus?.(parsed.status);
      // An agentic phase (thinking, tool use, retry) IS progress — push the
      // first-token watchdog back so a long pre-text agentic run isn't killed.
      resetFirstTokenTimer();
    }
    if (parsed.deltas && parsed.deltas.length > 0) {
      for (const d of parsed.deltas) recordDelta(d);
      if (!firstDeltaAt) firstDeltaAt = performance.now();
    }
    if (parsed.isResult) {
      gotResult = true;
      if (parsed.result) resultText = parsed.result;
      if (typeof parsed.inputTokens === "number") resultInput = parsed.inputTokens;
      if (typeof parsed.outputTokens === "number") resultOutput = parsed.outputTokens;
      // The result event's totals are authoritative — surface them to the live
      // meter so the cost reflects real usage as soon as the run finishes.
      onTokens?.({ inputTokens: resultInput ?? undefined, outputTokens: resultOutput ?? undefined });
    } else if (parsed.messageStart) {
      sumOutput += curOutput;
      curOutput = 0;
      if (typeof parsed.inputTokens === "number") {
        sumInput += parsed.inputTokens;
        onTokens?.({ inputTokens: sumInput, outputTokens: sumOutput + curOutput });
      }
    } else if (typeof parsed.outputTokens === "number") {
      curOutput = parsed.outputTokens;
      onTokens?.({ inputTokens: sumInput || undefined, outputTokens: sumOutput + curOutput });
    }
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
    // Keep only the tail so a chatty stderr doesn't grow unbounded.
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("error", (e) => {
      // spawn ENOENT — claude not on PATH.
      stderrBuf += `\n${e.message}`;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code));
  });

  clearTimers();
  if (signal) signal.removeEventListener("abort", onParentAbort);
  stderrTail = stderrBuf.trim();

  const seconds = (performance.now() - start) / 1000;

  // Resolve final token counts: the result event's totals are authoritative;
  // otherwise fall back to the per-message accumulators.
  const accOutput = sumOutput + curOutput;
  const inputTokens = resultInput ?? (sumInput || null);
  const outputTokens = resultOutput ?? (accOutput || null);

  if (timedOut && !gotResult) {
    const which = firstDeltaAt ? "run cap" : "first token";
    const limitMs = firstDeltaAt ? hardCapMs : firstTokenTimeoutMs;
    const stalled = firstDeltaAt
      ? `run cap reached after ${Math.round(limitMs / 1000)}s — runaway agentic loop.`
      : `no tokens after ${Math.round(limitMs / 1000)}s — connection stalled or no content deltas.`;
    const msg = `claude timed out (${which}) ${stalled}`;
    const result = {
      ok: false, text, inputTokens, outputTokens, seconds, tokenLog,
      error: msg, httpStatus: 0, errorBody: stderrTail,
    };
    onError?.(result);
    return result;
  }

  // An in-stream / result-subtype error event means the run failed even if the
  // process exited 0 with a result event — surface it instead of claiming ok.
  if (streamError) {
    const result = {
      ok: false, text, inputTokens, outputTokens, seconds, tokenLog,
      error: streamError, httpStatus: 0, errorBody: stderrTail || streamError,
    };
    onError?.(result);
    return result;
  }

  if (gotResult && exitCode === 0) {
    return {
      ok: true,
      text: text || resultText,
      inputTokens,
      outputTokens,
      seconds,
      tokenLog,
      httpStatus: 200,
    };
  }

  const error = stderrTail
    || `claude exited ${exitCode} with no result${gotResult ? " (result event received but non-zero exit)" : ""}`;
  const result = {
    ok: false, text, inputTokens, outputTokens, seconds, tokenLog,
    error, httpStatus: 0, errorBody: stderrTail,
  };
  onError?.(result);
  return result;
}
