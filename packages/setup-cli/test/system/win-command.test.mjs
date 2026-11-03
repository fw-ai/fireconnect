import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserOpenCommand, npmCommand, safeCommand, spawnSyncCommand } from "../../lib/system/win-command.mjs";

const env = { SystemRoot: "C:\\Windows", PATH: ".;bin;C:\\Tools;C:\\Git\\cmd", PATHEXT: ".COM;.EXE" };

describe("safeCommand", () => {
  it("leaves names alone off Windows", () => {
    assert.equal(safeCommand("sqlite3", { platform: "linux", env }), "sqlite3");
    assert.equal(safeCommand("git", { platform: "darwin", env }), "git");
  });

  it("resolves system tools to absolute System32 paths", () => {
    const opts = { platform: "win32", env, isFile: () => true };
    assert.equal(safeCommand("cmd", opts), "C:\\Windows\\System32\\cmd.exe");
    assert.equal(safeCommand("tasklist", opts), "C:\\Windows\\System32\\tasklist.exe");
    assert.equal(safeCommand("clip", opts), "C:\\Windows\\System32\\clip.exe");
    assert.equal(safeCommand("powershell", opts), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("looks other tools up on absolute PATH entries only, never the current directory", () => {
    const seen = [];
    const isFile = (p) => { seen.push(p); return p === "C:\\Git\\cmd\\git.exe" || p === "sqlite3.exe" || p === "bin\\sqlite3.exe"; };
    assert.equal(safeCommand("git", { platform: "win32", env, isFile }), "C:\\Git\\cmd\\git.exe");
    assert.equal(safeCommand("sqlite3", { platform: "win32", env, isFile }), "");
    assert.ok(seen.every((p) => /^C:\\/.test(p)), "relative PATH entries are never probed");
  });
});

describe("safeCommand PATH entries", () => {
  it("finds tools on quoted or %VAR% PATH entries, as Windows itself does", () => {
    const quoted = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: '"C:\\Program Files\\Git\\cmd";%ProgramFiles%\\SQLite', PATHEXT: ".EXE" };
    const isFile = (p) => p === "C:\\Program Files\\Git\\cmd\\git.exe" || p === "C:\\Program Files\\SQLite\\sqlite3.exe";
    assert.equal(safeCommand("git", { platform: "win32", env: quoted, isFile }), "C:\\Program Files\\Git\\cmd\\git.exe");
    assert.equal(safeCommand("sqlite3", { platform: "win32", env: quoted, isFile }), "C:\\Program Files\\SQLite\\sqlite3.exe");
  });
});

describe("safeCommand root-relative entries", () => {
  it("skips a PATH entry that resolves on the current drive", () => {
    const rooted = { SystemRoot: "C:\\Windows", PATH: "\\tools;/tools;C:\\Git\\cmd;\\\\server\\share\\bin", PATHEXT: ".EXE" };
    const seen = [];
    const isFile = (p) => { seen.push(p); return false; };
    assert.equal(safeCommand("git", { platform: "win32", env: rooted, isFile }), "");
    assert.deepEqual(seen.filter((p) => p.endsWith(".exe")), ["C:\\Git\\cmd\\git.exe", "\\\\server\\share\\bin\\git.exe"]);
  });
});

describe("spawnSyncCommand", () => {
  it("runs from the filesystem root unless the caller names a cwd", { skip: process.platform === "win32" }, () => {
    assert.equal(spawnSyncCommand("pwd", [], { encoding: "utf8" }).stdout.trim(), "/");
  });
});

describe("safeCommand executables", () => {
  it("skips a .cmd/.bat wrapper earlier on PATH for the real .exe", () => {
    const wrapped = { SystemRoot: "C:\\Windows", PATH: "C:\\Wrappers;C:\\Git\\cmd", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const files = new Set(["C:\\Wrappers\\git.cmd", "C:\\Wrappers\\git.bat", "C:\\Git\\cmd\\git.exe"]);
    assert.equal(safeCommand("git", { platform: "win32", env: wrapped, isFile: (p) => files.has(p) }), "C:\\Git\\cmd\\git.exe");
  });
});

describe("browserOpenCommand", () => {
  it("uses the platform opener, and no shell on Windows", () => {
    const url = "https://example.test/?a=1&b=2";
    assert.deepEqual(browserOpenCommand(url, { platform: "darwin" }), ["open", [url]]);
    assert.deepEqual(browserOpenCommand(url, { platform: "linux" }), ["xdg-open", [url]]);
    assert.deepEqual(browserOpenCommand(url, { platform: "win32", env }),
      ["C:\\Windows\\System32\\rundll32.exe", ["url.dll,FileProtocolHandler", url]]);
  });
});

describe("npmCommand", () => {
  it("never hands npm.cmd to a shell-less spawn on Windows", () => {
    const args = ["install", "--omit=dev"];
    assert.deepEqual(npmCommand(args, { platform: "linux" }), ["npm", args, {}]);
    const execPath = "C:\\Program Files\\nodejs\\node.exe";
    assert.deepEqual(
      npmCommand(args, { platform: "win32", execPath, exists: () => true }),
      [execPath, ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", ...args], {}],
    );
  });

  it("prefers npm-cli.js beside the PATH npm command", () => {
    const args = ["install", "--ignore-scripts"];
    const execPath = "C:\\Program Files\\Node\\node.exe";
    const npmPath = "C:\\Program Files\\nodejs\\npm.cmd";
    const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const seen = [];
    const result = npmCommand(args, {
      platform: "win32",
      execPath,
      env: { SystemRoot: "C:\\Windows", PATH: "C:\\Program Files\\nodejs" },
      exists: (candidate) => {
        seen.push(candidate);
        return candidate === npmPath || candidate === npmCli;
      },
    });

    assert.deepEqual(seen, [
      "C:\\Program Files\\Node\\node_modules\\npm\\bin\\npm-cli.js",
      npmPath,
      npmCli,
    ]);
    assert.deepEqual(result, [execPath, [npmCli, ...args], {}]);
  });

  it("skips relative PATH entries and invokes the first absolute npm.cmd", () => {
    const execPath = "C:\\Program Files\\Node\\node.exe";
    const npmPath = "C:\\Program Files\\nodejs\\npm.cmd";
    const seen = [];
    const result = npmCommand(["install", "--ignore-scripts"], {
      platform: "win32",
      execPath,
      env: { SystemRoot: "C:\\Windows", pAtH: ".;relative;C:\\Program Files\\nodejs" },
      exists: (candidate) => {
        seen.push(candidate);
        return candidate === npmPath;
      },
    });

    assert.deepEqual(seen, [
      "C:\\Program Files\\Node\\node_modules\\npm\\bin\\npm-cli.js",
      npmPath,
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    ]);
    assert.equal(result[0], "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(result[1].slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(result[1][3], `""${npmPath}" install --ignore-scripts"`);
    assert.deepEqual(result[2], { windowsVerbatimArguments: true });
  });

  it("respects PATH order before preferring npm.cmd over npm.exe", () => {
    const execPath = "C:\\Program Files\\Node\\node.exe";
    const npmPath = "C:\\Tools\\npm.exe";
    const args = ["install", "--ignore-scripts"];
    const result = npmCommand(args, {
      platform: "win32",
      execPath,
      env: { SystemRoot: "C:\\Windows", PATH: "C:\\Tools;C:\\Node" },
      exists: (candidate) => candidate === npmPath || candidate === "C:\\Node\\npm.cmd",
    });

    assert.equal(result[0], "C:\\Windows\\System32\\cmd.exe");
    assert.equal(result[1][3], `""${npmPath}" install --ignore-scripts"`);
    assert.deepEqual(result[2], { windowsVerbatimArguments: true });
  });

  it("throws when no absolute npm executable is on PATH", () => {
    assert.throws(
      () => npmCommand(["install"], {
        platform: "win32",
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        env: { SystemRoot: "C:\\Windows", Path: ".;relative" },
        exists: () => false,
      }),
      { message: "npm not found on PATH" },
    );
  });
});
