import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { resetSecretStoreForTests } from "../lib/secret-store.mjs";
import { CURSOR_FIREWORKS_BASE_URL, cursorStateDbPath } from "../lib/cursor-core.mjs";
import { FIREWORKS_BASE_URL, USER_SETTINGS_RELATIVE_PATH, writeJson } from "../lib/fireconnect-core.mjs";
import {
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  globalConfigPath,
  writeGlobalConfig,
} from "../lib/global-config.mjs";
import { migrateLegacyCredentials } from "../lib/key-migrate.mjs";
import { OPENCODE_CONFIG_RELATIVE_PATH } from "../lib/opencode-core.mjs";
import { runFireconnect } from "./helpers.mjs";

const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

function sqliteAvailable() {
  const r = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

const HAS_SQLITE = sqliteAvailable();
const itIfSqlite = HAS_SQLITE ? it : it.skip;

function jsonLit(v) {
  return JSON.stringify(v).replace(/'/g, "''");
}

function writeCursorDb(dbPath, blob, opts = {}) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('${APPLICATION_USER_KEY}','${jsonLit(blob)}');`,
  ];
  if (opts.openAIKey != null) {
    const keyLit = String(opts.openAIKey).replace(/'/g, "''");
    sql.push(`INSERT OR REPLACE INTO ItemTable(key,value) VALUES('cursorAuth/openAIKey','${keyLit}');`);
  }
  const r = spawnSync("sqlite3", [dbPath, sql.join("\n")], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`sqlite3 init failed: ${r.stderr || r.error?.message}`);
  }
}

describe("legacy credential migration (migrateLegacyCredentials; runs on configure/upgrade)", () => {
  // Each test migrates a distinct sandbox home in-process; reset the module-global
  // secret-store backend so it re-initializes for this test's home.
  beforeEach(() => resetSecretStoreForTests());

  it("rewrites Claude Fireworks settings to apiKeyHelper", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-migrate-claude-"));
    const claudeKey = "fw_claude_migrate_key_123456";
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".fireconnect/claude"), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
      harnesses: { claude: { enabled: true } },
    });
    await writeJson(path.join(home, USER_SETTINGS_RELATIVE_PATH), {
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_API_KEY: claudeKey,
        ANTHROPIC_MODEL: "accounts/fireworks/routers/glm-latest",
      },
    });

    const changes = await migrateLegacyCredentials(home);
    assert.ok(changes.some((line) => /apiKeyHelper/.test(line)), changes.join("\n"));

    const settings = JSON.parse(
      await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"),
    );
    assert.ok(settings.apiKeyHelper);
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.stdout.trim(), claudeKey);
  });

  it("migrates legacy OpenCode provider.fireworks literal key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-migrate-oc-legacy-"));
    const ocKey = "fw_opencode_legacy_key_123456";
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
      harnesses: { opencode: { enabled: true } },
    });
    await writeJson(path.join(home, OPENCODE_CONFIG_RELATIVE_PATH), {
      model: "fireworks/glm-latest",
      provider: {
        fireworks: {
          options: { apiKey: ocKey },
          models: { "glm-latest": { name: "glm-latest" } },
        },
      },
    });

    const changes = await migrateLegacyCredentials(home);
    assert.ok(changes.some((line) => /OpenCode literal API key/.test(line)), changes.join("\n"));

    const config = JSON.parse(
      await readFile(path.join(home, OPENCODE_CONFIG_RELATIVE_PATH), "utf8"),
    );
    assert.equal(config.provider.fireworks, undefined);
    assert.equal(config.provider["fireworks-ai"].options.apiKey, "{env:FIREWORKS_API_KEY}");
    assert.equal(config.model, "fireworks-ai/glm-latest");
    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.stdout.trim(), ocKey);
  });

  it("does not install shell hook when only Claude is enabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-migrate-no-hook-"));
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
      harnesses: { claude: { enabled: true } },
    });

    const changes = await migrateLegacyCredentials(home);
    assert.equal(changes.some((line) => line.includes("shell env hook")), false);
  });

  itIfSqlite("lifts literal Fireworks key from Cursor state.vscdb into keychain", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-migrate-cursor-"));
    const cursorKey = "fw_cursor_migrate_key_123456";
    const dbPath = cursorStateDbPath({ home });
    await mkdir(path.dirname(dbPath), { recursive: true });
    writeCursorDb(
      dbPath,
      {
        openAIBaseUrl: CURSOR_FIREWORKS_BASE_URL,
        useOpenAIKey: true,
        aiSettings: { userAddedModels: [], modelOverrideEnabled: [], modelConfig: {} },
      },
      { openAIKey: cursorKey },
    );
    await writeGlobalConfig(home, {
      apiKey: "",
      harnesses: { cursor: { enabled: true } },
    });

    const changes = await migrateLegacyCredentials(home);
    assert.ok(changes.some((line) => /Cursor settings/.test(line)), changes.join("\n"));

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);

    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.code, 0, exportResult.stderr);
    assert.equal(exportResult.stdout.trim(), cursorKey);
  });

  it("lifts a legacy global config literal into the keychain", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-legacy-global-"));
    const legacyKey = "fw_configure_legacy_key_12345";
    await mkdir(path.join(home, ".fireconnect"), { recursive: true });
    await writeJson(globalConfigPath(home), {
      apiKey: legacyKey,
      harnesses: { pi: { enabled: false } },
    });

    await migrateLegacyCredentials(home);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);
    assert.doesNotMatch(await readFile(globalConfigPath(home), "utf8"), /fw_configure_legacy_key_12345/);

    const exportResult = await runFireconnect(["key", "export"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(exportResult.stdout.trim(), legacyKey);
  });
});
