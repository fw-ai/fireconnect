import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SplitPaneRenderer } from "../lib/demo/tui.mjs";
import { buildCompareHtml, serveStatic } from "../lib/demo/browser.mjs";
import http from "node:http";
import { detectIncumbent, detectActiveFireworksHarness, incumbentPricing, providerListPricing } from "../lib/demo/incumbent-detect.mjs";
import {
  isAuthFailure, isDemoOutputDir, findStaleDemoTmp, runDemoClean,
} from "../lib/demo/command.mjs";
import { buildResult } from "../lib/demo/measurement.mjs";
import {
  prepareOutputDir, writeStreamLog, writeAppHtml, writeResultJson, writeCompareHtml,
  readBestHtmlFromDir,
} from "../lib/demo/output.mjs";

// ── a capturing fake stdout for the TUI ──────────────────────────────────────

function fakeStdout({ columns = 100, rows = 24 } = {}) {
  const buf = { out: "" };
  return {
    isTTY: true,
    columns,
    rows,
    write(s) { buf.out += s; },
    _buf: buf,
  };
}

const header = (provider, model, costLabel, rates) => ({ provider, model, costLabel, rates });

// ── TUI ─────────────────────────────────────────────────────────────────────

test("tui: split layout renders two columns with a divider and the right number of rows", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude Sonnet 5", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  r.pushDelta("fireworks", "<!doctype html><html><body>hi</body></html>");
  r.pushDelta("incumbent", "<html><body>ok</body></html>");
  r.finish("fireworks", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 1.2, cost: 0.001 });
  r.finish("incumbent", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 4.8, cost: 0.01 });
  r.stop();

  // divider present
  assert.match(out._buf.out, /│/);
  // both model labels rendered
  assert.match(out._buf.out, /Claude Sonnet 5/);
  assert.match(out._buf.out, /GLM 5.2 Fast/);
  // done markers
  assert.match(out._buf.out, /done ✓/);
  // cursor restored (SHOW_CURSOR = ESC[?25h)
  assert.ok(out._buf.out.includes("\x1b[?25h"));
});

test("tui: stacked layout under 80 columns", () => {
  const out = fakeStdout({ columns: 60, rows: 20 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  assert.equal(r.stacked, true);
  r.start();
  r.finish("incumbent", { ok: true, inputTokens: 5, outputTokens: 5, seconds: 2, cost: 0.001 });
  r.finish("fireworks", { ok: true, inputTokens: 5, outputTokens: 5, seconds: 1, cost: 0.001 });
  r.stop();
  // no vertical divider in stacked mode
  assert.doesNotMatch(out._buf.out.slice(0, 200), /│/);
});

test("tui: failed side shows failed marker", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  r.finish("incumbent", { ok: false, inputTokens: 0, outputTokens: 0, seconds: 1, cost: 0, error: "boom" });
  r.finish("fireworks", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 1.2, cost: 0.001 });
  r.stop();
  assert.match(out._buf.out, /failed ✗/);
});

// Regression: freeze() is called the instant a side's runner resolves, but
// finish() (which sets ok) only runs after finalizeBoth. Between them the side
// is frozen (done) with ok still undetermined — it must NOT flash "failed ✗"
// for a side that will be marked successful.
test("tui: freeze(side, true) immediately shows the full bar + done ✓ (no moving sweep)", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  r.pushDelta("incumbent", "<h1>hi</h1>"); // a successful side produces output
  r.freeze("incumbent", true);             // runner resolved successfully → done ✓ at once
  r.render();
  assert.match(out._buf.out, /done ✓/);
  assert.doesNotMatch(out._buf.out, /failed ✗/);
  // finish() later reconciles tokens/cost but preserves the done ✓ state.
  r.finish("incumbent", { ok: true, inputTokens: 5, outputTokens: 20, seconds: 2, cost: 0.001 });
  r.stop();
  assert.match(out._buf.out, /done ✓/);
});

test("tui: freeze(side, false) immediately shows failed ✗", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  r.freeze("incumbent", false);
  r.render();
  assert.match(out._buf.out, /failed ✗/);
  r.stop();
});

// Regression: a failed side's error must NOT be counted as output tokens.
// Pre-fix, the error was pushed through pushDelta, so the meter showed
// floor(errorLen/4) phantom tokens (e.g. "58 tok" off a ~232-char error).
// The error now renders in the body directly and the meter shows 0.
test("tui: failed side shows 0 tok and renders the error in the body, not phantom tokens", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  // A long error string — under the old bug this would read "58 tok".
  const longError = "Anthropic request failed (400 ): " + "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"x\"}}".padEnd(200, "y");
  r.finish("incumbent", { ok: false, inputTokens: 0, outputTokens: 0, seconds: 0.4, cost: 0, error: longError });
  r.finish("fireworks", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 1.2, cost: 0.001 });
  r.stop();
  const plain = out._buf.out.replace(/\x1b\[[0-9;]*m/g, "");
  // The failed side honors outputTokens:0 → "↑ 0 tok". (Fireworks shows 20,
  // so a "0 tok" reading can only come from the failed incumbent side.) Under
  // the old bug the error was pushed via pushDelta and the meter computed
  // floor(errorLen/4) ≈ 58 phantom tokens instead.
  assert.match(plain, /↑ 0 tok/);
  assert.match(plain, /failed ✗/);
  // the error text is shown in the body
  assert.match(plain, /Anthropic request failed/);
});

// A side that's in flight (not done, no deltas yet) must NOT render a blank
// pane — that reads as "nothing is happening" while we wait on first token.
// It surfaces a dim "waiting for first token…" placeholder in the body.
test("tui: in-flight side with no deltas shows a waiting placeholder, not a blank pane", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  // No pushDelta, no finish on incumbent → still in flight.
  r.pushDelta("fireworks", "<html><body>ok</body></html>");
  r.stop();
  const plain = out._buf.out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /waiting for first token…/);
});

// The shared race banner spans both panes with one clock, so it's unmistakable
// that the two models started together and are timed head-to-head — even while
// one is still warming up and only the other is streaming.
test("tui: shared race header shows RACING while in flight and RACE COMPLETE when both done", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  const running = out._buf.out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(running, /RACING/);
  assert.match(running, /both models running at the same time/);
  r.finish("incumbent", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 2, cost: 0.01 });
  r.finish("fireworks", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 1, cost: 0.001 });
  r.stop();
  const done = out._buf.out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(done, /RACE COMPLETE/);
});

// A side warming up (in flight, no stream text yet) surfaces its live phase —
// so it reads as actively working, not stalled, while the other side streams.
test("tui: waiting side surfaces the live phase status set via setStatus", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  r.setStatus("incumbent", "Running Write…");
  r.render();
  r.stop();
  const plain = out._buf.out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /Running Write…/);
});

// The meter shows two clocks: "total" (wall-clock since the shared t=0) and
// "gen" (active generation — first token to done). The gap is time-to-first-
// token, during which the total ticks but nothing is produced. A side that
// never streamed reports gen 0.
test("tui: meter shows separate total and gen clocks; a no-token side reads gen 0s", () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  r.pushDelta("fireworks", "<html><body>ok</body></html>");
  r.finish("fireworks", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 1.2, cost: 0.001 });
  // incumbent finishes without ever streaming a token → gen must be 0.
  r.finish("incumbent", { ok: false, inputTokens: 0, outputTokens: 0, seconds: 0.4, cost: 0, error: "boom" });
  r.stop();
  const plain = out._buf.out.replace(/\x1b\[[0-9;]*m/g, "");
  // both clocks are labelled and rendered in the meter
  assert.match(plain, /⏱ \d[\d.]*s total/);
  assert.match(plain, /⚡ \d[\d.]*s gen/);
  // a side that never streamed a token reports 0s of generation time
  assert.match(plain, /⚡ 0s gen/);
});

// The core timer fix: a side is frozen the instant ITS OWN run ends (freeze),
// not after both finish — so the faster side stops ticking at its real finish
// time and the header flips to "finished · still running". Without this the
// fast pane kept ticking (nothing happening) until the slow side ended.
test("tui: freeze() stops the finished side's clock while the other keeps running", async () => {
  const out = fakeStdout({ columns: 100, rows: 24 });
  const r = new SplitPaneRenderer({
    incumbent: header("Anthropic", "Claude", "list price", { inputPerMillion: 3, outputPerMillion: 15 }),
    fireworks: header("Fireworks", "GLM 5.2 Fast", "serverless", { inputPerMillion: 2.1, outputPerMillion: 6.6 }),
    stdout: out,
  });
  r.start();
  r.pushDelta("fireworks", "<html><body>ok</body></html>");
  r.freeze("fireworks", true); // fast side finishes first
  assert.equal(r.sides.fireworks.done, true);
  assert.equal(r.sides.incumbent.done, false);
  const fwFrozen = r.sides.fireworks.frozenMs;
  assert.ok(fwFrozen > 0, "fireworks clock captured at its own finish");
  const mid = out._buf.out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(mid, /Fireworks finished · Anthropic still running/);

  await new Promise((res) => setTimeout(res, 20));
  r.freeze("incumbent", true);
  assert.ok(r.sides.incumbent.frozenMs >= fwFrozen, "incumbent froze later than fireworks");
  assert.equal(r.sides.fireworks.frozenMs, fwFrozen, "fireworks clock did not advance while waiting");

  // finish() reconciles tokens/cost but must preserve the freeze() clock.
  r.finish("fireworks", { ok: true, inputTokens: 10, outputTokens: 20, seconds: 1.2, cost: 0.001 });
  assert.equal(r.sides.fireworks.frozenMs, fwFrozen, "finish() preserves the freeze() time");
  r.stop();
});

// ── browser compare.html ─────────────────────────────────────────────────────

function sampleResult() {
  return buildResult({
    incumbent: {
      side: "incumbent", provider: "Anthropic", model: "Claude Sonnet 5", modelId: "claude-sonnet-5",
      callMode: "live", inputTokens: 100, outputTokens: 2000, seconds: 8.0, cost: 0.03,
      rates: { inputPerMillion: 3, outputPerMillion: 15, source: "https://www.anthropic.com/pricing" },
      ok: true, appRunnable: true,
    },
    fireworks: {
      side: "fireworks", provider: "Fireworks", model: "GLM 5.2 Fast", modelId: "glm-5p2-fast",
      callMode: "live", inputTokens: 100, outputTokens: 2000, seconds: 2.0, cost: 0.013,
      rates: { inputPerMillion: 2.1, outputPerMillion: 6.6, source: "https://docs.fireworks.ai/serverless/pricing" },
      ok: true, appRunnable: true,
    },
    prompt: { title: "Tetris", text: "build tetris", source: "preset", presetId: "tetris" },
    mode: "harness-swap",
  });
}

test("browser: compare.html is self-contained and inlines both apps", () => {
  const result = sampleResult();
  const html = buildCompareHtml({
    result,
    incumbentAppHtml: "<!doctype html><html><body>INC</body></html>",
    fireworksAppHtml: "<!doctype html><html><body>FW</body></html>",
    incumbentRunnable: true,
    fireworksRunnable: true,
    incumbentLabel: "Anthropic · Claude Sonnet 5",
    fireworksLabel: "Fireworks · GLM 5.2 Fast",
    copySummary: "Raced Claude vs GLM. Built with `fireconnect demo`.",
  });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Anthropic · Claude Sonnet 5/);
  assert.match(html, /Fireworks · GLM 5.2 Fast/);
  // both apps inlined as srcdoc
  assert.match(html, /srcdoc=/);
  assert.match(html, /INC/);
  assert.match(html, /FW/);
  // copy summary inlined
  assert.match(html, /fireconnect demo/);
  // no external network (no http(s) resource refs in tags)
  assert.doesNotMatch(html, /<script src=/);
  assert.doesNotMatch(html, /<link [^>]*href=/);
  // comparison strip numbers present (8s / 2s = 4×)
  assert.match(html, /4×/);
});

test("browser: non-runnable panel shows the didn't-run note and code by default", () => {
  const result = sampleResult();
  const html = buildCompareHtml({
    result,
    incumbentAppHtml: "I can't help with that.",
    fireworksAppHtml: "<html><body>ok</body></html>",
    incumbentRunnable: false,
    fireworksRunnable: true,
    incumbentLabel: "Anthropic · Claude",
    fireworksLabel: "Fireworks · GLM 5.2 Fast",
    copySummary: "x",
  });
  assert.match(html, /didn’t run/);
  // code panel for incumbent is shown by default
  assert.match(html, /class="code show"/);
});

test("browser: result JSON script block round-trips without entity corruption", () => {
  const result = sampleResult();
  result.promptTitle = "Tetris <b> & \"quotes\""; // hostile chars
  const html = buildCompareHtml({
    result,
    incumbentAppHtml: "<html></html>",
    fireworksAppHtml: "<html></html>",
    incumbentRunnable: true,
    fireworksRunnable: true,
    incumbentLabel: "Anthropic · Claude",
    fireworksLabel: "Fireworks · GLM 5.2 Fast",
    copySummary: "Raced Claude vs GLM. Built with `fireconnect demo`.",
  });
  // extract the result script block content and parse it
  const m = html.match(/<script id="result" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "result script block present");
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.promptTitle, "Tetris <b> & \"quotes\"");
  // no raw </script> breakout
  assert.doesNotMatch(m[1], /<\/script>/);
  // copy summary is a valid JS string literal (single surrounding pair of quotes)
  const copyMatch = html.match(/var text = (".*?");\n/s);
  assert.ok(copyMatch, "copy text assignment present");
  assert.equal(JSON.parse(copyMatch[1]), "Raced Claude vs GLM. Built with `fireconnect demo`.");
});

test("browser: a failed side shows an honest 'run incomplete' strip, not a comparison", () => {
  const result = sampleResult();
  result.fireworks.ok = false; // fireworks side failed
  const html = buildCompareHtml({
    result,
    incumbentAppHtml: "<html><body>ok</body></html>",
    fireworksAppHtml: "",
    incumbentRunnable: true,
    fireworksRunnable: false,
    incumbentLabel: "Anthropic · Claude Sonnet 5",
    fireworksLabel: "Fireworks · GLM 5.2 Fast",
    copySummary: "x",
  });
  assert.match(html, /Run incomplete/);
  assert.doesNotMatch(html, /Speed: <b>/); // no comparison asserted
});

// close() must tear down live keep-alive sockets, not just stop accepting new
// ones — otherwise the browser's held-open connection keeps the Node event loop
// alive and the CLI hangs after the run is done.
test("serveStatic: close() destroys keep-alive sockets so the server actually shuts down", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-serve-"));
  try {
    await writeFile(path.join(dir, "compare.html"), "<!doctype html><html></html>");
    const server = await serveStatic(dir);
    // A keep-alive request leaves the socket open after the response.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
      const req = http.get({ port: server.port, host: "127.0.0.1", path: "/", agent }, (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      });
      req.on("error", reject);
    });
    // close() should complete (emit 'close') despite the open keep-alive socket.
    const closed = await new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => { if (!settled) resolve(false); }, 2000);
      // The underlying server emits 'close' once all sockets are gone; we detect
      // completion by observing that a follow-up connection is refused.
      server.close();
      setTimeout(() => {
        const probe = http.get({ port: server.port, host: "127.0.0.1", path: "/", timeout: 500 }, () => {
          settled = true; clearTimeout(t); resolve(false); // still serving — bad
        });
        probe.on("error", () => { settled = true; clearTimeout(t); resolve(true); }); // refused — good
        probe.on("timeout", () => { probe.destroy(); settled = true; clearTimeout(t); resolve(false); });
      }, 100);
    });
    agent.destroy();
    assert.equal(closed, true, "server refused connections after close()");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── demo clean ────────────────────────────────────────────────────────────────

test("isDemoOutputDir: true only when a demo marker file is present", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-clean-mark-"));
  try {
    assert.equal(await isDemoOutputDir(dir), false); // empty
    await writeFile(path.join(dir, "result.json"), "{}");
    assert.equal(await isDemoOutputDir(dir), true);
    assert.equal(await isDemoOutputDir(path.join(dir, "nope")), false); // missing
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findStaleDemoTmp: matches only the demo's tmp prefixes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fc-clean-tmproot-"));
  try {
    for (const name of ["fc-demo-inc-aaa", "fc-demo-fw-bbb", "fireconnect-demo-ccc", "unrelated-ddd"]) {
      await mkdir(path.join(root, name));
    }
    const found = (await findStaleDemoTmp(root)).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ["fc-demo-fw-bbb", "fc-demo-inc-aaa", "fireconnect-demo-ccc"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDemoClean: removes a demo output dir + stale tmp, leaves a non-demo dir", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "fc-clean-out-"));
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "fc-clean-troot-"));
  await writeFile(path.join(outDir, "compare.html"), "<html></html>");
  await mkdir(path.join(tmpRoot, "fc-demo-inc-xyz"));
  try {
    // yes:true skips the confirm; tmpRoot is injected so we never touch real tmp.
    await runDemoClean({ out: outDir, yes: true }, { tmpRoot });
    assert.equal(await isDemoOutputDir(outDir), false, "output dir removed");
    assert.equal((await findStaleDemoTmp(tmpRoot)).length, 0, "stale tmp swept");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
  }

  // A directory that isn't demo output must be left alone.
  const foreign = await mkdtemp(path.join(os.tmpdir(), "fc-clean-foreign-"));
  await writeFile(path.join(foreign, "important.txt"), "keep me");
  const emptyTmp = await mkdtemp(path.join(os.tmpdir(), "fc-clean-empty-"));
  try {
    await runDemoClean({ out: foreign, yes: true }, { tmpRoot: emptyTmp });
    assert.equal(await pathExistsForTest(path.join(foreign, "important.txt")), true, "foreign dir untouched");
  } finally {
    await rm(foreign, { recursive: true, force: true });
    await rm(emptyTmp, { recursive: true, force: true });
  }
});

async function pathExistsForTest(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── incumbent pricing accessor ────────────────────────────────────────────────

test("providerListPricing: known anthropic + openai models resolve real rates", () => {
  const a = providerListPricing({ provider: "anthropic", modelId: "claude-sonnet-5" });
  assert.equal(a.inputPerMillion, 3);
  assert.equal(a.estimated, false);
  const o = providerListPricing({ provider: "openai", modelId: "gpt-4o" });
  assert.equal(o.inputPerMillion, 2.5);
  assert.equal(o.estimated, false);
});

test("providerListPricing: opus 4.x uses current $5/$25 rate, not legacy $15/$75", () => {
  // Opus 4.5–4.8 are all $5/$25 per anthropic.com/pricing (verified 2026-07-06).
  // The old $15/$75 was Opus 4.1 only; a stale table would inflate incumbent
  // cost 3x and skew the demo's cost-saved fraction.
  for (const id of ["claude-opus-4-8", "claude-opus-4-5", "claude-opus-4", "opus"]) {
    const r = providerListPricing({ provider: "anthropic", modelId: id });
    assert.equal(r.inputPerMillion, 5, `${id} input`);
    assert.equal(r.outputPerMillion, 25, `${id} output`);
    assert.equal(r.estimated, false, `${id} not estimated`);
  }
  // Opus 4.1 keeps the legacy $15/$75 tier.
  const legacy = providerListPricing({ provider: "anthropic", modelId: "claude-opus-4-1" });
  assert.equal(legacy.inputPerMillion, 15);
  assert.equal(legacy.outputPerMillion, 75);
});

test("providerListPricing: gpt-4o-mini does not match the gpt-4o tier", () => {
  // Regression: substring matching by insertion order let `gpt-4o` shadow
  // `gpt-4o-mini`, inflating cost ~17x. The longest-key match must win.
  const m = providerListPricing({ provider: "openai", modelId: "gpt-4o-mini" });
  assert.equal(m.inputPerMillion, 0.15);
  assert.equal(m.outputPerMillion, 0.6);
  assert.equal(m.label, "GPT-4o mini");
});

test("providerListPricing: new OpenAI flagships (GPT-5.5 / 5.4 / 5.4 mini) resolve", () => {
  const top = providerListPricing({ provider: "openai", modelId: "gpt-5.5" });
  assert.equal(top.inputPerMillion, 5);
  assert.equal(top.outputPerMillion, 30);
  const mid = providerListPricing({ provider: "openai", modelId: "gpt-5.4" });
  assert.equal(mid.inputPerMillion, 2.5);
  assert.equal(mid.outputPerMillion, 15);
  const mini = providerListPricing({ provider: "openai", modelId: "gpt-5.4-mini" });
  assert.equal(mini.inputPerMillion, 0.75);
  assert.equal(mini.outputPerMillion, 4.5);
});

test("providerListPricing: anthropic cached input is 10% of input", () => {
  const r = providerListPricing({ provider: "anthropic", modelId: "claude-sonnet-5" });
  assert.ok(Math.abs(r.cachedInputPerMillion - 0.3) < 1e-9, `cached ~0.3, got ${r.cachedInputPerMillion}`);
});

test("providerListPricing: unknown provider → not-per-token subscription shape", () => {
  const p = providerListPricing({ provider: "cursor", modelId: "cursor-hosted" });
  assert.equal(p.inputPerMillion, 0);
  assert.equal(p.tier, "subscription");
});

// ── cwd-file fallback for agentic runs ────────────────────────────────────────

test("readBestHtmlFromDir: recovers the largest .html file a tool wrote", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-best-html-"));
  try {
    await writeAppHtml(dir, ""); // app.html placeholder (empty)
    const sub = path.join(dir, "src");
    await (await import("node:fs/promises")).mkdir(sub, { recursive: true });
    const big = "<!doctype html><html><body>" + "x".repeat(500) + "</body></html>";
    await (await import("node:fs/promises")).writeFile(path.join(sub, "game.html"), big, "utf8");
    const found = await readBestHtmlFromDir(dir);
    assert.equal(found, big);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readBestHtmlFromDir: missing dir yields empty string (never throws)", async () => {
  assert.equal(await readBestHtmlFromDir("/nonexistent/path/xyz"), "");
  assert.equal(await readBestHtmlFromDir(""), "");
});

// ── pre-flight auth classification ───────────────────────────────────────────
// A 401/403 (bad key) must be treated as prompt-able — the demo should ask for
// a fresh key, not tell the user to "pick another model". A non-auth failure
// (model not enabled) is not fixable by re-entering a key and stays a throw.

test("isAuthFailure: 401 httpStatus is an auth failure (prompt, don't bail)", () => {
  assert.equal(isAuthFailure({ ok: false, httpStatus: 401, error: "Fireworks request failed (401 )" }), true);
});

test("isAuthFailure: 403 httpStatus is an auth failure", () => {
  assert.equal(isAuthFailure({ ok: false, httpStatus: 403, error: "forbidden" }), true);
});

test("isAuthFailure: 404 / non-auth status is NOT an auth failure (pick another model)", () => {
  assert.equal(isAuthFailure({ ok: false, httpStatus: 404, error: "model not found" }), false);
  assert.equal(isAuthFailure({ ok: false, httpStatus: 400, error: "bad request" }), false);
});

test("isAuthFailure: the real reported 401 body classifies as auth (regression)", () => {
  // Verbatim from a user run: a stale key resolved from env/config was rejected
  // with this body. Pre-fix the demo threw "pick another model"; it should prompt.
  const body = 'Fireworks request failed (401 ): {"error":{"message":"The API key you provided is invalid.","param":null,"code":"UNAUTHORIZED","type":"error"}}';
  assert.equal(isAuthFailure({ ok: false, httpStatus: 401, error: body }), true);
});

test("isAuthFailure: text backstop catches a thrown error with no status", () => {
  assert.equal(isAuthFailure({ ok: false, httpStatus: 0, error: "UNAUTHORIZED: invalid api key" }), true);
  assert.equal(isAuthFailure({ ok: false, httpStatus: 0, error: "model not deployed on account" }), false);
});

// ── incumbent detection ──────────────────────────────────────────────────────

import { writeFile, mkdir } from "node:fs/promises";
import { USER_SETTINGS_RELATIVE_PATH } from "../lib/fireconnect-core.mjs";
import { setHarnessEnabled, writeGlobalConfig } from "../lib/global-config.mjs";

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-demo-inc-"));
  return home;
}

test("detectIncumbent: claude with Anthropic key → live Anthropic", async () => {
  const home = await tempHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, USER_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-test-key-123" } }),
  );
  const inc = await detectIncumbent({ home });
  assert.equal(inc.harness, "claude");
  assert.equal(inc.kind, "anthropic");
  assert.equal(inc.callMode, "live");
  assert.equal(inc.detected, true);
  // No ANTHROPIC_MODEL pinned in settings env → the race defaults to Opus (not
  // Claude Code's built-in Sonnet default), and pins it via --model.
  assert.equal(inc.modelId, "claude-opus");
  assert.equal(inc.cliModel, "opus");
  assert.match(inc.modelLabel, /opus/i);
  await rm(home, { recursive: true, force: true });
});

test("detectIncumbent: explicit ANTHROPIC_MODEL is honored over the Opus default", async () => {
  const home = await tempHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, USER_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-test-key-123", ANTHROPIC_MODEL: "claude-haiku-4-5" } }),
  );
  const inc = await detectIncumbent({ home });
  assert.equal(inc.modelId, "claude-haiku-4-5");
  assert.equal(inc.cliModel, "claude-haiku-4-5");
  await rm(home, { recursive: true, force: true });
});

test("detectIncumbent: honors the /model picker choice (top-level `model` in settings.json)", async () => {
  const home = await tempHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  // The interactive `/model` picker persists as the top-level `model` field.
  await writeFile(
    path.join(home, USER_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ model: "opus", env: { ANTHROPIC_API_KEY: "sk-ant-test-key-123" } }),
  );
  const inc = await detectIncumbent({ home });
  assert.equal(inc.cliModel, "opus");
  assert.equal(inc.modelId, "opus");
  assert.match(inc.modelLabel, /opus/i);
  // Pricing for the alias resolves to Opus list rate, not the Sonnet fallback.
  const price = incumbentPricing(inc);
  assert.equal(price.inputPerMillion, 5);
  assert.equal(price.outputPerMillion, 25);
  assert.equal(price.estimated, false);
  await rm(home, { recursive: true, force: true });
});

test("detectIncumbent: the `[1m]` context tag is stripped from the picked model", async () => {
  const home = await tempHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, USER_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ model: "claude-opus-4-8[1m]", env: { ANTHROPIC_API_KEY: "sk-ant-test-key-123" } }),
  );
  const inc = await detectIncumbent({ home });
  assert.equal(inc.cliModel, "claude-opus-4-8");
  assert.equal(inc.modelId, "claude-opus-4-8");
  await rm(home, { recursive: true, force: true });
});

test("detectIncumbent: project .claude/settings.json model overrides the user file", async () => {
  const home = await tempHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, USER_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ model: "sonnet", env: { ANTHROPIC_API_KEY: "sk-ant-test-key-123" } }),
  );
  const cwd = await tempHome();
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));
  const inc = await detectIncumbent({ home, cwd });
  assert.equal(inc.cliModel, "opus");
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("detectIncumbent: claude routed to Fireworks is skipped (not an incumbent)", async () => {
  const home = await tempHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, USER_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference", ANTHROPIC_API_KEY: "fw_test_key" } }),
  );
  const inc = await detectIncumbent({ home });
  // No other harness configured → falls back to the labeled default (estimated).
  assert.equal(inc.detected, false);
  assert.equal(inc.callMode, "estimated");
  await rm(home, { recursive: true, force: true });
});

test("detectIncumbent: fireconnect-on harness is skipped", async () => {
  const home = await tempHome();
  await setHarnessEnabled(home, "claude", true, { mode: "direct" });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, USER_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: "fw_test_key", ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference" } }),
  );
  const inc = await detectIncumbent({ home });
  assert.equal(inc.detected, false);
  await rm(home, { recursive: true, force: true });
});

test("detectIncumbent: empty HOME → labeled default estimate", async () => {
  const home = await tempHome();
  const inc = await detectIncumbent({ home });
  assert.equal(inc.detected, false);
  assert.equal(inc.callMode, "estimated");
  assert.equal(inc.providerLabel, "Anthropic");
  await rm(home, { recursive: true, force: true });
});

test("detectIncumbent: VS Code with only Fireworks providers → not invented as OpenAI incumbent", async () => {
  const home = await tempHome();
  const vscodePath = path.join(home, "Library", "Application Support", "Code", "User");
  await mkdir(vscodePath, { recursive: true });
  await writeFile(
    path.join(vscodePath, "chatLanguageModels.json"),
    JSON.stringify([
      { name: "Fireworks", id: "fireworks/glm-5p2-fast", models: [{ id: "glm-5p2-fast" }] },
      { name: "Fireworks", id: "fireworks/glm-5p2", models: [{ id: "glm-5p2" }] },
    ]),
  );
  const inc = await detectIncumbent({ home });
  // No non-Fireworks provider → VS Code is NOT invented as a default OpenAI
  // incumbent; detection falls through to the labeled default estimate.
  assert.equal(inc.harness, "claude");
  assert.equal(inc.detected, false);
  await rm(home, { recursive: true, force: true });
});

// ── detectActiveFireworksHarness ────────────────────────────────────────────

test("detectActiveFireworksHarness: returns the enabled harness id when fireconnect is on", async () => {
  const home = await tempHome();
  await setHarnessEnabled(home, "claude", true, { mode: "direct" });
  const h = await detectActiveFireworksHarness({ home });
  assert.equal(h, "claude");
  await rm(home, { recursive: true, force: true });
});

test("detectActiveFireworksHarness: returns null when no harness is enabled", async () => {
  const home = await tempHome();
  const h = await detectActiveFireworksHarness({ home });
  assert.equal(h, null);
  await rm(home, { recursive: true, force: true });
});

test("detectActiveFireworksHarness: empty home returns null", async () => {
  const h = await detectActiveFireworksHarness({ home: "" });
  assert.equal(h, null);
});

test("incumbentPricing: Anthropic sonnet list rate with source", () => {
  const inc = { kind: "anthropic", modelId: "claude-sonnet-5" };
  const p = incumbentPricing(inc);
  assert.equal(p.inputPerMillion, 3);
  assert.equal(p.outputPerMillion, 15);
  assert.equal(p.estimated, false);
  assert.equal(p.source, "https://www.anthropic.com/pricing");
});

test("incumbentPricing: unknown anthropic model → fallback estimated rate", () => {
  const p = incumbentPricing({ kind: "anthropic", modelId: "claude-future-99" });
  assert.equal(p.estimated, true);
  assert.ok(p.inputPerMillion > 0);
});

test("incumbentPricing: cursor → subscription, not per-token", () => {
  const p = incumbentPricing({ kind: "cursor", modelId: "cursor-hosted" });
  assert.equal(p.inputPerMillion, 0);
  assert.equal(p.tier, "subscription");
});

// ── output directory ─────────────────────────────────────────────────────────

test("output: prepareOutputDir writes prompt.txt and creates subdirs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-demo-out-"));
  const { incumbentDir, fireworksDir } = await prepareOutputDir(dir, {
    prompt: { title: "Tetris", text: "build tetris", source: "preset" },
    seed: 1, mode: "replay", challengerModel: "glm-5p2-fast",
  });
  const promptTxt = await readFile(path.join(dir, "prompt.txt"), "utf8");
  assert.equal(promptTxt, "build tetris");
  await writeAppHtml(incumbentDir, "<html></html>");
  await writeAppHtml(fireworksDir, "<html></html>");
  await writeStreamLog(incumbentDir, [{ t: 0, text: "hi" }]);
  await writeStreamLog(fireworksDir, [{ t: 1, text: "yo" }]);
  const incLog = await readFile(path.join(incumbentDir, "stream.log"), "utf8");
  assert.equal(incLog.trim(), '{"t":0,"text":"hi"}');
  const result = sampleResult();
  await writeResultJson(dir, result, { incumbent: result.incumbent.rates, fireworks: result.fireworks.rates });
  const rj = JSON.parse(await readFile(path.join(dir, "result.json"), "utf8"));
  assert.equal(rj.summary.speedRatio, 4);
  const rates = JSON.parse(await readFile(path.join(dir, "rates.json"), "utf8"));
  assert.equal(rates.fireworks.inputPerMillion, 2.1);
  await writeCompareHtml(dir, "<!doctype html><html></html>");
  const cmp = await readFile(path.join(dir, "compare.html"), "utf8");
  assert.match(cmp, /<!doctype html>/);
  await rm(dir, { recursive: true, force: true });
});
