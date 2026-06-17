import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { USER_SETTINGS_RELATIVE_PATH } from "../lib/fireconnect-core.mjs";
import { OPENCODE_CONFIG_RELATIVE_PATH } from "../lib/opencode-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../bin/fireconnect.mjs");

export const FPK_KEY = "fpk_test_firepass_key_000000000000";
export const FW_CLAUDE_KEY = "fw_test_claude_key_00000000000000";
export const FW_OPENCODE_KEY = "fw_test_opencode_key_00000000000";
export const SK_ANT_KEY = "sk-ant-test-non-fireworks-token";

export const K2P7_FAST = "kimi-k2p7-code-fast";
export const FIREPASS_ROUTER = "accounts/fireworks/routers/kimi-k2p7-code-fast";
export const FIREWORKS_INFERENCE_URL = "https://api.fireworks.ai/inference";

/** Clear FIREWORKS_API_KEY in the child process (overrides the parent shell). */
export const NO_ENV_KEY = { FIREWORKS_API_KEY: "" };

export function claudePaths(home) {
  return {
    settingsPath: path.join(home, USER_SETTINGS_RELATIVE_PATH),
    dataDir: path.join(home, ".fireconnect/claude"),
  };
}

export async function withTempHome(prefix, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), `fireconnect-${prefix}-`));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function runCli(args, { home, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ...env,
        HOME: home,
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runCliJson(args, options) {
  const result = await runCli(args, options);
  return {
    ...result,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

export async function writeClaudeSettings(home, apiKey, { fireworks = true } = {}) {
  const settingsPath = path.join(home, USER_SETTINGS_RELATIVE_PATH);
  const env = fireworks
    ? { ANTHROPIC_BASE_URL: FIREWORKS_INFERENCE_URL, ANTHROPIC_API_KEY: apiKey }
    : { ANTHROPIC_API_KEY: apiKey };
  await writeJson(settingsPath, { env });
  return settingsPath;
}

export async function writeNativeAnthropicSettings(home) {
  return writeClaudeSettings(home, SK_ANT_KEY, { fireworks: false });
}

export async function writeOpencodeConfig(home, apiKey) {
  const configPath = path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
  await writeJson(configPath, {
    provider: {
      "fireworks-ai": { options: { apiKey } },
    },
    model: `fireworks-ai/accounts/fireworks/routers/${K2P7_FAST}`,
  });
  return configPath;
}

export async function readClaudeSettings(home) {
  return JSON.parse(await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"));
}

export async function readOpencodeConfig(home) {
  return JSON.parse(await readFile(path.join(home, OPENCODE_CONFIG_RELATIVE_PATH), "utf8"));
}
