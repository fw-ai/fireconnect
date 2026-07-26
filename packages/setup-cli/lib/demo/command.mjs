/**
 * `fireconnect demo` — races the developer's current AI provider against
 * Fireworks GLM 5.2 Fast on the same code-generation prompt, streams both live
 * in a split-pane terminal UI, then hands off to a browser page where both
 * generated apps run side by side.
 *
 * Read-only against the user's environment except for its own output dir.
 * Every number shown is measured from a real `claude -p` run — never simulated,
 * never estimated from list price. If there's no live comparison model to race
 * (no Claude Code auth, no pasted Anthropic key), the command says so and exits
 * rather than fabricating one.
 */

import process from "node:process";
import path from "node:path";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import os from "node:os";

import { prettyModelName } from "../fireworks/models.mjs";
import { resolveFireworksApiKey } from "../keys/harness-api-key.mjs";
import { HARNESS } from "../harness/id.mjs";
import { lookupFireworksPricing, FIREWORKS_PRICING_DOCS_URL } from "../fireworks/pricing.mjs";
import { CUSTOM_DEMO_PROMPT_ID, resolvePrompt } from "./presets.mjs";
import { detectIncumbent, detectActiveFireworksHarness, incumbentPricing, resolveAnthropicKey, prettyClaudeLabel } from "./incumbent-detect.mjs";
import { stripClaudeCodeContextSuffix } from "../harnesses/claude/code-context.mjs";
import { userSettingsPath } from "../harnesses/claude/core.mjs";
import {
  FIREWORKS_BASE_URL,
  normalizeModelId,
} from "../fireworks/model-id.mjs";
import { readJsonIfExists } from "../io/json.mjs";
import { detectApiKeyType } from "../keys/key-type.mjs";
import { getHeadlessRunner, SUPPORTED_HARNESS_IDS } from "./harness-runners.mjs";
import { extractHtml, looksRunnable } from "./html-extract.mjs";
import {
  runCost, buildResult, formatSpeedRatio,
} from "./measurement.mjs";
import {
  prepareOutputDir, writeStreamLog, writeAppHtml, writeResultJson, writeCompareHtml,
  readBestHtmlFromDir,
} from "./output.mjs";
import { SplitPaneRenderer, isTtyCapable } from "./tui.mjs";
import { runSetupForm } from "./setup-form.mjs";
import {
  promptAnthropicKey, promptFireworksKey, confirmYesNo, pressAnyKeyToExit,
} from "./key-prompt.mjs";
import { persistGlobalAnthropicApiKey } from "../config/global-config.mjs";
import { persistApiKeyFromFlag } from "../keys/api-key.mjs";
import { buildCompareHtml, serveStatic, openInBrowser } from "./browser.mjs";

const DEFAULT_CHALLENGER = "glm-5p2-fast";
const DEFAULT_OUT_DIR = "./fireconnect-demo";

// Files the demo writes at the root of its output dir. `demo clean` treats a
// directory as demo output ONLY if it holds one of these, so it can never delete
// an unrelated folder a user happened to point --out at.
const DEMO_OUTPUT_MARKERS = ["result.json", "compare.html", "rates.json", "prompt.txt"];
// Prefixes of the throwaway tmp dirs the demo creates during a run (per-side
// cwds + the route-settings dir). Normal and Ctrl-C exits remove these; a hard
// crash can leave them behind, so `demo clean` sweeps any stragglers.
const DEMO_TMP_PREFIXES = ["fc-demo-inc-", "fc-demo-fw-", "fireconnect-demo-"];

/** Display label for the resolved Fireworks challenger model. */
function challengerLabelFor(model) {
  const p = lookupFireworksPricing(model);
  return p?.label || prettyModelName(model) || model;
}

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

  // `let` because harness-swap overrides this with a Claude incumbent below
  // (harness-swap always races Claude vs Fireworks, regardless of which harness
  // detection labeled as the user's current tool).
  let incumbent = await detectIncumbent({ home: ctx.home, settingsPath: ctx.settingsPath, cwd: ctx.cwd || process.cwd() });
  // The user's primary tool, if it's already routed through Fireworks via
  // `fireconnect` — kept for the framing line on the non-interactive path.
  const fireworksHarness = await detectActiveFireworksHarness({ home: ctx.home });

  const useTui = isTtyCapable() && !options.json;
  const openBrowser = useTui && !options.noOpen;
  // Non-TTY (piped/CI) behaves as --json: skip the TUI and browser, emit JSON.
  const emitJson = options.json || !isTtyCapable();

  // Resolve the challenger (Fireworks) key — needed in BOTH modes. If none is
  // found, an interactive TTY run offers to take one for this run only. A key
  // that resolves but is rejected as invalid (401/403) is handled by the
  // pre-flight below, which re-prompts.
  let fwKey = await resolveFireworksApiKey({ apiKey: ctx.apiKey, home: ctx.home });
  let promptedFwKey = false;
  if (!fwKey && useTui && !options.yes) {
    const r = await promptFireworksKey({ stdin: process.stdin, stdout: process.stdout });
    if (r.key) {
      fwKey = r.key;
      promptedFwKey = true;
    }
  }
  if (!fwKey) {
    throw new Error(
      "No Fireworks API key found — the challenger can't run. "
      + "Run `fireconnect configure`, export FIREWORKS_API_KEY, or pass --api-key.",
    );
  }

  // harness-swap drives the real `claude -p` tool, so it's available whenever
  // Claude Code is configured on this machine — independent of which harness
  // detection labeled as the incumbent (you may be on Codex/Cursor, or Claude
  // may currently be routed through Fireworks; harness-swap still races Claude
  // vs Fireworks via isolated per-side config dirs + an Anthropic API key).

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

  // ── State 1+2: setup form ──────────────────────────────────────────────────
  // The demo has a single mode: harness-swap (Claude Code on Anthropic direct
  // vs Fireworks). The form renders its own header on a clean canvas so we print
  // no framing beforehand.
  let promptedKey = "";    // pasted Anthropic key (offered to persist afterward)

  let prompt = options.prompt === CUSTOM_DEMO_PROMPT_ID && useTui && !options.yes && !options.promptFile
    ? {
      title: "Custom prompt",
      prompt: "",
      rawPrompt: "",
      source: "literal",
      presetId: CUSTOM_DEMO_PROMPT_ID,
    }
    : await resolvePrompt({ prompt: options.prompt, promptFile: options.promptFile });
  if (useTui && !options.yes) {
    const chosen = await runSetupForm({
      defaults: {
        promptSource: prompt.source,
        promptPresetId: prompt.presetId,
        promptText: prompt.rawPrompt ?? prompt.prompt,
        promptTitle: prompt.title,
        challenger: options.challenger,
        out: options.out,
        incumbentModel: ctx.anthropicModel || ctx.main || "opus",
      },
      // The "Comparison model" row shows what the race ACTUALLY runs on the left
      // — always Claude (selected Anthropic model), per the override below — not
      // the detected incumbent (which may be Cursor/Codex/etc.).
      incumbent: {
        providerLabel: "Anthropic",
        modelLabel: prettyClaudeLabel(stripClaudeCodeContextSuffix(ctx.anthropicModel || ctx.main || "opus")),
        callMode: "live",
      },
    });
    options.challenger = chosen.challenger;
    options.out = chosen.out;
    // A user-typed custom task goes through the dedicated `custom` channel so a
    // task whose text is exactly "custom" is treated as a literal, not the
    // empty-custom sentinel (which would throw).
    prompt = chosen.promptSource === "literal"
      ? await resolvePrompt({ custom: chosen.prompt })
      : await resolvePrompt({ prompt: chosen.prompt });
    // The form's "Your model" choice (Anthropic alias) wins for the incumbent.
    if (chosen.incumbentModel) {
      ctx.anthropicModel = chosen.incumbentModel;
    }
  }

  // ── resolve the incumbent (Anthropic) key ──────────────────────────────────
  {
    // harness-swap ALWAYS races the real `claude -p` tool (Claude Code) against
    // Fireworks, regardless of which harness detection labeled as the incumbent.
    // Override the incumbent to Claude so the left pane's labels, model, and
    // pricing honestly reflect what runs. Each side runs in its own isolated
    // CLAUDE_CONFIG_DIR with a clean settings.json (no ~/.claude/settings.json
    // dependency), so the incumbent authenticates with an Anthropic API key
    // (no keychain) — resolve it from --anthropic-key / env / fireconnect
    // config / a TTY prompt. Model from --anthropic-model / --model / form, else
    // a sensible default.
    const claudeModelRaw = ctx.anthropicModel || ctx.main || "opus";
    const cliModel = stripClaudeCodeContextSuffix(claudeModelRaw);
    const modelId = cliModel;
    // Resolve the Anthropic API key with full precedence: --anthropic-key flag
    // → a key detection already found (probeClaude checks settings env > config
    // > ANTHROPIC_API_KEY env) when the detected incumbent is itself Anthropic
    // → re-scan ~/.claude/settings.json env + config + env → TTY prompt. The
    // isolated run can't use the keychain, but it CAN use a key stored in the
    // user's settings env, so don't skip it (pass the real settings env, not {}).
    let anthropicKey = ctx.anthropicKey?.trim() || "";
    if (!anthropicKey && incumbent.kind === "anthropic" && incumbent.apiKey) {
      anthropicKey = incumbent.apiKey;
    }
    if (!anthropicKey) {
      const settings = await readJsonIfExists(userSettingsPath(ctx.home, ctx.settingsPath));
      const { apiKey: resolvedKey } = await resolveAnthropicKey({ home: ctx.home, env: settings.env ?? {} });
      anthropicKey = resolvedKey;
    }
    if (!anthropicKey && useTui && !options.yes) {
      const r = await promptAnthropicKey({ stdin: process.stdin, stdout: process.stdout });
      if (r.key) {
        anthropicKey = r.key;
        promptedKey = r.key;
      }
    }
    if (!anthropicKey) {
      throw new Error(
        "Harness swap needs an Anthropic API key for the isolated incumbent run (no keychain). "
        + "Pass --anthropic-key, export ANTHROPIC_API_KEY, or run in a TTY to paste one.",
      );
    }
    incumbent = {
      harness: HARNESS.CLAUDE,
      providerLabel: "Anthropic",
      modelLabel: prettyClaudeLabel(modelId),
      modelId,
      cliModel,
      kind: "anthropic",
      callMode: "live",
      apiKey: anthropicKey,
      detected: true,
      pricingEstimated: false,
      note: "Claude Code",
    };
    if (useTui && !options.yes) {
      // no framing needed — the form was the first screen
    } else if (useTui) {
      printFraming(incumbent, fireworksHarness, `Fireworks · ${challengerLabelFor(options.challenger)}`);
    }
  }

  const challengerLabel = challengerLabelFor(options.challenger);
  const challengerDisplay = `Fireworks · ${challengerLabel}`;

  // Pricing for the finalized challenger (validated after the form).
  const fwRates = fireworksRates(options.challenger);
  if (!fwRates) {
    throw new Error(
      `Could not resolve Fireworks pricing for --challenger ${options.challenger}. `
      + `Pick a serverless model from \`fireconnect model list\`.`,
    );
  }

  // Pre-flight the Fireworks key + challenger model before racing (both modes
  // call Fireworks). Re-prompts on a 401/403; throws on an unavailable model.
  // Runs in EVERY mode (TTY, --json, --yes, non-TTY) so a bad key / unavailable
  // model is caught BEFORE both `claude -p` sides start racing. canPrompt is
  // false for --yes / non-TTY so it throws instead of trying to prompt.
  {
    const r = await ensureCallableFireworksKey({
      fwKey, model: options.challenger,
      canPrompt: useTui && !options.yes,
      stdin: process.stdin, stdout: process.stdout,
    });
    fwKey = r.fwKey;
    if (r.prompted) {
      promptedFwKey = true;
    }
  }

  // ── prepare output dir ────────────────────────────────────────────────────
  const outDir = path.resolve(options.out);
  const mode = "harness-swap";
  const dirs = await prepareOutputDir(outDir, {
    prompt: { title: prompt.title, text: prompt.prompt, source: prompt.source, presetId: prompt.presetId },
    mode,
    challengerModel: options.challenger,
  });

  // ── State 3: the race ─────────────────────────────────────────────────────
  const incRates = incumbentPricing(incumbent);
  const leftProviderLabel = incumbent.providerLabel;
  const leftModelLabel = incumbent.modelLabel;
  const leftLabel = `${leftProviderLabel} · ${leftModelLabel}`;

  /** @type {any} */
  const incRunProto = {
    side: "incumbent",
    provider: leftProviderLabel,
    model: leftModelLabel,
    modelId: incumbent.modelId,
    callMode: "live",
    inputTokens: 0,
    outputTokens: 0,
    seconds: 0,
    cost: 0,
    rates: rateShape(incRates, leftProviderLabel),
    ok: false,
    appRunnable: false,
  };
  /** @type {any} */
  const fwRunProto = {
    side: "fireworks",
    provider: "Fireworks",
    model: challengerLabel,
    modelId: options.challenger,
    callMode: "live",
    inputTokens: 0,
    outputTokens: 0,
    seconds: 0,
    cost: 0,
    rates: rateShape(fwRates, "Fireworks"),
    ok: false,
    appRunnable: false,
  };

  let incumbentAppHtml = "";
  let fireworksAppHtml = "";

  // ── build the two side runners per mode ───────────────────────────────────
  // Both runners return the same result shape, so the renderer / measurement /
  // output writers are driver-agnostic.
  let leftRunner;
  let rightRunner;
  let incCwd = null;
  let fwCwd = null;
  // harness-swap drives the user's real tool headlessly on two backends via the
  // headless-runner registry. Only Claude Code is registered today; adding
  // opencode/codex/etc. is a new adapter in harness-runners.mjs (no other
  // wiring). The runner builds two isolated side configs (incumbent → native
  // backend, challenger → Fireworks) and spawns the tool per side. No
  // ~/.claude/settings.json dependency on either side (no merge, no leak).
  const runner = getHeadlessRunner(incumbent.harness);
  if (!runner) {
    throw new Error(
      `Harness swap doesn't have a headless runner for "${incumbent.harness}" yet. `
      + `Supported: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
    );
  }
  const keyType = detectApiKeyType(fwKey);
  const { incumbentDir, challengerDir, cleanup: cleanupRoute } = await runner.buildRaceSettings({
    tmpRoot: await mkdtemp(path.join(os.tmpdir(), "fireconnect-demo-")),
    incumbentKey: incumbent.apiKey || "",
    incumbentModel: incumbent.cliModel || "",
    fireworksKey: fwKey,
    challengerModel: options.challenger,
    keyType,
  });
  cleanupFns.push(cleanupRoute);
  incCwd = await mkdtemp(path.join(os.tmpdir(), "fc-demo-inc-"));
  fwCwd = await mkdtemp(path.join(os.tmpdir(), "fc-demo-fw-"));
  cleanupFns.push(async () => rm(incCwd, { recursive: true, force: true }).catch(() => {}));
  cleanupFns.push(async () => rm(fwCwd, { recursive: true, force: true }).catch(() => {}));
  leftRunner = (io) => runner.runSide({ configDir: incumbentDir, cwd: incCwd, prompt: prompt.prompt, model: incumbent.cliModel || "", ...io });
  rightRunner = (io) => runner.runSide({ configDir: challengerDir, cwd: fwCwd, prompt: prompt.prompt, ...io });

  let incResult = null;
  let fwResult = null;
  if (useTui) {
    renderer = new SplitPaneRenderer({
      incumbent: sideHeader(incRunProto, incRates, "list price"),
      fireworks: sideHeader(fwRunProto, fwRates, "serverless"),
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
      await finalizeBoth({ incResult, fwResult, incRates, fwRates,
        setIncHtml: (h) => { incumbentAppHtml = h; }, setFwHtml: (h) => { fireworksAppHtml = h; },
        incRunProto, fwRunProto, incCwd, fwCwd });
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
    await finalizeBoth({ incResult, fwResult, incRates, fwRates,
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
    printVerdict(result, challengerLabel);
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
      fireworksLabel: challengerDisplay,
      copySummary: buildCopySummary(result, leftLabel, challengerLabel),
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
    // The incumbent is Claude (overridden above), so suggest routing it at Fireworks.
    printConvert(outDir, incumbent.harness, challengerLabel);
  }

  // ── State 6b: offer to persist a key that was entered for this run only. ──
  //    Default No — never surprise-write a secret to disk.
  if (promptedKey) {
    const save = await confirmYesNo("Save this Anthropic key for next time?", {
      stdin: process.stdin, stdout: process.stdout,
    });
    if (save) {
      await persistGlobalAnthropicApiKey(ctx.home, promptedKey);
      console.log(`  ${DIM("Saved to ~/.fireconnect/config.json — future runs will use it.")}`);
    }
  }
  if (promptedFwKey) {
    const save = await confirmYesNo("Save this Fireworks key for next time?", {
      stdin: process.stdin, stdout: process.stdout,
    });
    if (save) {
      // Through the keychain path so baked-key sync runs here too — a demo
      // save is a key store like any other, and this block runs after the
      // TUI, so the sync notes print into plain console output.
      await persistApiKeyFromFlag(ctx.home, fwKey);
      console.log(`  ${DIM("Saved — future runs will use it.")}`);
    }
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

// ── options ─────────────────────────────────────────────────────────────────

function normalizeOptions(ctx) {
  return {
    prompt: ctx.prompt,
    promptFile: ctx.promptFile,
    challenger: ctx.challenger || DEFAULT_CHALLENGER,
    out: ctx.out || DEFAULT_OUT_DIR,
    noOpen: ctx.noOpen,
    json: ctx.json,
    yes: ctx.yes,
  };
}

// ── finalize both sides ─────────────────────────────────────────────────────
// Each side is a real, measured run — finalize them independently.

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

function fireworksRates(challenger) {
  const p = lookupFireworksPricing(challenger);
  if (!p) {
    return null;
  }
  return {
    inputPerMillion: p.input,
    outputPerMillion: p.output,
    cachedInputPerMillion: p.cachedInput,
    tier: p.tier ?? "standard",
    source: p.source ?? FIREWORKS_PRICING_DOCS_URL,
    label: p.label,
  };
}

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

// ── pre-flight ──────────────────────────────────────────────────────────────

// Validate the Fireworks key + challenger model with a tiny non-streaming
// completion before racing, so a bad key or uncallable model fails up front
// instead of mid-race. Uses the Fireworks OpenAI-compatible chat/completions
// endpoint directly (the race itself drives the real `claude` tool; this is
// just a 1-token ping).
async function preflightFireworks(apiKey, model) {
  try {
    const modelId = model.startsWith("accounts/") ? model : normalizeModelId(model);
    const res = await fetch(`${FIREWORKS_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Say OK." }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    if (res.ok) {
      return { ok: true };
    }
    let body = "";
    try { body = await res.text(); } catch { body = ""; }
    return { ok: false, error: `Fireworks preflight failed (${res.status} ${res.statusText}): ${body.slice(0, 200)}`, httpStatus: res.status };
  } catch (error) {
    return { ok: false, error: error.message, httpStatus: 0 };
  }
}

/**
 * True when a pre-flight failure is an auth problem (bad/missing key) rather
 * than the model being unavailable — i.e. a re-prompt for the key might fix it.
 * Trusts the HTTP status when present; falls back to matching the error text
 * for thrown errors that don't surface a status. Exported for unit testing.
 */
export function isAuthFailure(pre) {
  if (pre.httpStatus === 401 || pre.httpStatus === 403) {
    return true;
  }
  const e = pre.error ?? "";
  return /401|403|unauthorized|api key.{0,40}invalid|invalid.{0,40}api key/i.test(e);
}

/**
 * Pre-flight the resolved Fireworks key against the challenger model, prompting
 * for a fresh key when the resolved one is rejected as invalid (401/403) and
 * retrying. Returns the key to race with and whether it came from a prompt (so
 * the orchestrator can offer to persist it after the run).
 *
 * `canPrompt` false (e.g. `--yes`) skips the masked prompt and throws on any
 * failure, preserving the non-interactive contract.
 *
 * @param {{
 *   fwKey: string,
 *   model: string,
 *   canPrompt?: boolean,
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} args
 * @returns {Promise<{ fwKey: string, prompted: boolean }>}
 */
async function ensureCallableFireworksKey({
  fwKey, model, canPrompt = true,
  stdin = process.stdin, stdout = process.stdout,
}) {
  let key = fwKey;
  let prompted = false;
  // Cap retries so a user who keeps pasting bad keys isn't trapped forever.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pre = await preflightFireworks(key, model);
    if (pre.ok) {
      return { fwKey: key, prompted };
    }
    if (!isAuthFailure(pre) || !canPrompt) {
      // Either the key authenticates but the model isn't callable (not fixable
      // here), or we can't prompt (--yes / non-interactive). Surface the
      // relevant fix instead of retrying silently.
      if (!isAuthFailure(pre)) {
        throw new Error(
          `Challenger ${model} is not callable on your account: ${pre.error} `
          + `Pick another model with --challenger (see \`fireconnect model list\`).`,
        );
      }
      throw new Error(
        "No usable Fireworks API key — the challenger can't run. "
        + "Run `fireconnect configure`, export FIREWORKS_API_KEY, or pass --api-key.",
      );
    }
    // Auth failure, interactive: offer a fresh key for this run instead of bailing.
    const r = await promptFireworksKey({ stdin, stdout });
    if (!r.key) {
      throw new Error(
        "No usable Fireworks API key — the challenger can't run. "
        + "Run `fireconnect configure`, export FIREWORKS_API_KEY, or pass --api-key.",
      );
    }
    key = r.key;
    prompted = true;
  }
  throw new Error(
    "Repeatedly got an invalid Fireworks API key. Re-run with a valid key "
    + "(export FIREWORKS_API_KEY or pass --api-key), or run `fireconnect configure`.",
  );
}

// ── UI: states 1, 2, 4, 6 ───────────────────────────────────────────────────

function printFraming(incumbent, fireworksHarness, challengerDisplay) {
  console.log("");
  console.log("  FireConnect Demo");
  console.log("  Same prompt, two providers. Let's build something and race.");
  console.log("");
  console.log(`  You're currently on:  ${incumbent.providerLabel} · ${incumbent.modelLabel}`);
  if (!incumbent.detected) {
    console.log(`  ${DIM(`(${incumbent.note})`)}`);
  }
  console.log(`  Challenger:            ${challengerDisplay}`);
  console.log("");
}

function printVerdict(result, challengerLabel) {
  console.log("");
  console.log("  " + "─".repeat(58));
  const speedPart = verdictSpeed(result, challengerLabel);
  const costPart = verdictCost(result);
  console.log(`  ${speedPart} · ${costPart}`);
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (bothOk && result.incumbent.appRunnable && result.fireworks.appRunnable) {
    console.log("  Both built a working app. See for yourself →");
  } else if (!bothOk) {
    const failed = !result.incumbent.ok ? "comparison model" : "fireworks";
    console.log(`  The run was incomplete (${failed} failed). No winner declared on a partial result.`);
  } else {
    console.log("  One build didn't run. See for yourself →");
  }
  console.log("  " + "─".repeat(58));
}

function verdictSpeed(result, challengerLabel) {
  const ratio = result.summary.speedRatio;
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk || !ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return "speed not comparable";
  }
  if (ratio > 1) {
    return `${challengerLabel} finished ${formatSpeedRatio(ratio)} faster`;
  }
  if (ratio < 1) {
    return `your comparison model was ${(1 / ratio).toFixed(1)}× faster`;
  }
  return "a dead heat on speed";
}

function verdictCost(result) {
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk) {
    // A failed side keeps cost at 0, which would make costSavedFraction 0 and
    // print "same cost" next to the incomplete-run message. Don't compare cost
    // on a partial run.
    return "cost not comparable";
  }
  const frac = result.summary.costSavedFraction;
  if (!Number.isFinite(frac)) {
    return "cost not comparable";
  }
  const pct = Math.round(frac * 100);
  if (pct > 0) {
    return `${pct}% cheaper on Fireworks`;
  }
  if (pct < 0) {
    return `${Math.abs(pct)}% more expensive on Fireworks`;
  }
  return "same cost";
}

function printConvert(outDir, harnessId, challengerLabel) {
  console.log("");
  console.log(`  ✓ Demo complete. Outputs saved to ${outDir}`);
  console.log("");
  console.log(`  Liked ${challengerLabel}? Point your tools at it:`);
  console.log(`    fireconnect ${harnessId} on`);
  console.log("");
  console.log(`  Reversible anytime with  fireconnect ${harnessId} off.`);
  console.log("");
}

function buildCopySummary(result, leftLabel, challengerLabel) {
  const bothOk = result.incumbent.ok && result.fireworks.ok;
  if (!bothOk) {
    // Never claim a winner on a partial run — mirror the TUI verdict's honesty.
    return `Raced ${leftLabel} vs Fireworks ${challengerLabel} on the ${result.promptTitle} prompt — one side didn't finish, so no comparison. Built with \`fireconnect demo\`.`;
  }
  const speedPart = verdictSpeedText(result, leftLabel, challengerLabel);
  const frac = result.summary.costSavedFraction;
  const pct = Number.isFinite(frac) ? Math.round(frac * 100) : 0;
  const costPart = pct > 0 ? `${pct}% cheaper on Fireworks` : pct < 0 ? `${Math.abs(pct)}% more expensive on Fireworks` : "same cost";
  const bothRunnable = result.incumbent.appRunnable && result.fireworks.appRunnable;
  const appPart = bothRunnable ? ", working app" : ", one build didn't run";
  return (
    `Raced ${leftLabel} vs Fireworks ${challengerLabel} on the same ${result.promptTitle} prompt. `
    + `${speedPart}, ${costPart}${appPart}. Built with \`fireconnect demo\`.`
  );
}

// Speed verdict text for the copy summary — mirrors verdictSpeed's direction
// logic so a faster incumbent isn't reported as a Fireworks win.
function verdictSpeedText(result, leftLabel, challengerLabel) {
  const ratio = result.summary.speedRatio;
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) {
    return "speed not comparable";
  }
  if (ratio > 1) {
    return `${challengerLabel} ${formatSpeedRatio(ratio)} faster`;
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
