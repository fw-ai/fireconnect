/**
 * Browser comparison page + local server for `fireconnect demo` (§7 of the brief).
 *
 * compare.html is fully self-contained: both generated apps are inlined as
 * sandboxed-iframe srcdoc and the result numbers are inlined as JSON, so the
 * page works offline, with no CDN, and opens directly from file:// as well as
 * from the ephemeral local server. The server exists only for the clean
 * handoff feel (the `gh auth login` open-in-browser moment).
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  formatSeconds, formatUsd, formatTokens, formatSpeedRatio, formatCostDelta,
  costPerGenerations,
} from "./measurement.mjs";

const FIREWORKS_DISPLAY = "Fireworks · GLM 5.2 Fast";

/**
 * Build the self-contained compare.html.
 *
 * @param {{
 *   result: import("./measurement.mjs").DemoResult,
 *   incumbentAppHtml: string,
 *   fireworksAppHtml: string,
 *   incumbentRunnable: boolean,
 *   fireworksRunnable: boolean,
 *   incumbentLabel: string,   // "Anthropic · Claude Sonnet 5"
 *   fireworksLabel: string,   // "Fireworks · GLM 5.2 Fast"
 *   copySummary: string,
 * }} args
 * @returns {string}
 */
export function buildCompareHtml({
  result,
  incumbentAppHtml,
  fireworksAppHtml,
  incumbentRunnable,
  fireworksRunnable,
  incumbentLabel,
  fireworksLabel,
  copySummary,
}) {
  const inc = result.incumbent;
  const fw = result.fireworks;
  const bothOk = inc.ok && fw.ok;
  const ratio = formatSpeedRatio(result.summary.speedRatio);
  const delta = formatCostDelta(result.summary.costSavedFraction);
  const inc1k = costPerGenerations({ cost: inc.cost });
  const fw1k = costPerGenerations({ cost: fw.cost });
  // Speed direction: speedRatio = incumbentSeconds / fireworksSeconds, so >1
  // means Fireworks (challenger) is faster and <1 means the incumbent is faster.
  // Only attribute the speed to a side when the ratio is finite and decisive.
  const sr = result.summary.speedRatio;
  let speedSide = "Fireworks";
  if (Number.isFinite(sr) && sr > 0) {
    if (sr < 1) speedSide = escapeHtml(incumbentLabel);
    else if (sr > 1) speedSide = escapeHtml(fireworksLabel);
  }
  // Only a run where both sides finished yields an honest comparison. On a
  // partial run, the strip states what happened instead of asserting a winner.
  const stripInner = bothOk
    ? `<div class="item">Speed: <b>${ratio}</b> on ${speedSide}</div>
  <div class="item">Cost: <b>${delta}</b> on Fireworks</div>
  <div class="item extrap">At 1,000 generations: ${formatUsd(inc1k)} → ${formatUsd(fw1k)} <span class="badge" style="margin-left:6px">linear extrapolation</span></div>`
    : `<div class="item">Run incomplete — ${escapeHtml(!inc.ok ? incumbentLabel : fireworksLabel)} didn't finish, so no speed/cost comparison is shown.</div>`;

  const payload = {
    promptTitle: result.promptTitle,
    incumbent: { label: incumbentLabel, seconds: inc.seconds, cost: inc.cost, tokens: inc.outputTokens, callMode: inc.callMode },
    fireworks: { label: fireworksLabel, seconds: fw.seconds, cost: fw.cost, tokens: fw.outputTokens, callMode: fw.callMode },
    summary: result.summary,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FireConnect Demo — ${escapeHtml(result.promptTitle)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; min-height: 100vh; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0d1117; color: #e6edf3; }
  header { padding: 14px 20px; border-bottom: 1px solid #30363d; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; flex: none; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { color: #8b949e; font-size: 13px; }
  /* grid fills the viewport between header and strip (flex:1), with min-height:0
     so the panels/stages can actually flex instead of the iframe collapsing
     against an indefinite percentage height (the old "half the screen blank"). */
  .grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 0; min-height: 0; }
  .panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 2px solid #f78166; }
  .panel:last-child { border-right: none; }
  .bar { padding: 10px 14px; background: #161b22; border-bottom: 1px solid #30363d; flex: none; }
  .bar .name { font-weight: 600; font-size: 13px; }
  .bar .name.fw { color: #f78166; }
  .bar .metrics { display: flex; gap: 16px; margin-top: 4px; font-size: 12px; color: #8b949e; flex-wrap: wrap; }
  .bar .metrics b { color: #e6edf3; font-weight: 600; }
  .bar .badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: #21262d; color: #8b949e; margin-left: 8px; }
  .stage { flex: 1; position: relative; background: #fff; min-height: 120px; }
  /* Absolute inset:0 fills the stage's actual rendered box — robust against the
     indefinite-height percentage collapse that left the iframe blank. */
  .stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  .code { display: none; position: absolute; inset: 0; overflow: auto; background: #0d1117; color: #c9d1d9; padding: 12px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
  .code.show { display: block; }
  .note { padding: 8px 14px; font-size: 12px; color: #d29922; background: #211b00; border-top: 1px solid #30363d; flex: none; }
  .controls { padding: 6px 14px; background: #161b22; border-top: 1px solid #30363d; display: flex; gap: 8px; flex: none; }
  button { font: inherit; color: #e6edf3; background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  button:hover { background: #30363d; }
  .strip { padding: 14px 20px; border-top: 1px solid #30363d; background: #161b22; display: flex; gap: 24px; flex-wrap: wrap; align-items: center; flex: none; }
  .strip .item { font-size: 13px; }
  .strip .item b { color: #f78166; }
  .strip .extrap { color: #8b949e; font-size: 12px; }
  .toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: #1f6feb; color: #fff; padding: 8px 14px; border-radius: 6px; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } .panel { border-right: none; border-bottom: 2px solid #f78166; } }
</style>
</head>
<body>
<header>
  <h1>FireConnect Demo</h1>
  <span class="sub">${escapeHtml(result.promptTitle)} · same prompt, same seed, two providers</span>
</header>
<div class="grid">
  ${panelHtml({ side: "incumbent", label: incumbentLabel, run: inc, callMode: inc.callMode, appHtml: incumbentAppHtml, runnable: incumbentRunnable, fw: false })}
  ${panelHtml({ side: "fireworks", label: fireworksLabel, run: fw, callMode: fw.callMode, appHtml: fireworksAppHtml, runnable: fireworksRunnable, fw: true })}
</div>
<div class="strip">
  ${stripInner}
  <div style="margin-left:auto"><button id="copy">Copy summary</button></div>
</div>
<div class="toast" id="toast">Copied</div>
<script id="result" type="application/json">${safeJsonForScript(JSON.stringify(payload))}</script>
<script>
  ${VIEW_CODE_JS}
  ${COPY_JS.replace("__SUMMARY__", JSON.stringify(copySummary))}
</script>
</body>
</html>`;
}

function panelHtml({ side, label, run, callMode, appHtml, runnable, fw }) {
  const sec = formatSeconds(run.seconds);
  const cost = run.cost > 0 || run.ok ? formatUsd(run.cost) : "—";
  const tok = run.outputTokens == null ? "—" : formatTokens(run.outputTokens);
  const nameClass = fw ? "name fw" : "name";
  const note = runnable
    ? ""
    : `<div class="note">This build didn’t run (model returned non-runnable output). Showing source instead.</div>`;
  // If not runnable, show code by default.
  const codeShow = runnable ? "" : "show";
  return `<section class="panel">
  <div class="bar">
    <div class="${nameClass}">${escapeHtml(label)}</div>
    <div class="metrics">
      <span><b>${sec}</b></span>
      <span><b>${cost}</b></span>
      <span><b>${tok}</b> tok</span>
    </div>
  </div>
  <div class="stage">
    <iframe sandbox="allow-scripts" srcdoc="${escapeAttr(appHtml)}"></iframe>
    <div class="code ${codeShow}">${escapeHtml(appHtml)}</div>
  </div>
  ${note}
  <div class="controls"><button data-toggle="${side}">View code ▸</button></div>
</section>`;
}

const VIEW_CODE_JS = `
document.querySelectorAll('button[data-toggle]').forEach(function(btn){
  btn.addEventListener('click', function(){
    var panel = btn.closest('.panel');
    var code = panel.querySelector('.code');
    var iframe = panel.querySelector('iframe');
    var on = code.classList.toggle('show');
    iframe.style.display = on ? 'none' : 'block';
    btn.textContent = on ? 'View app ▸' : 'View code ▸';
  });
});
`;

const COPY_JS = `
var summary = document.getElementById('result') && JSON.parse(document.getElementById('result').textContent);
document.getElementById('copy').addEventListener('click', function(){
  var text = __SUMMARY__;
  var toast = document.getElementById('toast');
  var done = function(){ toast.classList.add('show'); setTimeout(function(){ toast.classList.remove('show'); }, 1400); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function(){ fallback(text); done(); });
  } else { fallback(text); done(); }
});
function fallback(text){ var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch(e){} document.body.removeChild(t); }
`;

// ── local static server ─────────────────────────────────────────────────────

/**
 * Serve a directory on 127.0.0.1 with a random high port. Returns the URL and a
 * close() handle. Serves compare.html at / and the raw files by name.
 *
 * @param {string} dir
 * @returns {Promise<{ url: string, port: number, close: () => void }>}
 */
export function serveStatic(dir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const file = reqPath === "/" ? "compare.html" : reqPath.replace(/^\//, "");
        const safe = path.basename(file);
        const full = path.join(dir, safe);
        const data = await readFile(full);
        const ext = path.extname(safe).toLowerCase();
        const type = ext === ".html" ? "text/html; charset=utf-8"
          : ext === ".json" ? "application/json; charset=utf-8"
          : ext === ".txt" ? "text/plain; charset=utf-8"
          : ext === ".log" ? "text/plain; charset=utf-8"
          : "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
      } catch (error) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    });
    // Track live sockets so close() can destroy them. A browser holds its
    // connection open with keep-alive; without forcing those sockets shut,
    // server.close() never fires and the Node event loop stays alive, hanging
    // the CLI after the run is done.
    const sockets = new Set();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const close = () => {
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* noop */ }
      }
      server.close();
    };
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {any} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}/compare.html`, port, close });
    });
  });
}

/**
 * Open a URL in the platform default browser. Returns true if it likely opened.
 * @param {string} url
 * @returns {boolean}
 */
export function openInBrowser(url) {
  const { platform } = process;
  try {
    if (platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else if (platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

// ── escaping ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

/**
 * A JSON string safe to embed inside a <script> element. Script content is raw
 * text (entities are NOT decoded), so HTML-escaping would corrupt it. The only
 * breakout risk is the literal sequence `</script>`, so escape `<` as <.
 */
function safeJsonForScript(json) {
  return String(json).replace(/</g, "\\u003c");
}
