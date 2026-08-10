import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";

import { shellQuote } from "../../../lib/cli/path.mjs";
import {
  CLAUDE_LIVE_TMUX_SESSION,
  claudePaneCommand,
  configureLiveTmuxSession,
  isLiveSessionActive,
  printLiveStartupMessage,
  resolveClaudeBin,
  runClaudeLiveTmux,
  tmuxInstallHintLines,
} from "../../../lib/harnesses/claude/live-tmux.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-live-tmux-"));
  temps.push(home);
  return home;
}

function mockStdout() {
  const chunks = [];
  return {
    isTTY: false,
    write(value) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

describe("runClaudeLiveTmux", () => {
  it("creates a detached session when stdout is not a TTY", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();

    await runClaudeLiveTmux({
      home,
      stdout,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "new-session"));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "split-window"));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane" && args.some((part) => String(part).includes("claude"))));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane" && args.some((part) => String(part).includes(`fc-claude-live-${process.pid}.json`))));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args.includes("pane-border-status")));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args.includes("Claude Code")));
    assert.match(stdout.text(), /detached — no terminal for attach/);
    assert.match(stdout.text(), /exit Claude/);
  });

  it("shows the startup message and a 3-2-1 countdown before creating the split", async () => {
    const home = await tempHome();
    const stdout = mockStdout();
    stdout.isTTY = true;
    const calls = [];
    const sleeps = [];
    let attached = false;

    await runClaudeLiveTmux({
      home,
      stdout,
      sleep: async (ms) => { sleeps.push(ms); },
      enterSession: () => { attached = true; },
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    const text = stdout.text();
    assert.match(text, /Opening a live split for Claude Code/);
    assert.match(text, /starting claude session with live cost tracker/);
    assert.ok(/3[\s\S]*2[\s\S]*1[\s\S]*starting claude session/.test(text), "3-2-1 precedes start");
    assert.deepEqual(sleeps, [1000, 1000, 1000], "counts down three seconds");
    assert.ok(attached, "still attaches after the countdown");
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "new-session"),
      "creates the session after the countdown");
  });

  // list-panes yields "#{pane_index} #{pane_pid}"; ps yields "pid ppid comm".
  // The left pane's shell (pid 100) has a claude child (200) when active.
  const activeExec = (cmd, args) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return "0 100\n1 101\n";
    }
    if (cmd === "ps") {
      return "100 1 bash\n200 100 claude\n101 1 node\n";
    }
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };

  it("re-attaches when the session already exists and is active", async () => {
    const stdout = mockStdout();
    stdout.isTTY = true;
    let attached = false;
    await runClaudeLiveTmux({
      home: "/tmp/home",
      stdout,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        if (cmd === "tmux" && args[0] === "has-session") {
          return;
        }
        return activeExec(cmd, args);
      },
      enterSession: () => {
        attached = true;
      },
    });
    assert.ok(attached);
    assert.match(stdout.text(), /re-attaching to existing/);
  });

  it("stays detached when re-attaching without a TTY", async () => {
    const stdout = mockStdout();
    let attached = false;
    await runClaudeLiveTmux({
      home: "/tmp/home",
      stdout,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        if (cmd === "tmux" && args[0] === "has-session") {
          return;
        }
        return activeExec(cmd, args);
      },
      enterSession: () => {
        attached = true;
      },
    });
    assert.equal(attached, false);
    assert.match(stdout.text(), /already running \(detached\)/);
    assert.match(stdout.text(), /tmux attach -t fireconnect-claude-live/);
  });

  it("recreates a stale session instead of re-attaching", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();

    await runClaudeLiveTmux({
      home,
      stdout,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          return;
        }
        if (cmd === "tmux" && args[0] === "list-panes") {
          return "0 100\n1 101\n";
        }
        if (cmd === "ps") {
          // Left pane's shell (100) has no claude/node child — the session is stale.
          return "100 1 bash\n101 1 node\n";
        }
      },
    });

    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "kill-session"));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "new-session"));
    assert.doesNotMatch(stdout.text(), /re-attaching to existing/);
  });

  it("resumes and locks the meter onto --session", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();
    const uuid = "abc12345-1234-1234-1234-123456789012";

    await runClaudeLiveTmux({
      home,
      session: "abc123",
      stdout,
      resolveSession: async () => `${home}/.claude/projects/repo/${uuid}.jsonl`,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    const claudePane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes(`claude --resume ${uuid}`)));
    assert.ok(claudePane, "left pane respawn found");
    assert.ok(claudePane[1].some((part) => String(part).includes(`--resume ${uuid}`)),
      "left pane resumes the requested session");

    const usagePane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes("FC_LIVE_SESSION")));
    assert.ok(usagePane, "right pane carries FC_LIVE_SESSION");
    assert.ok(usagePane[1].some((part) => String(part).includes(`FC_LIVE_SESSION=${uuid}`)),
      "right pane locks onto the requested session");
  });

  it("fails fast when --session matches no session log", async () => {
    const home = await tempHome();
    await assert.rejects(
      () => runClaudeLiveTmux({
        home,
        session: "does-not-exist",
        stdout: mockStdout(),
        resolveSession: async () => undefined,
        spawn: () => ({ status: 0, encoding: "utf8" }),
        execFile: () => {},
      }),
      /No Claude Code session log matching 'does-not-exist'/,
    );
  });

  it("pins a fresh live session to a generated id for both panes", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();
    const uuid = "generated-uuid-1234";

    await runClaudeLiveTmux({
      home,
      stdout,
      newSessionId: () => uuid,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    const claudePane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes(`--session-id ${uuid}`)));
    assert.ok(claudePane, "left pane pins the generated session id");

    const usagePane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes(`FC_LIVE_SESSION=${uuid}`)));
    assert.ok(usagePane, "right pane locks onto the generated id");
  });

  it("launches the left pane with the resolved claude binary", async () => {
    const home = await tempHome();
    const calls = [];

    await runClaudeLiveTmux({
      home,
      stdout: mockStdout(),
      newSessionId: () => "uuid-1",
      resolveClaude: () => "/resolved/bin/claude",
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes("/resolved/bin/claude --session-id uuid-1"))),
      "left pane uses the resolved claude binary, not a login-shell PATH lookup");
  });
});

describe("live tmux helpers", () => {
  it("detects an active live session from the left pane process tree", () => {
    // Left pane shell (100) running claude (200) as a child -> active.
    const active = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "0 100\n1 101\n";
      }
      if (cmd === "ps") {
        return "100 1 bash\n200 100 claude\n101 1 node\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isLiveSessionActive(CLAUDE_LIVE_TMUX_SESSION, { execFile: active }), true);

    // Left pane shell alive but no claude child -> stale.
    const stale = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "0 100\n1 101\n";
      }
      if (cmd === "ps") {
        return "100 1 bash\n101 1 node\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isLiveSessionActive(CLAUDE_LIVE_TMUX_SESSION, { execFile: stale }), false);

    // Claude nested a level down (bash -> sh -> node) still counts.
    const nested = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "0 100\n1 101\n";
      }
      if (cmd === "ps") {
        return "100 1 bash\n200 100 sh\n201 200 node\n101 1 bash\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isLiveSessionActive(CLAUDE_LIVE_TMUX_SESSION, { execFile: nested }), true);

    // Fewer than two panes -> stale.
    const onePane = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "1 101\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isLiveSessionActive(CLAUDE_LIVE_TMUX_SESSION, { execFile: onePane }), false);
  });

  it("treats a failed probe as active rather than tearing down a live session", () => {
    // The process probe gates a destructive kill; when it can't run, the session
    // must be preserved (fail-safe), not killed as "stale".
    const psThrows = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "0 100\n1 101\n";
      }
      if (cmd === "ps") {
        throw new Error("ps unavailable");
      }
      throw new Error("unexpected");
    };
    assert.equal(isLiveSessionActive(CLAUDE_LIVE_TMUX_SESSION, { execFile: psThrows }), true);

    // Even the pane listing failing must not read as stale.
    const listThrows = () => {
      throw new Error("tmux unavailable");
    };
    assert.equal(isLiveSessionActive(CLAUDE_LIVE_TMUX_SESSION, { execFile: listThrows }), true);
  });

  it("wraps Claude with trap-based session teardown", () => {
    assert.match(claudePaneCommand({}), /^trap 'tmux kill-session/);
    assert.match(claudePaneCommand({}), /; claude; tmux kill-session/);
    assert.match(
      claudePaneCommand({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }),
      /env -u ANTHROPIC_AUTH_TOKEN claude/,
    );
    assert.match(claudePaneCommand({}, "/tmp/My Projects"), /export HOME='\/tmp\/My Projects'/);
  });

  it("runs Claude without exec so the teardown kill still fires on exit", () => {
    // `exec claude` replaces the shell, wiping the EXIT trap and skipping the
    // trailing kill — the cost-meter pane kept running after Claude exited.
    // Claude must run as a child so the shell resumes and tears the split down.
    assert.doesNotMatch(claudePaneCommand({}), /exec /);
    assert.match(claudePaneCommand({}), /trap 'tmux kill-session.*EXIT INT TERM; claude; tmux kill-session/);
  });

  it("resumes a session in the left pane when one is given", () => {
    assert.match(claudePaneCommand({}, "/tmp/home", { sessionId: "abc-123", resume: true }), /claude --resume abc-123/);
    assert.match(claudePaneCommand({}, "/tmp/home"), /claude; tmux kill-session/);
    assert.doesNotMatch(claudePaneCommand({}, "/tmp/home"), /--resume/);
    // The auth-token unwrap keeps --resume too.
    assert.match(
      claudePaneCommand({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, "/tmp/home", { sessionId: "abc-123", resume: true }),
      /env -u ANTHROPIC_AUTH_TOKEN claude --resume abc-123/,
    );
  });

  it("pins a fresh session with --session-id instead of resuming", () => {
    const cmd = claudePaneCommand({}, "/tmp/home", { sessionId: "uuid-1" });
    assert.match(cmd, /claude --session-id uuid-1/);
    assert.doesNotMatch(cmd, /--resume/);
    assert.match(
      claudePaneCommand({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, "/tmp/home", { sessionId: "uuid-1" }),
      /env -u ANTHROPIC_AUTH_TOKEN claude --session-id uuid-1/,
    );
  });

  it("uses the resolved absolute claude path in the left pane", () => {
    assert.match(claudePaneCommand({}, "/tmp/home", {}, "/opt/bin/claude"), /\/opt\/bin\/claude; tmux kill-session/);
    // Paths with spaces are shell-quoted.
    assert.match(claudePaneCommand({}, "/tmp/home", {}, "/opt/My Apps/claude"), /'\/opt\/My Apps\/claude'; tmux kill-session/);
    // The auth-token unwrap keeps the absolute bin.
    assert.match(
      claudePaneCommand({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, "/tmp/home", {}, "/opt/bin/claude"),
      /env -u ANTHROPIC_AUTH_TOKEN \/opt\/bin\/claude/,
    );
  });

  it("resolveClaudeBin finds the executable on PATH and falls back to the bare name", async () => {
    const dir = await tempHome();
    const bin = path.join(dir, "claude");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    assert.equal(resolveClaudeBin({ PATH: dir }), bin);
    assert.equal(resolveClaudeBin({ PATH: "/nonexistent-dir" }), "claude");
  });

  it("prints a startup message before attach", () => {
    const stdout = mockStdout();
    stdout.isTTY = true;
    printLiveStartupMessage(stdout);
    assert.match(stdout.text(), /Opening a live split for Claude Code/);
    assert.match(stdout.text(), /left/);
    assert.match(stdout.text(), /live cost meter/);
    assert.match(stdout.text(), /Ctrl\+b then arrow keys/);
  });

  it("configures pane titles and borders", () => {
    const calls = [];
    configureLiveTmuxSession((cmd, args) => {
      calls.push([cmd, args]);
    }, {}, "fireconnect-claude-live:0");
    assert.ok(calls.some(([, args]) => args.includes("pane-border-format")));
    assert.ok(calls.some(([, args]) => args.includes("Live cost")));
    assert.ok(calls.some(([, args]) => args.includes("mouse")));
  });

  it("quotes shell words with spaces via shared shellQuote", () => {
    assert.equal(shellQuote("/tmp/safe-path"), "/tmp/safe-path");
    assert.equal(shellQuote("/tmp/My Projects/x"), "'/tmp/My Projects/x'");
  });

  it("prints an install hint", () => {
    const lines = tmuxInstallHintLines();
    assert.match(lines.join("\n"), /tmux is required/);
    assert.ok(lines.some((line) => /brew install tmux|apt-get install|dnf install|pacman -S/.test(line)));
  });
});
