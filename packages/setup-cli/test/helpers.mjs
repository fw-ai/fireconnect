import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { USER_SETTINGS_RELATIVE_PATH } from "../lib/fireconnect-core.mjs";
import { OPENCODE_CONFIG_RELATIVE_PATH } from "../lib/opencode-core.mjs";
import { CODEX_CONFIG_RELATIVE_PATH } from "../lib/codex-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../bin/fireconnect.mjs");

export const FPK_KEY = "fpk_test_firepass_key_000000000000";
export const FW_CLAUDE_KEY = "fw_test_claude_key_00000000000000";
export const FW_OPENCODE_KEY = "fw_test_opencode_key_00000000000";
export const FW_CODEX_KEY = "fw_test_codex_key_00000000000000";
export const SK_ANT_KEY = "sk-ant-test-non-fireworks-token";

export const NO_ENV_KEY = { FIREWORKS_API_KEY: "" };
// Neutralize the macOS keychain in spawned CLI subprocesses so tests don't
// pick up a real Claude Code keychain entry on the dev machine.
const TEST_ENV_NEUTRALIZE_KEYCHAIN = { FIRECONNECT_TEST_CLAUDE_KEYCHAIN: "" };

export async function withoutEnvFireworksKey(fn) {
  const prev = process.env.FIREWORKS_API_KEY;
  delete process.env.FIREWORKS_API_KEY;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.FIREWORKS_API_KEY;
    } else {
      process.env.FIREWORKS_API_KEY = prev;
    }
  }
}

export const GLM_LATEST = "glm-latest";
export const GLM_FAST_LATEST = "glm-fast-latest";
export const KIMI_FAST_LATEST = "kimi-fast-latest";
export const K2P7_FAST = "kimi-k2p7-code-fast";
export const FIREPASS_ROUTER = "accounts/fireworks/routers/glm-latest";
export const FIREPASS_ROUTER_1M = `${FIREPASS_ROUTER}[1m]`;
// Default model for Fire Pass keys (and the opus slot for fw_ keys).
export const FIREPASS_DEFAULT_ROUTER = FIREPASS_ROUTER;
export const FIREPASS_DEFAULT_ROUTER_1M = `${FIREPASS_DEFAULT_ROUTER}[1m]`;
export const FIREWORKS_INFERENCE_URL = "https://api.fireworks.ai/inference";


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
        ...TEST_ENV_NEUTRALIZE_KEYCHAIN,
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
    model: `fireworks-ai/accounts/fireworks/routers/${GLM_LATEST}`,
  });
  return configPath;
}

export async function writeCodexConfig(home, { apiKey = FW_CODEX_KEY, envRef = false } = {}) {
  const configPath = path.join(home, CODEX_CONFIG_RELATIVE_PATH);
  const authLines = envRef
    ? ['env_key = "FIREWORKS_API_KEY"']
    : [`experimental_bearer_token = "${apiKey}"`];
  const toml = [
    'model_provider = "fireworks-ai"',
    `model = "accounts/fireworks/routers/${K2P7_FAST}"`,
    "",
    "[model_providers.fireworks-ai]",
    'name = "Fireworks"',
    'base_url = "https://api.fireworks.ai/inference/v1"',
    'wire_api = "responses"',
    ...authLines,
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, toml);
  return configPath;
}

export async function readClaudeSettings(home) {
  return JSON.parse(await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"));
}

export async function readOpencodeConfig(home) {
  return JSON.parse(await readFile(path.join(home, OPENCODE_CONFIG_RELATIVE_PATH), "utf8"));
}
