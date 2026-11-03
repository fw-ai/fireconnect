import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { isColorEnabled, loadBannerArt, printBanner } from "../../lib/ui/index.mjs";
import { stripBannerMarkup } from "../../lib/ui/banner-render.mjs";
import { callbackPage, signInPage } from "../../lib/auth/sign-in-page.mjs";
import { terminalTheme, truecolorSupported } from "../../lib/ui/color.mjs";
import { logoGradientAt } from "../../lib/ui/theme.mjs";
import { CLI_COLORS, LOGO_GRADIENT } from "../../lib/ui/tokens.mjs";
import {
  ANSI,
  _setColorEnabled,
  accent,
  closestMatch,
  colorizeHelp,
  colorsEnabled,
  dim,
  fail,
  muted,
  ok,
  symbols,
  warn,
  withSuggestion,
  yesNo,
} from "../../lib/ui.mjs";
import { runFireconnect } from "../helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNER_SCRIPT = path.join(__dirname, "../../bin/nexus-banner.mjs");

function runBannerScript(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    // An explicit `undefined` deletes the key from the child env; spreading it
    // would spawn the child with the literal string "undefined".
    const childEnv = { ...process.env, ...env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
    }
    const child = spawn(process.execPath, [BANNER_SCRIPT, ...args], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ui tokens", () => {
  it("renders the sign-in pages in the Fireworks brand, self-contained", () => {
    const pages = [callbackPage(true), callbackPage(false), signInPage("https://auth.example.com/oauth2/authorize?a=1&b=2")];
    for (const page of pages) {
      assert.match(page, /\.sym path\{fill:#F9F7F5\}/);
      assert.match(page, /color:#280016/);
      assert.doesNotMatch(page, /—|·/, "no em dash or middle dot");
      assert.doesNotMatch(page, /<(script|link|img|iframe)\b|url\(/i, "no scripts or network assets");
    }
    assert.match(callbackPage(false), /Use an API key instead/);
    assert.doesNotMatch(callbackPage(true), /Use an API key instead/);
    assert.match(callbackPage(true), /Return to your terminal\./);
    assert.match(callbackPage(false, { returnTo: "app" }), /Return to the Nexus app to try again\./);
    assert.match(callbackPage(true, { returnTo: "app" }), /Return to the Nexus app\./);
    // Pasting a key is a CLI fallback, not offered in the app.
    assert.doesNotMatch(callbackPage(false, { returnTo: "app" }), /Use an API key instead|terminal/);
  });

  it("offers Google, GitHub, LinkedIn and email, with the authorize URL escaped", () => {
    const page = signInPage(`https://auth.example.com/oauth2/authorize?a=1&b="x"`);
    for (const provider of ["Google", "GitHub", "LinkedIn"]) {
      assert.ok(page.includes(`href="https://auth.example.com/oauth2/authorize?a=1&amp;b=&quot;x&quot;&amp;identity_provider=${provider}"`), provider);
      assert.match(page, new RegExp(`Continue with ${provider}`));
    }
    assert.match(page, /href="https:\/\/auth\.example\.com\/oauth2\/authorize\?a=1&amp;b=&quot;x&quot;"[^>]*>.*Continue with email/s);
    assert.match(page, /href="https:\/\/nexus\.fireworks\.ai\/signup"[^>]*>Create an account/);
  });

  it("escapes single quotes as well as double quotes in the authorize URL", () => {
    const page = signInPage("https://auth.example.com/oauth2/authorize?a='x'");
    assert.ok(page.includes("a=&#39;x&#39;"));
    assert.doesNotMatch(page, /a='x'/);
  });
});

describe("ui color", () => {
  it("disables color when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      assert.equal(isColorEnabled({ isTTY: true }), false);
    } finally {
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });

  it("enables color when FORCE_COLOR is set on a non-tty stream", () => {
    const prevNo = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      assert.equal(isColorEnabled({ isTTY: false }), true);
    } finally {
      if (prevNo === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prevNo;
      }
      if (prevForce === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = prevForce;
      }
    }
  });

  it("disables color on non-tty streams by default", () => {
    const prevNo = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    try {
      assert.equal(isColorEnabled({ isTTY: false }), false);
    } finally {
      if (prevNo === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prevNo;
      }
      if (prevForce === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = prevForce;
      }
    }
  });
});

describe("colorsEnabled", () => {
  it("is off for non-TTY streams", () => {
    assert.equal(colorsEnabled({ isTTY: false }, {}), false);
  });

  it("is on for TTY streams", () => {
    assert.equal(colorsEnabled({ isTTY: true }, {}), true);
  });

  it("NO_COLOR wins over TTY", () => {
    assert.equal(colorsEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  });

  it("FORCE_COLOR wins over non-TTY", () => {
    assert.equal(colorsEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  });

  it("FORCE_COLOR=0 does not force", () => {
    assert.equal(colorsEnabled({ isTTY: false }, { FORCE_COLOR: "0" }), false);
  });

  it("TERM=dumb disables color", () => {
    assert.equal(colorsEnabled({ isTTY: true }, { TERM: "dumb" }), false);
  });
});

describe("color guide", () => {
  it("defaults to dark and honors NEXUS_THEME and a light COLORFGBG background", () => {
    assert.equal(terminalTheme({}), "dark");
    assert.equal(terminalTheme({ NEXUS_THEME: "light" }), "light");
    assert.equal(terminalTheme({ COLORFGBG: "0;15" }), "light");
    assert.equal(terminalTheme({ COLORFGBG: "15;0" }), "dark");
    assert.equal(terminalTheme({ COLORFGBG: "0;15", NEXUS_THEME: "dark" }), "dark");
  });

  it("pins the guide's primary and accent colors", () => {
    assert.deepEqual(CLI_COLORS.dark, { primary: "#FC7293", accent: "#F0ACD6" });
    assert.deepEqual(CLI_COLORS.light, { primary: "#BF1153", accent: "#A71E7E" });
  });

  it("runs the logo gradient through every stop", () => {
    assert.equal(logoGradientAt(0), LOGO_GRADIENT[0]);
    assert.equal(logoGradientAt(1 / 3), LOGO_GRADIENT[1]);
    assert.equal(logoGradientAt(2 / 3), LOGO_GRADIENT[2]);
    assert.equal(logoGradientAt(1), LOGO_GRADIENT[3]);
  });

  it("paints the banner only on the install screen", async () => {
    // Pin a truecolor terminal: an inherited TERM_PROGRAM=Apple_Terminal
    // (without COLORTERM) would downsample the gradient to 256 colors.
    const install = await runBannerScript(["--context", "install"], { FORCE_COLOR: "1", TERM_PROGRAM: undefined, COLORTERM: undefined });
    assert.match(install.stdout, /\x1b\[38;2;217;117;71m/, "gradient starts at the first stop");
    const other = await runFireconnect(["banner"], { FORCE_COLOR: "1" });
    assert.doesNotMatch(other.stdout, /\x1b\[/);
  });

  it("uses truecolor everywhere except Terminal.app without COLORTERM", () => {
    assert.equal(truecolorSupported({}), true);
    assert.equal(truecolorSupported({ TERM_PROGRAM: "iTerm.app" }), true);
    assert.equal(truecolorSupported({ TERM_PROGRAM: "Apple_Terminal" }), false);
    assert.equal(truecolorSupported({ TERM_PROGRAM: "Apple_Terminal", COLORTERM: "truecolor" }), true);
    assert.equal(truecolorSupported({ TERM_PROGRAM: "Apple_Terminal", COLORTERM: "24bit" }), true);
  });

  it("paints the install banner in 256 colors on Terminal.app", async () => {
    // Clear COLORTERM: shells such as VS Code and iTerm export
    // COLORTERM=truecolor, which would otherwise survive the spread of
    // process.env and make the child report truecolor support.
    const install = await runBannerScript(["--context", "install"], { FORCE_COLOR: "1", TERM_PROGRAM: "Apple_Terminal", COLORTERM: undefined });
    assert.match(install.stdout, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(install.stdout, /\x1b\[[34]8;2;/);
  });

  it("downsamples the shared palette on Terminal.app", () => {
    const palette = path.join(__dirname, "../../lib/ui/palette.mjs");
    const script = `const { ANSI, DATA, METER } = await import(${JSON.stringify(palette)});
      console.log(JSON.stringify([ANSI.primary, ANSI.accent, ...Object.values(DATA), ...METER.modelPalette]));`;
    const read = (env) => {
      // Same `undefined`-deletes convention as runBannerScript, so an
      // inherited COLORTERM/TERM_PROGRAM cannot leak into either case.
      const childEnv = { ...process.env, ...env };
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete childEnv[key];
      }
      return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: childEnv,
        encoding: "utf8",
      }));
    };
    assert.ok(read({ TERM_PROGRAM: "Apple_Terminal", COLORTERM: undefined }).every((sgr) => /^(\x1b\[)?38;5;\d+m?$/.test(sgr)));
    assert.ok(read({ TERM_PROGRAM: undefined, COLORTERM: undefined }).every((sgr) => /^(\x1b\[)?38;2;\d+;\d+;\d+m?$/.test(sgr)));
  });
});

describe("styling", () => {
  afterEach(() => {
    _setColorEnabled(false);
  });

  it("emits no escape codes when disabled (test/pipe default)", () => {
    _setColorEnabled(false);
    assert.equal(dim("plain"), "plain");
    assert.ok(!ok("done").includes("\x1b"));
    assert.ok(!fail("broke").includes("\x1b"));
    assert.ok(!warn("careful").includes("\x1b"));
    assert.ok(!yesNo(true).includes("\x1b"));
    const help = "Commands:\n  on    Enable";
    assert.equal(colorizeHelp(help), help);
  });

  it("emits escape codes when enabled", () => {
    _setColorEnabled(true);
    assert.ok(dim("x").includes("\x1b[2m"));
    assert.equal(yesNo(true), "yes", "yes stays in the default color");
    assert.ok(yesNo(false).includes("\x1b[31m"));
  });

  it("accent uses the color guide's accent when enabled", () => {
    _setColorEnabled(true);
    assert.equal(accent("cmd"), `${ANSI.accent}cmd\x1b[39m`);
  });

  it("ok marks the check in primary and leaves the message in the default color", () => {
    _setColorEnabled(true);
    assert.equal(ok("done"), `${ANSI.primary}${symbols.ok}\x1b[39m done`);
  });

  it("accent stays plain on a non-TTY stream", () => {
    _setColorEnabled(false);
    assert.equal(accent("cmd", { isTTY: false }), "cmd");
  });

  it("muted uses 90m gray when enabled", () => {
    _setColorEnabled(true);
    assert.ok(muted("label").includes("\x1b[90m"));
  });

  it("colorizeHelp bolds section headers and keeps layout", () => {
    _setColorEnabled(true);
    const colored = colorizeHelp("Commands:\n  on    Enable routing");
    const lines = colored.split("\n");
    assert.ok(lines[0].startsWith("\x1b[1m"));
    // Indentation is untouched so columns still line up.
    assert.ok(lines[1].replace(/\x1b\[[0-9;]*m/g, "") === "  on    Enable routing");
  });

  it("colorizeHelp uses bold for command tokens, not a color", () => {
    _setColorEnabled(true);
    const colored = colorizeHelp("Commands:\n  on    Enable routing\n  --api-key <key>  Key");
    assert.ok(colored.includes("\x1b[1mon\x1b[22m"));
    assert.ok(colored.includes("\x1b[1m--api-key\x1b[22m"));
    assert.ok(!colored.includes("\x1b[36m"));
  });
});

describe("closestMatch", () => {
  it("finds a near miss", () => {
    assert.equal(closestMatch("cluade", ["claude", "opencode", "codex"]), "claude");
    assert.equal(closestMatch("statsu", ["on", "off", "status"]), "status");
    assert.equal(closestMatch("--serach", ["--search", "--model", "--mode"]), "--search");
  });

  it("returns nothing when everything is far away", () => {
    assert.equal(closestMatch("zzzzzz", ["claude", "opencode"]), "");
    assert.equal(closestMatch("--slot", ["--json", "--model", "--search"]), "");
  });

  it("withSuggestion appends only when a match exists", () => {
    assert.equal(
      withSuggestion("Unknown command: cluade.", "cluade", ["claude"]),
      "Unknown command: cluade. Did you mean: claude?",
    );
    assert.equal(
      withSuggestion("Unknown command: zzzzzz.", "zzzzzz", ["claude"]),
      "Unknown command: zzzzzz.",
    );
  });
});

describe("ui banner", () => {
  it("loads checked-in banner art within 80 columns", () => {
    const art = loadBannerArt();
    assert.ok(art.length > 0);
    for (const line of art.split("\n")) {
      const width = stripBannerMarkup(line).length;
      assert.ok(width <= 80, `line exceeds 80 cols: ${width}`);
    }
  });

  it("includes the Ignite your Harness tagline", () => {
    const art = loadBannerArt();
    assert.match(stripBannerMarkup(art), /Ignite your Harness/);
  });

  it("prints plain banner art without ANSI when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printBanner();
      const output = chunks.join("");
      assert.match(output, /Nexus/);
      assert.match(output, /Ignite your Harness/);
      assert.doesNotMatch(output, /\x1b\[/);
    } finally {
      process.stdout.write = originalWrite;
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });
});

describe("fireconnect banner command", () => {
  it("prints banner art (hidden command, not in help)", async () => {
    const { code, stdout } = await runFireconnect(["banner"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.match(stdout, /Nexus/);
    assert.match(stdout, /Ignite your Harness/);
  });

  it("is not listed in fireconnect help", async () => {
    const { code, stdout } = await runFireconnect(["help"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /\bbanner\b/);
  });
});

describe("fireconnect-banner internal script", () => {
  it("prints install success context without art when --success-only", async () => {
    const { code, stdout } = await runBannerScript(["--context", "install", "--success-only"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.match(stdout, /Nexus CLI is installed\./);
    assert.doesNotMatch(stdout, /Ignite your Harness/);
  });

  it("prints banner art and install success for the installer finish screen", async () => {
    const { code, stdout } = await runBannerScript(["--context", "install"], { NO_COLOR: "1" });
    assert.equal(code, 0);
    assert.match(stdout, /Ignite your Harness/);
    assert.match(stdout, /Nexus CLI is installed\./);
  });
});
