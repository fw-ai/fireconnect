#!/usr/bin/env node
// Claude Code status line: live Fireworks spend vs. the Anthropic-equivalent
// cost, showing how much you save by routing through Fireworks.
//
// Claude Code pipes a status-line JSON object on stdin on every render:
//   { model, transcript_path, workspace: {current_dir}, ... }
// We parse the session transcript for actual per-request token usage, compute
// the real Fireworks cost (reusing the fireconnect pricing/usage modules), and
// compare it to what the same token mix would cost on Anthropic's equivalent
// tier (Opus for GLM, Sonnet for Kimi, Haiku for DeepSeek, Fable for FireRouter).
//
// Output is a single line to stdout — that is what Claude Code renders.
//
// The computation is split into a pure, side-effect-free `computeSavings`
// (exported for unit tests) and a `renderStatusLine` formatter, so the logic
// can be exercised without spawning the process.
import process from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { computeClaudeUsageCost } from "../lib/harnesses/claude/usage.mjs";
import { lookupFireworksPricing } from "../lib/fireworks/pricing.mjs";
import { fireworksModelSlug, shortFireworksModelRef } from "../lib/fireworks/model-id.mjs";
import { providerListPricing } from "../lib/demo/incumbent-detect.mjs";

// Fireworks model -> Anthropic-equivalent tier. Matches the harness slot mapping
// baked into ~/.claude/settings.json (ANTHROPIC_DEFAULT_*_MODEL).
export const ANTHROPIC_EQUIV = {
  // Opus tier (main/heavy)
  "glm-5p2": "claude-opus",
  "glm-5p2-fast": "claude-opus",
  "glm-5p1": "claude-opus",
  "glm-5p1-fast": "claude-opus",
  "glm-fast-latest": "claude-opus",
  "glm-latest": "claude-opus",
  // Sonnet tier
  "kimi-k3": "claude-sonnet",
  "kimi-k3-fast": "claude-sonnet",
  "kimi-k2p7-code": "claude-sonnet",
  "kimi-k2p7-code-fast": "claude-sonnet",
  "kimi-k2p6": "claude-sonnet",
  "kimi-k2p6-fast": "claude-sonnet",
  "kimi-k2p6-turbo": "claude-sonnet",
  "kimi-fast-latest": "claude-sonnet",
  "kimi-latest": "claude-sonnet",
  // Haiku tier
  "deepseek-v4-flash": "claude-haiku",
  "deepseek-v4-pro": "claude-haiku",
  // Fable tier (router)
  firerouter: "claude-fable",
};

// Default anthropic comparison if a Fireworks model has no explicit mapping.
export const DEFAULT_ANTHROPIC_EQUIV = "claude-sonnet";

export function anthropicEquivalentSlug(fwSlug) {
  return ANTHROPIC_EQUIV[fwSlug] ?? DEFAULT_ANTHROPIC_EQUIV;
}

// Cost of one request's token mix at a given rate set (USD per 1M tokens).
// Mirrors computeClaudeUsageCost's token arithmetic but with arbitrary rates,
// so we can price the *same usage* at Anthropic list prices.
export function costAtRates(row, rates) {
  const m = 1_000_000;
  const input = row.input || 0;
  const cacheRead = row.cacheRead || 0;
  const output = row.output || 0;
  const cacheWrite5m = row.cacheWrite5m || 0;
  const cacheWrite1h = row.cacheWrite1h || 0;
  return (
    (input * rates.input
      + cacheWrite5m * rates.cacheWrite5m
      + cacheWrite1h * rates.cacheWrite1h
      + cacheRead * rates.cacheRead
      + output * rates.output)
    / m
  );
}

export function anthropicRatesFor(slug) {
  const r = providerListPricing({ provider: "anthropic", modelId: slug });
  if (!r) {
    return null;
  }
  // Anthropic cache reads are 0.1x input; cache writes 1.25x (5m) / 2x (1h).
  const input = r.inputPerMillion;
  return {
    input,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: r.cachedInputPerMillion || input * 0.1,
    output: r.outputPerMillion,
    label: r.label,
    estimated: r.estimated,
  };
}

// Per-request actual Fireworks cost, computed via the usage module against the
// resolved Fireworks pricing. For firerouter rows (no static rate, so the usage
// module falls back to a reference price), re-price against the concrete
// serverless model the transcript recorded, when Fireworks can price it.
export function fireworksRowCost(model, usage) {
  const row = computeClaudeUsageCost(model, usage);
  if (!row.fireworks) {
    const pricing = lookupFireworksPricing(model);
    if (pricing) {
      return {
        ...row,
        cost: costAtRates(row, {
          input: pricing.input,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: pricing.cachedInput,
          output: pricing.output,
        }),
        fireworks: true,
        fwLabel: pricing.label,
      };
    }
  }
  return { ...row, fwLabel: row.rates?.label };
}

/**
 * Pure computation over a transcript string. Returns the running totals a
 * status-line render needs — no filesystem, no stdout. Exported for tests.
 * @param {string} text JSONL transcript text (may be empty / malformed)
 * @returns {{ fireworksCost: number, anthropicCost: number, requests: number, modelLabel: string }}
 */
export function computeSavings(text) {
  let fireworksCost = 0;
  let anthropicCost = 0;
  let requests = 0;
  let modelLabel = "";

  if (!text) {
    return { fireworksCost, anthropicCost, requests, modelLabel };
  }

  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "assistant") continue;
    const msg = entry.message && typeof entry.message === "object" ? entry.message : {};
    const key = msg.id || entry.requestId || entry.uuid || "";
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    const model = msg.model || entry.model || "?";
    const usage = entry.usage || msg.usage || {};
    const fw = fireworksRowCost(model, usage);
    if (!fw.fireworks) continue; // skip rows we can't price on Fireworks
    fireworksCost += fw.cost;

    const fwSlug = fireworksModelSlug(model);
    const anthRates = anthropicRatesFor(anthropicEquivalentSlug(fwSlug));
    if (anthRates) {
      anthropicCost += costAtRates({
        input: fw.input,
        cacheRead: fw.cacheRead,
        output: fw.output,
        cacheWrite5m: fw.cacheWrite5m,
        cacheWrite1h: fw.cacheWrite1h,
      }, anthRates);
    }
    requests += 1;
    modelLabel = shortFireworksModelRef(model) || modelLabel;
  }

  return { fireworksCost, anthropicCost, requests, modelLabel };
}

// ANSI color helpers (kept light — status lines render on a single line).
export const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[38;5;36m",
  red: "\x1b[38;5;203m",
  cyan: "\x1b[38;5;45m",
  yellow: "\x1b[38;5;214m",
  fwOrange: "\x1b[38;5;208m",
};

function isNoColor() {
  return process.env.CC_STATUSLINE_NOCOLOR === "1"
    || (!process.stdout.isTTY && process.env.CC_STATUSLINE_FORCE_COLOR !== "1");
}

function paint(color, text, { noColor = false } = {}) {
  return noColor ? text : `${color}${text}${COLORS.reset}`;
}

export function fmtUsd(value) {
  if (value < 0.005) {
    return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `$${value.toFixed(2)}`;
}

export function fmtPct(value) {
  return `${Math.max(0, Math.round(value))}%`;
}

/**
 * Render the status line from pre-parsed input. `ctx` mirrors Claude Code's
 * status-line JSON; `transcriptText` is the read transcript (passed in, not
 * read here, so this stays pure and testable).
 * @param {{ model?: string, workspace?: { current_dir?: string }, cwd?: string }=} ctx
 * @param {string} [transcriptText]
 * @param {{ noColor?: boolean }} [opts]
 * @returns {string}
 */
export function renderStatusLine(ctx = {}, transcriptText = "", opts = {}) {
  const noColor = opts.noColor ?? isNoColor();
  const { fireworksCost, anthropicCost, requests, modelLabel } = computeSavings(transcriptText);
  const saved = anthropicCost - fireworksCost;
  const pct = anthropicCost > 0 ? (saved / anthropicCost) * 100 : 0;
  const dir = ctx.workspace?.current_dir || ctx.cwd
    ? path.basename(ctx.workspace?.current_dir || ctx.cwd) : "";
  const label = modelLabel || shortFireworksModelRef(ctx.model || "") || "Fireworks";

  const parts = [];
  parts.push(paint(COLORS.fwOrange, "🔥 Fireworks", { noColor }));
  parts.push(paint(COLORS.dim, "·", { noColor }));
  parts.push(`${paint(COLORS.bold, fmtUsd(fireworksCost), { noColor })} spent`);
  if (requests > 0) {
    parts.push(paint(COLORS.dim, `(${requests} req)`, { noColor }));
  }
  parts.push(paint(COLORS.dim, "vs Anthropic", { noColor }));
  parts.push(paint(COLORS.dim, fmtUsd(anthropicCost), { noColor }));
  if (saved > 0) {
    parts.push(paint(COLORS.green, `saved ${fmtUsd(saved)}`, { noColor }));
    parts.push(paint(COLORS.green, fmtPct(pct), { noColor }));
  } else if (anthropicCost > 0) {
    parts.push(paint(COLORS.yellow, `Δ ${fmtUsd(saved)}`, { noColor }));
  }
  parts.push(paint(COLORS.dim, "·", { noColor }));
  parts.push(paint(COLORS.cyan, String(label), { noColor }));
  if (dir) {
    parts.push(paint(COLORS.dim, "·", { noColor }));
    parts.push(paint(COLORS.dim, dir, { noColor }));
  }

  return parts.join(" ");
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    // If stdin is a TTY (no piped input), don't hang.
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

async function main() {
  const raw = await readStdin();
  let ctx = {};
  if (raw.trim()) {
    try { ctx = JSON.parse(raw); } catch { /* ignore malformed */ }
  }

  let transcriptText = "";
  if (ctx.transcript_path) {
    try {
      transcriptText = await readFile(ctx.transcript_path, "utf8");
    } catch {
      transcriptText = "";
    }
  }

  process.stdout.write(renderStatusLine(ctx, transcriptText));
}

// Only run main when invoked directly as a script, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("cc-fireworks-savings.mjs")) {
  main().catch(() => {
    // Never crash the status line — fall back to a minimal safe line.
    process.stdout.write("🔥 Fireworks");
  });
}
