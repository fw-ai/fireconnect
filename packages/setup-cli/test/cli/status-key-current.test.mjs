import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { claudeDesktopDataDir } from "../../lib/harnesses/claude-desktop/core.mjs";
import { thirdPartyDir } from "../../lib/harnesses/claude-desktop/lineup.mjs";
import { copilotDataDbPath } from "../../lib/harnesses/copilot-app/sqlite.mjs";
import { cursorPathsFor } from "../../lib/harness/context.mjs";
import { ensureCursorTable } from "../../lib/harnesses/cursor/sqlite.mjs";
import {
  chatLanguageModelsPath,
  fireconnectSecretIds,
  vscodeStateDbPath,
} from "../../lib/harnesses/vscode/core.mjs";
import { writeItemTableValue } from "../../lib/harnesses/vscode/vscdb-sqlite.mjs";
import { harnessKeyCurrent, LIVE_KEY } from "../../lib/keys/key-current.mjs";
import { resetSecretStoreForTests, setSecret } from "../../lib/keys/secret-store.mjs";
import {
  FIREWORKS_INFERENCE_URL,
  HAS_SQLITE,
  runCli,
  runCliJson,
  withTempHome,
  writeCodexConfig,
} from "../helpers.mjs";

const KEY = "fw_key_current_stored_000000000000000";
const OTHER_KEY = "fw_key_current_other_0000000000000000";
/** A macOS/Linux-keyring `safeStorage` blob: `v11` prefix + opaque bytes. */
const CIPHERTEXT = JSON.stringify({ type: "Buffer", data: [118, 49, 49, ...Array.from({ length: 16 }, (_, i) => i)] });

const itIfPosixSqlite = HAS_SQLITE && process.platform !== "win32" ? it : it.skip;

/**
 * A temp HOME that every harness's data dir follows on every platform (Cursor
 * and VS Code move under XDG_CONFIG_HOME / APPDATA when those are set), for
 * this process and the CLI children alike.
 */
function withHome(prefix, fn) {
  return withTempHome(prefix, async (home) => {
    const overrides = {
      XDG_CONFIG_HOME: path.join(home, ".config"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      COPILOT_HOME: "",
      DSH_HOME: "",
    };
    const prev = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
    Object.assign(process.env, overrides);
    try {
      return await fn(home, { ...overrides, NEXUS_VSCODE_SECRET_PLAINTEXT: "1" });
    } finally {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}

/** `perHarness[id].keyCurrent` from `nexus status --json`, with `extraEnv` on top. */
async function keyCurrentOf(home, env, id, extraEnv = {}) {
  const result = await runCliJson(["status", "--json"], { home, env: { ...env, ...extraEnv } });
  assert.ok(result.json, result.stderr);
  const entry = result.json.perHarness.find((h) => h.id === id);
  assert.ok(entry, `${id} missing from perHarness`);
  assert.ok(Object.hasOwn(entry, "keyCurrent"), `${id} has no keyCurrent`);
  return { keyCurrent: entry.keyCurrent, stdout: result.stdout };
}

/**
 * Replace the stored key the way an account switch would, minus the login
 * sync that re-bakes most tools: what's left over is a tool still holding
 * the old key.
 */
async function replaceStoredKey(home, key) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    resetSecretStoreForTests();
    await setSecret(key, home);
  } finally {
    process.env.HOME = prevHome;
    resetSecretStoreForTests();
  }
}

async function writeClaudeHelperSettings(home, apiKeyHelper) {
  const settingsPath = path.join(home, ".claude", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: FIREWORKS_INFERENCE_URL }, apiKeyHelper }));
}

async function run(args, home, env) {
  const result = await runCli(args, { home, env });
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
}

async function writeCopilotDb(dbPath) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const sql = [
    `CREATE TABLE IF NOT EXISTS "model_providers" (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'openai',
      settings_json TEXT NOT NULL DEFAULT '{}', account_id TEXT);`,
    `CREATE TABLE IF NOT EXISTS "provider_models" (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES "model_providers"(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL, wire_model TEXT, display_name TEXT NOT NULL,
      max_prompt_tokens INTEGER, max_output_tokens INTEGER, wire_api_override TEXT,
      supported_reasoning_efforts TEXT, UNIQUE (provider_id, model_id));`,
  ].join("\n");
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/**
 * Each tool `on` bakes the stored key as a literal: keyCurrent is true for the
 * stored key, false once the stored key differs from the baked copy, and
 * null after `off`.
 */
const LITERAL_TOOLS = [
  { id: "claude", on: ["claude", "on"], off: ["claude", "off"] },
  { id: "codex", on: ["codex", "on"], off: ["codex", "off"] },
  { id: "opencode", on: ["opencode", "on"], off: ["opencode", "off"] },
  { id: "pi", on: ["pi", "on"], off: ["pi", "off"] },
  { id: "deepseek", on: ["deepseek", "on"], off: ["deepseek", "off"] },
  { id: "copilot-cli", on: ["copilot-cli", "on"], off: ["copilot-cli", "off"] },
  {
    id: "copilot-app",
    sqlite: true,
    setup: (home) => writeCopilotDb(copilotDataDbPath({ home })),
    on: ["copilot-app", "on", "--force"],
    off: ["copilot-app", "off", "--force"],
  },
  {
    id: "cursor",
    sqlite: true,
    setup: async (home) => {
      const { dbPath } = cursorPathsFor({ home });
      await mkdir(path.dirname(dbPath), { recursive: true });
      await ensureCursorTable(dbPath);
    },
    on: ["cursor", "on", "--force"],
    off: ["cursor", "off", "--force"],
  },
  { id: "vscode", sqlite: true, on: ["vscode", "on", "--force"], off: ["vscode", "off", "--force"] },
];

describe("nexus status --json perHarness[].keyCurrent", () => {
  for (const tool of LITERAL_TOOLS) {
    const test = tool.sqlite ? itIfPosixSqlite : it;
    test(`${tool.id}: true for the stored key, false for another, null when off`, async () => {
      await withHome(`key-current-${tool.id}-`, async (home, env) => {
        await tool.setup?.(home);
        await run(["login", "--api-key", KEY], home, env);
        await run(tool.on, home, env);

        const current = await keyCurrentOf(home, env, tool.id);
        assert.equal(current.keyCurrent, true);
        assert.doesNotMatch(current.stdout, new RegExp(KEY));

        // The stored key moved on but the tool kept the old one: the stale case.
        await replaceStoredKey(home, OTHER_KEY);
        const stale = await keyCurrentOf(home, env, tool.id);
        assert.equal(stale.keyCurrent, false);
        assert.doesNotMatch(stale.stdout, new RegExp(`${KEY}|${OTHER_KEY}`));

        await replaceStoredKey(home, KEY);
        await run(tool.off, home, env);
        assert.equal((await keyCurrentOf(home, env, tool.id)).keyCurrent, null);
      });
    });
  }

  it("codex reading FIREWORKS_API_KEY through an env reference is unknown", async () => {
    // Nexus no longer exports FIREWORKS_API_KEY, so the reference sends
    // whatever the shell has: maybe nothing, maybe another account's key.
    await withHome("key-current-codex-env-", async (home, env) => {
      await run(["login", "--api-key", KEY], home, env);
      await writeCodexConfig(home, { envRef: true });
      assert.equal((await keyCurrentOf(home, env, "codex", { FIREWORKS_API_KEY: KEY })).keyCurrent, null);
    });
  });

  it("claude with Nexus's own apiKeyHelper is current; a user's helper is unknown", async () => {
    await withHome("key-current-claude-helper-", async (home, env) => {
      await run(["login", "--api-key", KEY], home, env);
      await writeClaudeHelperSettings(home, "nexus key export");
      assert.equal((await keyCurrentOf(home, env, "claude")).keyCurrent, true);
      await writeClaudeHelperSettings(home, "/usr/local/bin/my-key-helper");
      assert.equal((await keyCurrentOf(home, env, "claude")).keyCurrent, null);
    });
  });

  itIfPosixSqlite("vscode is null when its key is only readable through the keychain", async () => {
    await withHome("key-current-vscode-keychain-", async (home, env) => {
      await run(["login", "--api-key", KEY], home, env);
      await run(["vscode", "on", "--force"], home, env);
      const vscodePath = chatLanguageModelsPath({ home });
      const secretId = fireconnectSecretIds(JSON.parse(await readFile(vscodePath, "utf8")))[0];
      await writeItemTableValue(vscodeStateDbPath({ vscodePath }), `secret://${secretId}`, CIPHERTEXT);
      // Real ciphertext and no plaintext seam: decrypting would ask the keychain.
      const { keyCurrent } = await keyCurrentOf(home, env, "vscode", { NEXUS_VSCODE_SECRET_PLAINTEXT: "" });
      assert.equal(keyCurrent, null);
    });
  });

  it("claude-desktop compares the applied profile's key", async () => {
    await withHome("key-current-desktop-", async (home, env) => {
      await run(["login", "--api-key", KEY], home, env);
      await writeGlobalConfig(home, { harnesses: { "claude-desktop": { enabled: true, provider: "fireworks" } } });
      const port = 8799;
      const profilePath = path.join(thirdPartyDir(home), "configLibrary", "profile-under-test.json");
      const writeProfile = async (apiKey) => {
        await mkdir(path.dirname(profilePath), { recursive: true });
        await writeFile(profilePath, JSON.stringify({
          inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
          inferenceGatewayApiKey: apiKey,
          inferenceProvider: "gateway",
          inferenceCredentialKind: "static",
        }));
      };
      const statePath = path.join(claudeDesktopDataDir(home), "profile-state.json");
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({ enabled: true, lane: "profile", port, profileId: "profile-under-test" }));

      await writeProfile(KEY);
      assert.equal((await keyCurrentOf(home, env, "claude-desktop")).keyCurrent, true);
      await writeProfile(OTHER_KEY);
      assert.equal((await keyCurrentOf(home, env, "claude-desktop")).keyCurrent, false);
      await writeFile(statePath, JSON.stringify({ enabled: false }));
      assert.equal((await keyCurrentOf(home, env, "claude-desktop")).keyCurrent, null);
    });
  });

  it("is null for every harness with no key anywhere", async () => {
    await withHome("key-current-no-key-", async (home, env) => {
      await writeCodexConfig(home, { apiKey: KEY });
      const result = await runCliJson(["status", "--json"], { home, env });
      for (const h of result.json.perHarness) {
        assert.equal(h.keyCurrent, null, h.id);
      }
      assert.equal(result.json.perHarness.find((h) => h.id === "codex").enabled, true);
    });
  });
});

describe("harnessKeyCurrent", () => {
  const adapter = (keyInUse) => ({ keyInUse: async () => keyInUse });

  it("is true for a matching copy or a live reader", async () => {
    assert.equal(await harnessKeyCurrent(adapter(KEY), {}, KEY), true);
    assert.equal(await harnessKeyCurrent(adapter(` ${KEY}\n`), {}, KEY), true);
    assert.equal(await harnessKeyCurrent(adapter(LIVE_KEY), {}, KEY), true);
  });

  it("is false for a different Fireworks key", async () => {
    assert.equal(await harnessKeyCurrent(adapter(OTHER_KEY), {}, KEY), false);
  });

  it("is null when off, unreadable, not a Fireworks key, keyless, or throwing", async () => {
    assert.equal(await harnessKeyCurrent(adapter(null), {}, KEY), null);
    assert.equal(await harnessKeyCurrent(adapter(""), {}, KEY), null);
    assert.equal(await harnessKeyCurrent(adapter("sk-ant-not-fireworks"), {}, KEY), null);
    assert.equal(await harnessKeyCurrent(adapter(LIVE_KEY), {}, ""), null);
    assert.equal(await harnessKeyCurrent({}, {}, KEY), null);
    assert.equal(await harnessKeyCurrent({ keyInUse: async () => { throw new Error("locked"); } }, {}, KEY), null);
  });
});
