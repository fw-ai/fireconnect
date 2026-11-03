/**
 * Resolve helper executables without the Windows search order. A bare name
 * handed to spawn on Windows is looked up in the current directory before
 * PATH, so a same-named binary in whatever folder nexus runs from would win.
 * System tools resolve to their absolute System32 path; other tools (sqlite3,
 * git) are looked up on PATH only. Off Windows, names pass through unchanged.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SYSTEM32_TOOLS = {
  cmd: "cmd.exe",
  tasklist: "tasklist.exe",
  clip: "clip.exe",
  rundll32: "rundll32.exe",
  powershell: path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
};

/** `%SystemRoot%\System32`, defaulting to the standard location. */
export function windowsSystem32({ env = process.env } = {}) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32");
}

function envValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function windowsPathEntries(env) {
  return String(envValue(env, "PATH") ?? "").split(";")
    .map((dir) => dir.trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/%([^%]+)%/g, (match, name) => envValue(env, name) ?? match))
    .filter(Boolean);
}

function isAbsoluteWindowsPath(dir) {
  return /^(?:[a-z]:\\|\\\\)/i.test(dir.replace(/\//g, "\\"));
}

/**
 * The command to spawn for `name`: on Windows an absolute path, or "" when a
 * non-system tool is not on PATH (callers treat that as "not installed").
 * @param {string} name
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, isFile?: (p: string) => boolean }} [options]
 */
export function safeCommand(name, { platform = process.platform, env = process.env, isFile = fileExists } = {}) {
  if (platform !== "win32") return name;
  if (Object.hasOwn(SYSTEM32_TOOLS, name)) {
    return path.win32.join(windowsSystem32({ env }), SYSTEM32_TOOLS[name]);
  }
  const dirs = windowsPathEntries(env);
  // Executables only, not PATHEXT: none of the callers use a shell, and Node
  // refuses to spawn a .bat/.cmd without one, so a wrapper earlier on PATH
  // must not shadow the real binary.
  const exts = [".exe", ".com"];
  for (const dir of dirs) {
    // A relative PATH entry is the same hazard as the current directory, and
    // so is a root-relative one (`\tools`): it resolves on whatever drive
    // nexus runs from. Only a drive-letter or UNC path is fixed.
    if (!isAbsoluteWindowsPath(dir)) continue;
    for (const ext of exts) {
      const candidate = path.win32.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * spawnSync through safeCommand. A tool that cannot be resolved comes back
 * as a spawn ENOENT result, the same shape as a missing binary. Runs from
 * the filesystem root unless the caller names a `cwd`: off Windows the name
 * is looked up on PATH as-is, and a `.` or empty PATH entry would otherwise
 * pick up a same-named binary from the directory nexus runs in.
 * @param {string} name
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
export function spawnSyncCommand(name, args, options) {
  const command = safeCommand(name);
  if (!command) {
    const error = Object.assign(new Error(`spawnSync ${name} ENOENT`), { code: "ENOENT" });
    return { error, status: null, signal: null, stdout: "", stderr: "", output: [] };
  }
  return spawnSync(command, args, { cwd: "/", ...options });
}

function fileExists(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * `[command, args]` that opens `url` in the default browser. On Windows this
 * goes through the URL protocol handler directly, never through cmd.exe,
 * whose parser would treat `&`, `|` and friends in the URL as syntax.
 * @param {string} url
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function browserOpenCommand(url, { platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") {
    return [safeCommand("rundll32", { platform, env }), ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}

/**
 * How to run npm without a shell. On Windows npm is `npm.cmd`, which Node
 * cannot spawn without one, so run the npm-cli.js bundled next to node with
 * node itself, or fall back to an absolute cmd.exe running npm.
 * @param {string[]} args
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, execPath?: string, exists?: (p: string) => boolean }} [options]
 * @returns {[string, string[], { windowsVerbatimArguments?: boolean }]}
 */
export function npmCommand(args, {
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  if (platform !== "win32") return ["npm", args, {}];
  const npmCli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(npmCli)) return [execPath, [npmCli, ...args], {}];

  const dirs = windowsPathEntries(env).filter(isAbsoluteWindowsPath);
  let npmPath = "";
  for (const dir of dirs) {
    for (const ext of [".cmd", ".exe"]) {
      const candidate = path.win32.join(dir, `npm${ext}`);
      if (exists(candidate)) {
        npmPath = candidate;
        break;
      }
    }
    if (npmPath) break;
  }
  if (!npmPath) {
    throw new Error("npm not found on PATH");
  }

  const pathNpmCli = path.win32.join(path.win32.dirname(npmPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(pathNpmCli)) return [execPath, [pathNpmCli, ...args], {}];

  const command = [`"${npmPath}"`, ...args.map((arg) => {
    const value = String(arg);
    return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
  })].join(" ");
  // /s strips the outer quotes, leaving the quoted absolute npm path and its args.
  return [
    safeCommand("cmd", { platform, env }),
    ["/d", "/s", "/c", `"${command}"`],
    { windowsVerbatimArguments: true },
  ];
}
