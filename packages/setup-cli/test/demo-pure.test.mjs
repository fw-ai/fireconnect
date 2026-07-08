import test from "node:test";
import assert from "node:assert/strict";
import { resolvePrompt, DEMO_PRESETS, DEFAULT_DEMO_PRESET } from "../lib/demo/presets.mjs";
import {
  runCost,
  speedRatio,
  costSavedFraction,
  costPerGenerations,
  buildResult,
  formatSpeedRatio,
  formatCostDelta,
  formatUsd,
  formatSeconds,
  formatTokens,
} from "../lib/demo/measurement.mjs";
import { extractHtml, looksRunnable } from "../lib/demo/html-extract.mjs";
import { parseCli } from "../lib/parse-args.mjs";

// ── presets ────────────────────────────────────────────────────────────────

test("presets: default is tetris and contains the HTML-only suffix", () => {
  assert.equal(DEFAULT_DEMO_PRESET, "tetris");
  const t = DEMO_PRESETS.tetris.prompt;
  assert.match(t, /Tetris/i);
  assert.match(t, /Return only a single complete HTML file/);
});

test("presets: each preset ends with the no-fence instruction", () => {
  for (const preset of Object.values(DEMO_PRESETS)) {
    assert.match(preset.prompt, /No explanation, no markdown fences\.$/);
  }
});

test("resolvePrompt: promptFile wins over preset", async () => {
  const result = await resolvePrompt({
    prompt: "tetris",
    promptFile: "/tmp/x.txt",
    readFile: async () => "build a thing",
  });
  assert.equal(result.source, "file");
  assert.equal(result.rawPrompt, "build a thing");
  assert.match(result.prompt, /^build a thing/);
  assert.match(result.prompt, /Return only a single complete HTML file/);
});

test("resolvePrompt: preset id resolves to canned text", async () => {
  const result = await resolvePrompt({ prompt: "snake" });
  assert.equal(result.source, "preset");
  assert.equal(result.presetId, "snake");
  assert.equal(result.prompt, DEMO_PRESETS.snake.prompt);
});

test("resolvePrompt: unknown string is treated as a literal prompt", async () => {
  const result = await resolvePrompt({ prompt: "build me a calculator" });
  assert.equal(result.source, "literal");
  assert.equal(result.rawPrompt, "build me a calculator");
  assert.match(result.prompt, /^build me a calculator/);
  assert.match(result.prompt, /Return only a single complete HTML file/);
  assert.match(result.prompt, /No explanation, no markdown fences\.$/);
});

test("resolvePrompt: custom sentinel requires a real task", async () => {
  await assert.rejects(
    () => resolvePrompt({ prompt: "custom" }),
    /requires --prompt/,
  );
});

test("resolvePrompt: custom channel treats a literal 'custom' task as a real prompt", async () => {
  const result = await resolvePrompt({ custom: "custom" });
  assert.equal(result.source, "literal");
  assert.equal(result.rawPrompt, "custom");
  assert.match(result.prompt, /^custom/);
  assert.match(result.prompt, /Return only a single complete HTML file/);
});

test("resolvePrompt: custom channel wins over prompt/preset interpretation", async () => {
  const result = await resolvePrompt({ prompt: "snake", custom: "build a maze" });
  assert.equal(result.source, "literal");
  assert.equal(result.rawPrompt, "build a maze");
});

test("resolvePrompt: default preset when nothing passed", async () => {
  const result = await resolvePrompt({});
  assert.equal(result.presetId, DEFAULT_DEMO_PRESET);
});

test("resolvePrompt: empty prompt file throws", async () => {
  await assert.rejects(
    () => resolvePrompt({ promptFile: "/tmp/empty.txt", readFile: async () => "   " }),
    /empty/i,
  );
});

// ── measurement ─────────────────────────────────────────────────────────────

test("runCost: input + output at per-Mtok rates", () => {
  // 1000 in @ $3/Mtok = $0.003 ; 2000 out @ $15/Mtok = $0.030 → $0.033
  assert.equal(
    runCost({ inputTokens: 1000, outputTokens: 2000, inputPerMillion: 3, outputPerMillion: 15 }),
    0.033,
  );
});

test("runCost: zero tokens is zero cost", () => {
  assert.equal(runCost({ inputTokens: 0, outputTokens: 0, inputPerMillion: 3, outputPerMillion: 15 }), 0);
});

test("speedRatio: incumbent 2x slower than fireworks", () => {
  assert.equal(speedRatio({ incumbentSeconds: 6, fireworksSeconds: 3 }), 2);
});

test("speedRatio: zero fireworks time degrades to 0 (honest, no div-by-zero)", () => {
  assert.equal(speedRatio({ incumbentSeconds: 6, fireworksSeconds: 0 }), 0);
});

test("costSavedFraction: fireworks at half the cost saves 50%", () => {
  assert.equal(costSavedFraction({ incumbentCost: 0.10, fireworksCost: 0.05 }), 0.5);
});

test("costSavedFraction: fireworks more expensive yields negative (honestly)", () => {
  assert.equal(costSavedFraction({ incumbentCost: 0.05, fireworksCost: 0.10 }), -1);
});

test("costPerGenerations: linear extrapolation", () => {
  assert.equal(costPerGenerations({ cost: 0.01, generations: 1000 }), 10);
});

test("buildResult: summary flags driven by real numbers", () => {
  const result = buildResult({
    incumbent: { seconds: 8, cost: 0.05, ok: true },
    fireworks: { seconds: 2, cost: 0.01, ok: true },
    prompt: { title: "Tetris", text: "x", source: "preset" },
    mode: "key-race",
  });
  assert.equal(result.summary.speedRatio, 4);
  assert.equal(result.summary.costSavedFraction, 0.8);
  assert.equal(result.summary.incumbentFaster, false);
  assert.equal(result.summary.fireworksCheaper, true);
  assert.equal(result.mode, "key-race");
  assert.ok(!("seed" in result));
});

test("buildResult: when incumbent is actually faster, flags say so", () => {
  const result = buildResult({
    incumbent: { seconds: 2, cost: 0.01, ok: true },
    fireworks: { seconds: 8, cost: 0.05, ok: true },
    prompt: { title: "x", text: "x", source: "literal" },
    mode: "harness-swap",
  });
  assert.equal(result.summary.speedRatio, 0.25);
  assert.equal(result.summary.incumbentFaster, true);
  assert.equal(result.summary.fireworksCheaper, false);
});

// ── formatting (display-only rounding) ───────────────────────────────────────

test("formatSpeedRatio", () => {
  assert.equal(formatSpeedRatio(3.14), "3.1×");
  assert.equal(formatSpeedRatio(0), "—");
});

test("formatCostDelta: cheaper / more expensive / same", () => {
  assert.equal(formatCostDelta(0.5), "50% cheaper");
  assert.equal(formatCostDelta(-0.1), "10% more expensive");
  // 0.1% rounds to 0% → displayed as "same cost" (display rounding, honest).
  assert.equal(formatCostDelta(0.001), "same cost");
  assert.equal(formatCostDelta(0), "same cost");
});

test("formatUsd trims trailing zeros", () => {
  assert.equal(formatUsd(0.0061), "$0.0061");
  assert.equal(formatUsd(0.01), "$0.01");
  assert.equal(formatUsd(0), "$0");
});

test("formatSeconds and formatTokens", () => {
  assert.equal(formatSeconds(3.14), "3.1s");
  assert.equal(formatTokens(2210), "2,210");
});

// ── html extraction ─────────────────────────────────────────────────────────

test("extractHtml: passes through clean HTML", () => {
  const html = "<!doctype html><html><body><p>hi</p></body></html>";
  const r = extractHtml(html);
  assert.equal(r.ok, true);
  assert.equal(r.html, html);
});

test("extractHtml: strips ```html fences", () => {
  const raw = "Here you go:\n```html\n<!doctype html><html><body>hi</body></html>\n```\n";
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.equal(r.html, "<!doctype html><html><body>hi</body></html>");
});

test("extractHtml: trims leading prose up to <html>", () => {
  const raw = "Sure! Here's the file:\n<html><body><canvas/></body></html>\nthanks!";
  const r = extractHtml(raw);
  assert.equal(r.ok, true);
  assert.match(r.html, /^<html>/);
  assert.match(r.html, /<\/html>$/);
});

test("extractHtml: empty input is not ok", () => {
  assert.equal(extractHtml("").ok, false);
  assert.equal(extractHtml("   ").ok, false);
});

test("extractHtml: plain prose with no tags is not ok", () => {
  const r = extractHtml("I can't help with that.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no html/i);
});

test("looksRunnable", () => {
  assert.equal(looksRunnable("<html><script>x</script></html>"), true);
  assert.equal(looksRunnable("just text"), false);
});

// ── parse-args: demo command ────────────────────────────────────────────────

test("parseCli: demo with positional preset folds into ctx.prompt", () => {
  const parsed = parseCli(["demo", "snake"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.ctx.prompt, "snake");
});

test("parseCli: demo custom is accepted as the fifth prompt option", () => {
  const parsed = parseCli(["demo", "custom"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.ctx.prompt, "custom");
});

test("parseCli: demo --prompt flag", () => {
  const parsed = parseCli(["demo", "--prompt", "clock"]);
  assert.equal(parsed.kind, "demo");
  assert.equal(parsed.ctx.prompt, "clock");
});

test("parseCli: explicit --prompt wins over positional preset", () => {
  const parsed = parseCli(["demo", "tetris", "--prompt", "snake"]);
  assert.equal(parsed.ctx.prompt, "snake");
});

test("parseCli: unknown preset rejected", () => {
  assert.throws(() => parseCli(["demo", "pong"]), /Unknown demo preset: pong/);
});

test("parseCli: demo flags parsed", () => {
  const parsed = parseCli([
    "demo", "--challenger", "glm-5p2", "--no-open",
    "--out", "./x", "--yes", "--json",
  ]);
  assert.equal(parsed.ctx.challenger, "glm-5p2");
  assert.equal(parsed.ctx.noOpen, true);
  assert.equal(parsed.ctx.out, "./x");
  assert.equal(parsed.ctx.yes, true);
  assert.equal(parsed.ctx.json, true);
});

test("parseCli: demo --anthropic-model sets ctx.anthropicModel", () => {
  assert.equal(parseCli(["demo", "--anthropic-model", "opus"]).ctx.anthropicModel, "opus");
});

test("parseCli: demo --mode is accepted but ignored (single mode)", () => {
  // The demo no longer has modes; --mode is a no-op global flag that doesn't error.
  assert.equal(parseCli(["demo", "--mode", "harness-swap"]).ctx.mode, "harness-swap");
});

test("parseCli: --seed is no longer accepted", () => {
  assert.throws(() => parseCli(["demo", "--seed", "7"]), /Unknown argument: --seed/);
});

test("parseCli: demo --prompt-file", () => {
  const parsed = parseCli(["demo", "--prompt-file", "/tmp/p.txt"]);
  assert.equal(parsed.ctx.promptFile, "/tmp/p.txt");
});

test("parseCli: demo clean sets ctx.clean and takes --out/--yes", () => {
  const bare = parseCli(["demo", "clean"]);
  assert.equal(bare.kind, "demo");
  assert.equal(bare.ctx.clean, true);
  const withFlags = parseCli(["demo", "clean", "--out", "./x", "--yes"]);
  assert.equal(withFlags.ctx.clean, true);
  assert.equal(withFlags.ctx.out, "./x");
  assert.equal(withFlags.ctx.yes, true);
});

test("parseCli: a normal demo run has clean=false", () => {
  assert.equal(parseCli(["demo", "snake"]).ctx.clean, false);
});

test("parseCli: demo clean rejects a trailing preset", () => {
  assert.throws(() => parseCli(["demo", "clean", "snake"]), /clean takes no preset/);
});

test("parseCli: global flags may precede the demo command", () => {
  // Regression: `--json demo` used to throw "Unknown command: demo" after the
  // isolation refactor. It must resolve the same as `demo --json`.
  const a = parseCli(["--json", "demo", "snake"]);
  assert.equal(a.kind, "demo");
  assert.equal(a.ctx.json, true);
  assert.equal(a.ctx.prompt, "snake");
  const b = parseCli(["--home", "/tmp/x", "demo"]);
  assert.equal(b.kind, "demo");
  assert.equal(b.ctx.home, "/tmp/x");
  assert.equal(parseCli(["--json", "demo", "clean"]).ctx.clean, true);
});

test("parseCli: demo accepts shared global flags (e.g. --settings-path)", () => {
  const parsed = parseCli(["demo", "--settings-path", "/s"]);
  assert.equal(parsed.ctx.settingsPath, "/s");
});
