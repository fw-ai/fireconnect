import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";

import { shellQuote } from "../../../lib/cli/path.mjs";
import {
  PI_LIVE_TMUX_SESSION,
  configurePiLiveTmuxSession,
  isPiLiveSessionActive,
  piPaneCommand,
  printPiLiveStartupMessage,
  resolvePiBin,
  runPiLiveTmux,
  tmuxInstallHintLines,
} from "../../../lib/harnesses/pi/live-tmux.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-live-tmux-"));
  temps.push(home);
  return home;
}

// Tests run from a developer's tmux too, so the dedicated-session tests pin TMUX unset.
const outsideTmuxEnv = { ...process.env };
delete outsideTmuxEnv.TMUX;

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

describe("runPiLiveTmux", () => {
  it("creates a detached session when stdout is not a TTY", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();

    await runPiLiveTmux({
      env: outsideTmuxEnv,
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
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane" && args.some((part) => String(part).includes("bin/pi-live-usage.mjs"))));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane" && args.some((part) => String(part).includes(`fc-pi-live-${process.pid}.json`))));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args.includes("pane-border-status")));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args.includes("Pi")));
    assert.match(stdout.text(), /detached — no terminal for attach/);
    assert.match(stdout.text(), /exit Pi/);
  });

  it("shows the startup message and a 3-2-1 countdown before creating the split", async () => {
    const home = await tempHome();
    const stdout = mockStdout();
    stdout.isTTY = true;
    const calls = [];
    const sleeps = [];
    let attached = false;

    await runPiLiveTmux({
      env: outsideTmuxEnv,
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
    assert.match(text, /Opening a live split for Pi/);
    assert.match(text, /starting pi session with live cost tracker/);
    assert.ok(/3[\s\S]*2[\s\S]*1[\s\S]*starting pi session/.test(text), "3-2-1 precedes start");
    assert.deepEqual(sleeps, [1000, 1000, 1000], "counts down three seconds");
    assert.ok(attached, "still attaches after the countdown");
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "new-session"),
      "creates the session after the countdown");
  });

  // list-panes yields "#{pane_at_left} #{pane_pid}"; ps yields "pid ppid comm".
  // The left pane's shell (pid 100) has a pi child (200) when active.
  const activeExec = (cmd, args) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return "1 100\n0 101\n";
    }
    if (cmd === "ps") {
      return "100 1 bash\n200 100 pi\n101 1 node\n";
    }
    throw new Error(`unexpected execFile: ${cmd} ${args.join(" ")}`);
  };

  it("re-attaches when the session already exists and is active", async () => {
    const stdout = mockStdout();
    stdout.isTTY = true;
    let attached = false;
    await runPiLiveTmux({
      env: outsideTmuxEnv,
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
    await runPiLiveTmux({
      env: outsideTmuxEnv,
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
    assert.match(stdout.text(), /tmux attach -t fireconnect-pi-live/);
  });

  it("recreates a stale session instead of re-attaching", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();

    await runPiLiveTmux({
      env: outsideTmuxEnv,
      home,
      stdout,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          return;
        }
        if (cmd === "tmux" && args[0] === "list-panes") {
          return "1 100\n0 101\n";
        }
        if (cmd === "ps") {
          // Left pane's shell (100) has no pi/node child — the session is stale.
          return "100 1 bash\n101 1 zsh\n";
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
    const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const sessionPath = `${home}/.pi/agent/sessions/--repo--/2026-10-05T05-31-03-648Z_${uuid}.jsonl`;

    await runPiLiveTmux({
      env: outsideTmuxEnv,
      home,
      session: "aaaaaaaa",
      stdout,
      resolveSession: async () => sessionPath,
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    const piPane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes(`pi --session ${shellQuote(sessionPath)}`)));
    assert.ok(piPane, "left pane resumes the requested session by path");
    assert.ok(piPane[1].some((part) => String(part).includes(`--session ${shellQuote(sessionPath)}`)));

    const usagePane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes("FC_LIVE_SESSION")));
    assert.ok(usagePane, "right pane carries FC_LIVE_SESSION");
    assert.ok(usagePane[1].some((part) => String(part).includes(`FC_LIVE_SESSION=${sessionPath}`)),
      "right pane locks onto the requested session");
  });

  it("opens a window in the caller's tmux session instead of switching sessions", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();
    stdout.isTTY = true;
    let entered = false;

    await runPiLiveTmux({
      home,
      env: { ...outsideTmuxEnv, TMUX: "/tmp/tmux-501/default,1,0" },
      stdout,
      sleep: async () => {},
      enterSession: () => { entered = true; },
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "new-window") {
          return "@7\n";
        }
      },
    });

    const tmux = calls.filter(([cmd]) => cmd === "tmux").map(([, args]) => args);
    assert.equal(entered, false, "the caller's client stays on its session");
    for (const verb of ["has-session", "new-session", "switch-client", "attach", "kill-session"]) {
      assert.ok(!tmux.some((args) => args[0] === verb), `no ${verb}`);
    }
    assert.ok(tmux.some((args) => args[0] === "split-window" && args.includes("@7")));
    assert.ok(tmux.some((args) => args[0] === "respawn-pane" && args.includes("@7.{left}")
      && args.some((part) => String(part).includes("tmux kill-window -t @7"))), "exiting pi closes only its window");
    assert.ok(tmux.some((args) => args[0] === "respawn-pane" && args.includes("@7.{right}")
      && args.some((part) => String(part).includes(`FC_LIVE_WINDOW=${shellQuote("@7")}`))), "q in the meter closes only its window");
    assert.ok(!tmux.some((args) => args.includes("mouse") || args.includes("focus-events")),
      "leaves the caller's session and server options alone");
  });

  it("closes only its own window when setup fails inside tmux", async () => {
    const home = await tempHome();
    const calls = [];
    await assert.rejects(
      () => runPiLiveTmux({
        home,
        env: { ...outsideTmuxEnv, TMUX: "/tmp/tmux-501/default,1,0" },
        stdout: mockStdout(),
        spawn: () => ({ status: 0, encoding: "utf8" }),
        execFile: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === "tmux" && args[0] === "new-window") {
            return "@7\n";
          }
          if (cmd === "tmux" && args[0] === "split-window") {
            throw new Error("split failed");
          }
        },
      }),
      /split failed/,
    );
    const kills = calls.filter(([cmd, args]) => cmd === "tmux" && args[0].startsWith("kill-"));
    assert.deepEqual(kills.map(([, args]) => args), [["kill-window", "-t", "@7"]]);
  });

  it("fails fast when --session matches no session log", async () => {
    const home = await tempHome();
    await assert.rejects(
      () => runPiLiveTmux({
        env: outsideTmuxEnv,
        home,
        session: "does-not-exist",
        stdout: mockStdout(),
        resolveSession: async () => undefined,
        spawn: () => ({ status: 0, encoding: "utf8" }),
        execFile: () => {},
      }),
      /No Pi session log matching 'does-not-exist'/,
    );
  });

  it("pins a fresh live session to a generated id for both panes", async () => {
    const home = await tempHome();
    const calls = [];
    const stdout = mockStdout();
    const uuid = "generated-uuid-1234";

    await runPiLiveTmux({
      env: outsideTmuxEnv,
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

    const piPane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes(`--session-id ${uuid}`)));
    assert.ok(piPane, "left pane pins the generated session id");

    const usagePane = calls.find(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes(`FC_LIVE_SESSION=${uuid}`)));
    assert.ok(usagePane, "right pane locks onto the generated id");
  });

  it("launches the left pane with the resolved pi binary", async () => {
    const home = await tempHome();
    const calls = [];

    await runPiLiveTmux({
      env: outsideTmuxEnv,
      home,
      stdout: mockStdout(),
      newSessionId: () => "uuid-1",
      resolvePi: () => "/resolved/bin/pi",
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).includes("/resolved/bin/pi --session-id uuid-1"))),
      "left pane uses the resolved pi binary, not a login-shell PATH lookup");
  });

  it("cds the left pane to the project directory before launching pi", async () => {
    const home = await tempHome();
    const calls = [];

    await runPiLiveTmux({
      env: outsideTmuxEnv,
      home,
      cwd: "/tmp/My Project",
      stdout: mockStdout(),
      newSessionId: () => "uuid-1",
      spawn: () => ({ status: 0, encoding: "utf8" }),
      execFile: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "tmux" && args[0] === "has-session") {
          throw new Error("no session");
        }
      },
    });

    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args[0] === "respawn-pane"
      && args.some((part) => String(part).startsWith(`export TERM=xterm-256color; cd ${shellQuote("/tmp/My Project")};`))),
      "the pane cds to the project dir so pi groups the session by cwd");
  });

  it("requires tmux and prints an install hint", async () => {
    const home = await tempHome();
    await assert.rejects(
      () => runPiLiveTmux({
        env: outsideTmuxEnv,
        home,
        stdout: mockStdout(),
        spawn: () => ({ status: 1 }),
        execFile: () => {},
      }),
      (error) => {
        assert.match(error.message, /tmux is required/);
        assert.ok(tmuxInstallHintLines().length >= 2);
        return true;
      },
    );
  });

  it("requires a home", async () => {
    await assert.rejects(
      () => runPiLiveTmux({ home: "", spawn: () => ({ status: 0 }) }),
      /HOME is required/,
    );
  });
});

describe("pi live tmux helpers", () => {
  it("detects an active live session from the left pane process tree", () => {
    // Left pane shell (100) running pi (200) as a child -> active.
    const active = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "1 100\n0 101\n";
      }
      if (cmd === "ps") {
        return "100 1 bash\n200 100 pi\n101 1 node\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { execFile: active }), true);

    // Left pane shell alive but no pi child -> stale.
    const stale = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "1 100\n0 101\n";
      }
      if (cmd === "ps") {
        return "100 1 bash\n101 1 zsh\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { execFile: stale }), false);

    // Pi nested a level down (bash -> sh -> node) still counts.
    const nested = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "1 100\n0 101\n";
      }
      if (cmd === "ps") {
        return "100 1 bash\n200 100 sh\n201 200 node\n101 1 bash\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { execFile: nested }), true);

    // A comm base that merely contains "pi" (pip, pinentry) must not count.
    const pip = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "1 100\n0 101\n";
      }
      if (cmd === "ps") {
        return "100 1 bash\n200 100 pip\n101 1 zsh\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { execFile: pip }), false);

    // Fewer than two panes -> stale.
    const onePane = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "0 101\n";
      }
      throw new Error("unexpected");
    };
    assert.equal(isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { execFile: onePane }), false);
  });

  it("treats a failed probe as active rather than tearing down a live session", () => {
    const psThrows = (cmd, args) => {
      if (args[0] === "list-panes") {
        return "1 100\n0 101\n";
      }
      if (cmd === "ps") {
        throw new Error("ps unavailable");
      }
      throw new Error("unexpected");
    };
    assert.equal(isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { execFile: psThrows }), true);

    const listThrows = () => {
      throw new Error("tmux unavailable");
    };
    assert.equal(isPiLiveSessionActive(PI_LIVE_TMUX_SESSION, { execFile: listThrows }), true);
  });

  it("wraps pi with trap-based session teardown", () => {
    assert.match(piPaneCommand({}), /^trap 'tmux kill-session/);
    assert.match(piPaneCommand({}), /; pi; tmux kill-session/);
  });

  it("runs pi without exec so the teardown kill still fires on exit", () => {
    // `exec pi` replaces the shell, wiping the EXIT trap and skipping the
    // trailing kill — the cost-meter pane kept running after pi exited.
    assert.doesNotMatch(piPaneCommand({}), /exec /);
    assert.match(piPaneCommand({}), /trap 'tmux kill-session.*EXIT INT TERM; pi; tmux kill-session/);
  });

  it("cds to the project dir and pins the session id", () => {
    assert.match(piPaneCommand({ cwd: "/tmp/repo", sessionId: "abc-123" }), /cd \/tmp\/repo; trap/);
    const spacedCwd = piPaneCommand({ cwd: "/tmp/My Project", sessionId: "abc-123" });
    assert.ok(spacedCwd.includes(`cd ${shellQuote("/tmp/My Project")};`), "a spaced path is shell-quoted");
    assert.match(piPaneCommand({ sessionId: "abc-123" }), /pi --session-id abc-123/);
    assert.match(piPaneCommand({ sessionId: "/tmp/s.jsonl", resume: true }), /pi --session \/tmp\/s\.jsonl/);
    assert.doesNotMatch(piPaneCommand({}), /--session-id/);
  });

  it("falls back to a bare pi binary when PATH has none", () => {
    assert.equal(resolvePiBin({ PATH: "" }), "pi");
  });

  it("prints the pi startup message", () => {
    const stdout = mockStdout();
    printPiLiveStartupMessage(stdout);
    assert.match(stdout.text(), /Opening a live split for Pi/);
    assert.match(stdout.text(), /Exit Pi \(\/quit\) to close the layout/);
  });

  it("configures pane chrome with pi titles", () => {
    const calls = [];
    const execFile = (cmd, args) => {
      calls.push([cmd, args]);
    };
    configurePiLiveTmuxSession(execFile, {}, "target:", true);
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args.includes("Pi")));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args.includes("Live cost")));
    assert.ok(calls.some(([cmd, args]) => cmd === "tmux" && args.includes("mouse")));
    // A window in the caller's session leaves session/server options alone.
    const windowCalls = [];
    configurePiLiveTmuxSession((cmd, args) => {
      windowCalls.push([cmd, args]);
    }, {}, "@7", false);
    assert.ok(!windowCalls.some(([, args]) => args.includes("mouse") || args.includes("focus-events")));
  });
});
