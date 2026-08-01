import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { USER_SETTINGS_RELATIVE_PATH } from "../lib/harnesses/claude/core.mjs";
import { OPENCODE_CONFIG_RELATIVE_PATH } from "../lib/harnesses/opencode/core.mjs";
import { CODEX_CONFIG_RELATIVE_PATH } from "../lib/harnesses/codex/core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../bin/fireconnect.mjs");

process.env.FIRECONNECT_SECRET_STORE ??= "memory";
process.env.FIRECONNECT_TEST ??= "1";
process.env.FIRECONNECT_TEST_CLAUDE_KEYCHAIN ??= "";
// Tests pass a temp HOME and expect it to isolate Claude credentials. But
// claudeCredentialsPath() honors CLAUDE_CONFIG_DIR over home, so a dev
// machine running Claude Code under a custom config dir leaks real OAuth
// creds into the tests (e.g. "claude on --opus firerouter" succeeds when it should
// fail for lack of an Anthropic key). claudeCredentialsPath is the only
// reader of CLAUDE_CONFIG_DIR, so dropping it here is safe and makes the
// temp home authoritative.
delete process.env.CLAUDE_CONFIG_DIR;

// Attribution header value for the version under test. Read from package.json so
// a release bump can't strand these assertions on a stale literal.
export const FIRECONNECT_REFERER = `fireconnect/v${
  JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8")).version
}`;

export const FPK_KEY = "fpk_test_firepass_key_000000000000";
export const FW_CLAUDE_KEY = "fw_test_claude_key_00000000000000";
export const FW_OPENCODE_KEY = "fw_test_opencode_key_00000000000";
export const FW_CODEX_KEY = "fw_test_codex_key_00000000000000";
export const SK_ANT_KEY = "sk-ant-test-non-fireworks-token";

export const NO_ENV_KEY = { FIREWORKS_API_KEY: "" };
export const TEST_SECRET_STORE_ENV = {
  FIRECONNECT_SECRET_STORE: "memory",
  FIRECONNECT_TEST: "1",
  FIRECONNECT_TEST_CLAUDE_KEYCHAIN: "",
};

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
export const GLM_5P2_FAST = "glm-5p2-fast";
export const KIMI_FAST_LATEST = "kimi-fast-latest";
export const K2P7_FAST = "kimi-k2p7-code-fast";
export const FIREPASS_ROUTER = "accounts/fireworks/routers/kimi-fast-latest";
// Default model for Fire Pass keys.
export const FIREPASS_DEFAULT_ROUTER = FIREPASS_ROUTER;

export function mockServerlessModel(overrides = {}) {
  const name = overrides.name ?? "accounts/fireworks/models/glm-5p2";
  const short = name.split("/").at(-1);
  return {
    name,
    displayName: overrides.displayName ?? "GLM 5.2",
    contextLength: 1_048_576,
    supportsTools: true,
    supportsImageInput: false,
    kind: "HF_BASE_MODEL",
    serverlessModes: [
      {
        name: `accounts/fireworks/models/${short}/serverlessModes/default`,
        skuInfos: [
          { sku: "LLM input tokens (uncached)", amount: { units: "1", nanos: 400_000_000 } },
          { sku: "LLM input tokens (cached)", amount: { nanos: 140_000_000 } },
          { sku: "LLM output tokens", amount: { units: "4", nanos: 400_000_000 } },
        ],
      },
      {
        name: `accounts/fireworks/models/${short}/serverlessModes/fast`,
        usageIdentifier: `accounts/fireworks/routers/${short}-fast`,
        skuInfos: [
          { sku: "LLM input tokens (uncached)", amount: { units: "2", nanos: 100_000_000 } },
          { sku: "LLM input tokens (cached)", amount: { nanos: 210_000_000 } },
          { sku: "LLM output tokens", amount: { units: "6", nanos: 600_000_000 } },
        ],
      },
    ],
    ...overrides,
  };
}
export const FIREWORKS_INFERENCE_URL = "https://api.fireworks.ai/inference";

export const HAS_SQLITE = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;
export const HAS_NPM = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8" }).status === 0;
export const itIfSqlite = HAS_SQLITE ? it : it.skip;
export const itIfNpm = HAS_NPM ? it : it.skip;

/** Expected OpenCode provider.models entry for a latest router alias. */
export function expectedOpencodeLatestRouterEntry(label, context = 1_048_575, output = 131_072) {
  return {
    name: label,
    limit: { context, output },
  };
}


export function claudePaths(home) {
  return {
    settingsPath: path.join(home, USER_SETTINGS_RELATIVE_PATH),
    dataDir: path.join(home, ".fireconnect/claude"),
  };
}

/** Assert Claude Code main default lives in top-level `model`, not env. */
export function assertClaudeMainModel(settings, expected, message = "") {
  const prefix = message ? `${message}: ` : "";
  assert.equal(settings.model, expected, `${prefix}top-level model`);
  assert.equal(settings.env?.ANTHROPIC_MODEL, undefined, `${prefix}ANTHROPIC_MODEL should be unset`);
}

export async function withTempHome(prefix, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), `fireconnect-${prefix}-`));
  try {
    return await fn(home);
  } finally {
    await removeTempDir(home);
  }
}

/**
 * Remove a temp dir, tolerating a transient ENOTEMPTY/EBUSY from a just-exited
 * subprocess still flushing files. Cleanup must never fail a test whose
 * assertions already passed — the OS reaps leftover temp dirs regardless.
 * @param {string} dir
 */
async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ...TEST_SECRET_STORE_ENV,
        ...env,
        FIRECONNECT_SECRET_STORE: "memory",
        FIRECONNECT_TEST: "1",
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

export async function seedKeychainConfig(home, apiKey) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // The in-memory secret store keeps module-global backend state; reset it so
    // this seed initializes for THIS home (otherwise a prior seed's home stays
    // pinned in-process and this key lands in the wrong sandbox's store).
    const { resetSecretStoreForTests } = await import("../lib/keys/secret-store.mjs");
    resetSecretStoreForTests();
    const { persistApiKeyToKeychain } = await import("../lib/keys/api-key.mjs");
    await persistApiKeyToKeychain(home, apiKey);
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  }
}

export async function runCli(args, { home, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ...TEST_SECRET_STORE_ENV,
        ...env,
        HOME: home,
        FIRECONNECT_SECRET_STORE: "memory",
        FIRECONNECT_TEST: "1",
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
