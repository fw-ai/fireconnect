/**
 * `fireconnect demo` — races two models on the same prompt via Claude Code,
 * streams both live in a split-pane terminal UI, then opens a browser comparison.
 */

import process from "node:process";
import path from "node:path";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import os from "node:os";

import { HARNESS } from "../harness/id.mjs";
import { getHeadlessRunner, SUPPORTED_HARNESS_IDS } from "./harness-runners.mjs";
import { extractHtml, looksRunnable } from "./html-extract.mjs";
import { runCost, buildResult, formatSpeedRatio } from "./measurement.mjs";
import {
  prepareOutputDir, writeStreamLog, writeAppHtml, writeResultJson, writeCompareHtml,
  readBestHtmlFromDir,
} from "./output.mjs";
import { SplitPaneRenderer, isTtyCapable } from "./tui.mjs";
import { confirmYesNo, pressAnyKeyToExit } from "./key-prompt.mjs";
import { buildCompareHtml, serveStatic, openInBrowser } from "./browser.mjs";
import {
  demoModelLabel,
  demoSideDisplayLabel,
} from "./demo-models.mjs";
import { normalizeOptions, prepareDemoRun } from "./demo-prep.mjs";
import { DEMO_CANCELLED_MSG } from "./demo-readiness.mjs";

const DEFAULT_OUT_DIR = "./fireconnect-demo";

// Files the demo writes at the root of its output dir. `demo clean` treats a
// directory as demo output ONLY if it holds one of these, so it can never delete
// an unrelated folder a user happened to point --out at.
const DEMO_OUTPUT_MARKERS = ["result.json", "compare.html", "rates.json", "prompt.txt"];
// Prefixes of the throwaway tmp dirs the demo creates during a run (per-side
// cwds + the route-settings dir). Normal and Ctrl-C exits remove these; a hard
// crash can leave them behind, so `demo clean` sweeps any stragglers.
const DEMO_TMP_PREFIXES = ["fc-demo-inc-", "fc-demo-fw-", "fireconnect-demo-"];

// ── `fireconnect demo clean` ──────────────────────────────────────────────────

/** @param {string} p @returns {Promise<boolean>} */
async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only if `dir` holds a recognizable demo output marker. This is the guard
 * that keeps `demo clean` from ever removing a directory the demo didn't create.
 * @param {string} dir @returns {Promise<boolean>}
 */
export async function isDemoOutputDir(dir) {
  try {
    const entries = new Set(await readdir(dir));
    return DEMO_OUTPUT_MARKERS.some((m) => entries.has(m));
  } catch {
    return false; // missing / not a directory
  }
}

/**
 * Leftover per-run tmp dirs (from a crashed run). `tmpRoot` is injectable so the
 * sweep can be tested without touching the real system tmp.
 * @param {string} [tmpRoot] @returns {Promise<string[]>}
 */
export async function findStaleDemoTmp(tmpRoot = os.tmpdir()) {
  let names;
  try {
    names = await readdir(tmpRoot);
  } catch {
    return [];
  }
  return names
    .filter((n) => DEMO_TMP_PREFIXES.some((p) => n.startsWith(p)))
    .map((n) => path.join(tmpRoot, n));
}

/**
 * Remove the demo's generated output dir (guarded by the marker check) and sweep
 * any crashed-run tmp dirs. Confirms before deleting output unless --yes, since
 * the on-disk compare.html is the shareable artifact of a run.
 *
 * @param {any} ctx  parsed context (ctx.out, ctx.yes)
 * @param {{ tmpRoot?: string }} [opts]  injectable tmp root for tests
 */
export async function runDemoClean(ctx, { tmpRoot = os.tmpdir() } = {}) {
  const outDir = path.resolve(ctx.out || DEFAULT_OUT_DIR);
  const removed = [];

  if (await isDemoOutputDir(outDir)) {
    const canPrompt = isTtyCapable() && !ctx.yes;
    const ok = canPrompt
      ? await confirmYesNo(`Remove demo output at ${outDir}?`, { stdin: process.stdin, stdout: process.stdout })
      : true;
    if (ok) {
      await rm(outDir, { recursive: true, force: true });
      removed.push(outDir);
    } else {
      console.log("  Left the demo output in place.");
    }
  } else if (await pathExists(outDir)) {
    console.log(`  ${DIM(`${outDir} doesn't look like demo output (no result.json/compare.html) — leaving it untouched.`)}`);
  }

  // Sweep crashed-run tmp dirs. Harmless garbage; run when no demo is in flight.
  for (const dir of await findStaleDemoTmp(tmpRoot)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(dir);
  }

  if (removed.length === 0) {
    console.log("  Nothing to clean.");
  } else {
    console.log(`  Cleaned ${removed.length} item${removed.length === 1 ? "" : "s"}:`);
    for (const r of removed) {
      console.log(`    ${DIM(r)}`);
    }
  }
}

/**
 * @param {any} ctx  parsed HarnessContext (kind === "demo")
 */
export async function runDemoCommand(ctx) {
  if (ctx.clean) {
    return runDemoClean(ctx);
  }
  const options = normalizeOptions(ctx);

  const useTui = isTtyCapable() && !options.json;
  const openBrowser = useTui && !options.noOpen;
  const emitJson = options.json || !isTtyCapable();

  const abort = new AbortController();
  let renderer = null;
  let tearingDown = false;
  // Cleanup for tmp route-settings + per-side working dirs (harness-swap only).
  // Fire-and-forget on SIGINT (the OS reaps /tmp); the normal path awaits it.
  const cleanupFns = [];
  const runCleanup = () => Promise.all(cleanupFns.map((fn) => fn().catch(() => {})));
  const teardown = (code) => {
    if (tearingDown) {
      return;
    }
    tearingDown = true;
    abort.abort();
    try { renderer?.stop(); } catch { /* noop */ }
    // Restore the TTY before exiting: a SIGINT from an external `kill -INT`
    // (or a Ctrl-C that slips through a non-raw window) can arrive while a
    // prompt/form left stdin in raw mode or the cursor hidden. The prompts
    // clean up on their own Ctrl-C byte, but this is the defensive backstop so
    // the terminal is never left unusable on exit.
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch { /* noop */ }
    process.stdout.write("\x1b[?25h"); // SHOW_CURSOR
    runCleanup();
    if (code != null) {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => {
    process.stderr.write("\nInterrupted — cleaning up.\n");
    teardown(130);
  });

  const {
    options: runOptions,
    prompt,
    leftLabel,
    rightLabel,
    leftRates,
    rightRates,
  } = await prepareDemoRun({ ctx, options, useTui }).catch((err) => {
    if (err instanceof Error && err.message === DEMO_CANCELLED_MSG) {
      teardown(1);
      return null;
    }
    throw err;
  });
  if (!runOptions) {
    return;
  }

  if (useTui && runOptions.yes) {
    printFraming(leftLabel, rightLabel);
  }

  // ── prepare output dir ────────────────────────────────────────────────────
  const outDir = path.resolve(runOptions.out);
  const mode = "harness-swap";
  const dirs = await prepareOutputDir(outDir, {
    prompt: { title: prompt.title, text: prompt.prompt, source: prompt.source, presetId: prompt.presetId },
    mode,
    challengerModel: runOptions.rightModel,
  });

  /** @type {any} */
  const incRunProto = makeSideProto("incumbent", runOptions.leftModel, leftRates);
  /** @type {any} */
  const fwRunProto = makeSideProto("fireworks", runOptions.rightModel, rightRates);

  let incumbentAppHtml = "";
  let fireworksAppHtml = "";

  let leftRunner;
  let rightRunner;
  let incCwd = null;
  let fwCwd = null;
  const runner = getHeadlessRunner(HARNESS.CLAUDE);
  if (!runner) {
    throw new Error(
      `Demo doesn't have a headless runner for Claude Code yet. `
      + `Supported: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
    );
  }
  const {
    leftCliModel,
    rightCliModel,
    cleanup: cleanupRoute,
  } = await runner.buildRaceSettings({
    leftModel: runOptions.leftModel,
    rightModel: runOptions.rightModel,
    home: ctx.home,
    settingsPath: ctx.settingsPath,
  });
  cleanupFns.push(cleanupRoute);
  incCwd = await mkdtemp(path.join(os.tmpdir(), "fc-demo-inc-"));
  fwCwd = await mkdtemp(path.join(os.tmpdir(), "fc-demo-fw-"));
  cleanupFns.push(async () => rm(incCwd, { recursive: true, force: true }).catch(() => {}));
  cleanupFns.push(async () => rm(fwCwd, { recursive: true, force: true }).catch(() => {}));
  leftRunner = (io) => runner.runSide({
    cwd: incCwd, prompt: prompt.prompt, model: leftCliModel, ...io,
  });
  rightRunner = (io) => runner.runSide({
    cwd: fwCwd, prompt: prompt.prompt, model: rightCliModel, ...io,
  });

  let incResult = null;
  let fwResult = null;
  if (useTui) {
    renderer = new SplitPaneRenderer({
      incumbent: sideHeader(incRunProto, leftRates, "measured"),
      fireworks: sideHeader(fwRunProto, rightRates, "measured"),
      mode: "race",
    });
    renderer.start();
    const onErr = (side) => (r) => renderer.finish(side, {
      ok: false,
      error: r.error,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      seconds: r.seconds ?? 0,
      cost: 0,
    });
    // Freeze each side's clock the instant ITS OWN runner resolves — not after
    // both finish — so the faster side stops ticking at its real finish time and
    // the header flips to "X finished · Y still running". finalizeBoth (which
    // reconciles tokens/cost) runs only once both are done, so the reconciled
    // numbers land via finish() afterward while the frozen clock is preserved.
    const raceSide = (runner, side) => runner({
      signal: abort.signal,
      onDelta: (t) => renderer.pushDelta(side, t),
      onThinking: (t) => renderer.pushThinking(side, t),
      onTokens: (tok) => renderer.setTokens(side, tok),
      onError: onErr(side),
      onStatus: (t) => renderer.setStatus(side, t),
    }).then((r) => { renderer.freeze(side, r.ok); return r; });
    // try/finally so a thrown error (a runner rejects, finalizeBoth throws) can't
    // leave the 10Hz render interval running and pin the event loop on exit.
    try {
      [incResult, fwResult] = await Promise.all([
        raceSide(leftRunner, "incumbent"),
        raceSide(rightRunner, "fireworks"),
      ]);
      await finalizeBoth({
        incResult, fwResult, incRates: leftRates, fwRates: rightRates,
        setIncHtml: (h) => { incumbentAppHtml = h; }, setFwHtml: (h) => { fireworksAppHtml = h; },
        incRunProto, fwRunProto, incCwd, fwCwd,
      });
      renderer.finish("incumbent", sideFinal(incRunProto));
      renderer.finish("fireworks", sideFinal(fwRunProto));
    } finally {
      renderer.stop();
    }
  } else {
    // Non-TTY / --json: run both without the live renderer.
    [incResult, fwResult] = await Promise.all([
      leftRunner({ signal: abort.signal }),
      rightRunner({ signal: abort.signal }),
    ]);
    await finalizeBoth({ incResult, fwResult, incRates: leftRates, fwRates: rightRates,
      setIncHtml: (h) => { incumbentAppHtml = h; }, setFwHtml: (h) => { fireworksAppHtml = h; },
      incRunProto, fwRunProto, incCwd, fwCwd });
  }

  await runCleanup();

  // FC_DEBUG: print the full (unsliced) error body of any side that failed at
  // the request layer, so the provider's actual `message` field is visible.
  // The TUI truncates to 200 chars, which usually cuts off the cause. Emitted
  // after the renderer has stopped so it doesn't corrupt the live display.
  if (process.env.FC_DEBUG) {
    if (incResult?.errorBody) process.stderr.write(`\n[FC_DEBUG] incumbent error body:\n${incResult.errorBody}\n\n`);
    if (fwResult?.errorBody) process.stderr.write(`\n[FC_DEBUG] fireworks error body:\n${fwResult.errorBody}\n\n`);
  }

  // ── write outputs (audit) ─────────────────────────────────────────────────
  const result = buildResult({
    incumbent: incRunProto,
    fireworks: fwRunProto,
    prompt: { title: prompt.title, text: prompt.prompt, source: prompt.source, presetId: prompt.presetId },
    mode,
  });
  result.createdAt = new Date().toISOString();
  await writeResultJson(outDir, result, {
    incumbent: result.incumbent.rates,
    fireworks: result.fireworks.rates,
  });
  await writeAppHtml(dirs.incumbentDir, incumbentAppHtml);
  await writeAppHtml(dirs.fireworksDir, fireworksAppHtml);
  // Token logs come straight off each side's result object — no module-level
  // stash, so a second run in the same process can't cross-contaminate logs.
  await writeStreamLog(dirs.incumbentDir, incResult?.tokenLog ?? []);
  await writeStreamLog(dirs.fireworksDir, fwResult?.tokenLog ?? []);

  // ── State 4: verdict ──────────────────────────────────────────────────────
  if (useTui) {
    printVerdict(result, leftLabel, rightLabel);
  }

  // ── State 5: browser handoff ──────────────────────────────────────────────
  // Build the on-disk comparison page for any TTY run (it's referenced by both
  // the browser-open and --no-open paths, so the printed path always exists).
  let server = null;
  if (useTui) {
    const compareHtml = buildCompareHtml({
      result,
      incumbentAppHtml,
      fireworksAppHtml,
      incumbentRunnable: incRunProto.appRunnable,
      fireworksRunnable: fwRunProto.appRunnable,
      incumbentLabel: leftLabel,
      fireworksLabel: rightLabel,
      copySummary: buildCopySummary(result, leftLabel, rightLabel),
    });
    await writeCompareHtml(outDir, compareHtml);
  }
  if (openBrowser) {
    let handoffUrl = "";
    try {
      server = await serveStatic(outDir);
      handoffUrl = server.url;
    } catch {
      handoffUrl = "";
    }
    if (handoffUrl) {
      const opened = openInBrowser(handoffUrl);
      console.log(`\n  ${opened ? "Opening comparison in your browser…" : "Couldn't open a browser. View it at:"} ${DIM(handoffUrl)}`);
    } else {
      const fileUrl = `file://${path.join(outDir, "compare.html")}`;
      openInBrowser(fileUrl);
      console.log(`\n  Comparison page: ${fileUrl}`);
    }
    console.log(`  On-disk copy:    ${path.join(outDir, "compare.html")}`);
  } else if (useTui) {
    // TTY but --no-open: skip the browser, just point at the on-disk page.
    console.log(`\n  Comparison page: ${path.join(outDir, "compare.html")}`);
  }

  // ── State 6: return + convert ─────────────────────────────────────────────
  if (useTui) {
    printConvert(outDir, HARNESS.CLAUDE, rightLabel);
  }

  // ── json output ───────────────────────────────────────────────────────────
  if (emitJson) {
    console.log(JSON.stringify(result, null, 2));
  }

  // The static server has to outlive `open <url>` long enough for the browser to
  // fetch compare.html — but the old fixed 60s timer pinned the event loop open,
  // so the CLI appeared to hang for a full minute after printing every result.
  // Hold under the user's control instead: wait for a keypress, then close and
  // return so the process exits at once. The timeout is the unattended-run
  // backstop — it resolves the wait (not just the server) so the process always
  // exits, at worst 5 minutes later.
  if (server) {
    await pressAnyKeyToExit({
      stdin: process.stdin,
      stdout: process.stdout,
      timeoutMs: 5 * 60_000,
      minHoldMs: 2_000,
      message: `Press any key to exit — if the local URL expires, open ${path.join(outDir, "compare.html")}.`,
    });
    try { server.close(); } catch { /* noop */ }
  }
}

function makeSideProto(side, modelId, rates) {
  const label = demoModelLabel(modelId);
  const [provider] = demoSideDisplayLabel(modelId).split(" · ");
  return {
    side,
    provider,
    model: label,
    modelId,
    callMode: "live",
    inputTokens: 0,
    outputTokens: 0,
    seconds: 0,
    cost: 0,
    rates: rateShape(rates, provider),
    ok: false,
    appRunnable: false,
  };
}

async function finalizeBoth({ incResult, fwResult, incRates, fwRates, setIncHtml, setFwHtml, incRunProto, fwRunProto, incCwd, fwCwd }) {
  await finalizeSide("fireworks", fwRunProto, fwResult, fwRates, setFwHtml, { cwd: fwCwd });
  await finalizeSide("incumbent", incRunProto, incResult, incRates, setIncHtml, { cwd: incCwd });
}

async function finalizeSide(side, proto, result, rates, setHtml, { cwd = null } = {}) {
  if (!result?.ok) {
    proto.ok = false;
    proto.error = result?.error || "generation failed";
    proto.seconds = result?.seconds ?? 0;
    proto.inputTokens = result?.inputTokens ?? 0;
    proto.outputTokens = result?.outputTokens ?? 0;
    proto.cost = 0;
    proto.appRunnable = false;
    setHtml(result?.text ? extractHtml(result.text).html : "");
    return;
  }

  let { html } = extractHtml(result.text);
  let runnable = looksRunnable(html);
  // Harness-swap agentic runs may write the app to a file and return a prose
  // summary instead of inlining the HTML. Fall back to the best .html file the
  // tool wrote in its working dir so the app still renders.
  if (!runnable && cwd) {
    const fromDisk = await readBestHtmlFromDir(cwd);
    if (fromDisk && looksRunnable(fromDisk)) {
      html = fromDisk;
      runnable = true;
    }
  }
  proto.ok = true;
  proto.inputTokens = result.inputTokens ?? 0;
  proto.outputTokens = result.outputTokens ?? 0;
  proto.seconds = result.seconds;
  proto.cost = runCost({
    inputTokens: proto.inputTokens,
    outputTokens: proto.outputTokens,
    inputPerMillion: rates.inputPerMillion,
    outputPerMillion: rates.outputPerMillion,
  });
  proto.appRunnable = runnable;
  setHtml(html);
}

function sideFinal(proto) {
  return {
    ok: proto.ok,
    inputTokens: proto.inputTokens,
    outputTokens: proto.outputTokens,
    seconds: proto.seconds,
    cost: proto.cost,
    error: proto.error,
  };
}

// ── pricing helpers ─────────────────────────────────────────────────────────

function rateShape(rates, providerLabel) {
  return {
    inputPerMillion: rates.inputPerMillion,
    outputPerMillion: rates.outputPerMillion,
    cachedInputPerMillion: rates.cachedInputPerMillion ?? 0,
    tier: rates.tier,
    source: rates.source,
    label: rates.label ?? providerLabel,
    estimated: rates.estimated ?? false,
  };
}

function sideHeader(proto, rates, costLabel) {
  return {
    provider: proto.provider,
    model: proto.model,
    costLabel,
    rates: { inputPerMillion: rates.inputPerMillion, outputPerMillion: rates.outputPerMillion },
  };
}

// ── UI: states 1, 2, 4, 6 ───────────────────────────────────────────────────

function printFraming(leftLabel, rightLabel) {
  console.log("");
  console.log("  FireConnect Demo");
  console.log("  Same prompt, two models. Let's build something and race.");
  console.log("");
  console.log(`  Left:   ${leftLabel}`);
  console.log(`  Right:  ${rightLabel}`);
  console.log("");
}

function printVerdict(result, leftLabel, rightLabel) {
  console.log("");
  console.log("  " + "─".repeat(58));
  const speedPart = verdictSpeed(result, leftLabel, rightLabel);
  const costPart = verdictCost(result, leftLabel, rightLabel);
  console.log(`  ${speedPart} · ${costPart}`);
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (bothOk && result.incumbent.appRunnable && result.fireworks.appRunnable) {
    console.log("  Both built a working app. See for yourself →");
  } else if (!bothOk) {
    const failed = !result.incumbent.ok ? leftLabel : rightLabel;
    console.log(`  The run was incomplete (${failed} failed). No winner declared on a partial result.`);
  } else {
    console.log("  One build didn't run. See for yourself →");
  }
  console.log("  " + "─".repeat(58));
}

function verdictSpeed(result, leftLabel, rightLabel) {
  const ratio = result.summary.speedRatio;
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk || !ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return "speed not comparable";
  }
  if (ratio > 1) {
    return `${rightLabel} finished ${formatSpeedRatio(ratio)} faster`;
  }
  if (ratio < 1) {
    return `${leftLabel} was ${(1 / ratio).toFixed(1)}× faster`;
  }
  return "a dead heat on speed";
}

function verdictCost(result, leftLabel, rightLabel) {
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk) {
    return "cost not comparable";
  }
  const cf = result.summary.costSavedFraction;
  if (!Number.isFinite(cf)) {
    return "cost not comparable";
  }
  // Rebase to the more-expensive model's cost when the incumbent is cheaper so
  // the percentage matches the compare.html strip (same race, one number) —
  // costSavedFraction is incumbent-relative, so |(inc-fw)/inc| would inflate
  // the savings (2× cost → 100% instead of 50%).
  let frac = cf;
  let cheaperLabel = rightLabel;
  if (cf < 0) {
    frac = result.fireworks.cost > 0
      ? (result.fireworks.cost - result.incumbent.cost) / result.fireworks.cost
      : Number.NaN;
    cheaperLabel = leftLabel;
  }
  const pct = Math.round(frac * 100);
  if (pct > 0) {
    return `${cheaperLabel} was ${pct}% cheaper`;
  }
  if (pct < 0) {
    return `${cheaperLabel} was ${Math.abs(pct)}% more expensive`;
  }
  return "same cost";
}

function printConvert(outDir, harnessId, rightLabel) {
  console.log("");
  console.log(`  ✓ Demo complete. Outputs saved to ${outDir}`);
  console.log("");
  console.log(`  Liked ${rightLabel}? Point your tools at it:`);
  console.log(`    fireconnect ${harnessId} on`);
  console.log("");
  console.log(`  Reversible anytime with  fireconnect ${harnessId} off.`);
  console.log("");
}

function buildCopySummary(result, leftLabel, rightLabel) {
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk) {
    return `Raced ${leftLabel} vs ${rightLabel} on the ${result.promptTitle} prompt — one side didn't finish, so no comparison. Built with \`fireconnect claude demo\`.`;
  }
  const speedPart = verdictSpeedText(result, leftLabel, rightLabel);
  const cf = result.summary.costSavedFraction;
  // Rebase to match the compare.html strip and terminal verdict (same race,
  // one percentage) — incumbent-relative |costSavedFraction| inflates savings.
  let frac = cf;
  let cheaperLabel = rightLabel;
  if (Number.isFinite(cf) && cf < 0) {
    frac = result.fireworks.cost > 0
      ? (result.fireworks.cost - result.incumbent.cost) / result.fireworks.cost
      : Number.NaN;
    cheaperLabel = leftLabel;
  }
  const pct = Number.isFinite(frac) ? Math.round(frac * 100) : 0;
  const costPart = pct > 0 ? `${cheaperLabel} ${pct}% cheaper` : pct < 0 ? `${cheaperLabel} ${Math.abs(pct)}% more expensive` : "same cost";
  const bothRunnable = result.incumbent.appRunnable && result.fireworks.appRunnable;
  const appPart = bothRunnable ? ", working app" : ", one build didn't run";
  return (
    `Raced ${leftLabel} vs ${rightLabel} on the same ${result.promptTitle} prompt. `
    + `${speedPart}, ${costPart}${appPart}. Built with \`fireconnect claude demo\`.`
  );
}

function verdictSpeedText(result, leftLabel, rightLabel) {
  const ratio = result.summary.speedRatio;
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return "speed not comparable";
  }
  if (ratio > 1) {
    return `${rightLabel} ${formatSpeedRatio(ratio)} faster`;
  }
  if (ratio < 1) {
    return `${leftLabel} ${formatSpeedRatio(1 / ratio)} faster`;
  }
  return "a dead heat on speed";
}

// ── terminal IO helpers ──────────────────────────────────────────────────────

// Bright-black unless COLORFGBG positively reports a dark bg (0|8). ANSI faint
// (\x1b[2m) is near-invisible on light backgrounds, and most terminals don't
// set COLORFGBG, so default to the readable bright-black gray. See
// lib/demo/ansi.mjs for the full rationale.
const _DIM_CODE = (() => {
  const fgbg = process.env.COLORFGBG ?? "";
  const parts = fgbg.split(";");
  const bg = parts.length === 2 ? Number(parts[1]) : NaN;
  return bg === 0 || bg === 8 ? "\x1b[2m" : "\x1b[90m";
})();

function DIM(s) {
  return `${_DIM_CODE}${s}\x1b[0m`;
}
