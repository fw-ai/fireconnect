import { mkdtemp, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CURSOR_FIREWORKS_BASE_URL,
  CURSOR_DEFAULT_MODE,
  addUserModel,
  cursorCurrentModelId,
  cursorProviderStatus,
  existingModes,
  prettyModelName,
  removeFireconnectModels,
  resetFireconnectModelConfig,
  setAllExistingModes,
  setModeModel,
  setOpenAiBaseUrl,
  setUseOpenAiKey,
} from "../lib/cursor-core.mjs";
import { runCli, runCliJson, withTempHome } from "./helpers.mjs";

const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

/** Minimal Cursor-shaped blob for tests. */
function baseBlob(overrides = {}) {
  return {
    openAIBaseUrl: null,
    useOpenAIKey: false,
    aiSettings: {
      userAddedModels: [],
      modelOverrideEnabled: [],
      modelConfig: {
        composer: { modelName: "default", maxMode: true, selectedModels: [{ modelId: "default", parameters: [] }] },
      },
    },
    ...overrides,
  };
}

/**
 * Build a temp state.vscdb with the applicationUser row (and optional key).
 * @param {string} dbPath
 * @param {object} blob
 * @param {{ openAIKey?: string }} [opts]
 */
function writeCursorDb(dbPath, blob, opts = {}) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('${APPLICATION_USER_KEY}','${jsonLit(blob)}');`,
  ];
  if (opts.openAIKey != null) {
    // The OpenAI key cell is a raw text value (not JSON) — write it the same way
    // `setCursorOpenAiKey` does so `cursorProviderStatus` / `readKey` see the real value.
    const keyLit = String(opts.openAIKey).replace(/'/g, "''");
    sql.push(`INSERT OR REPLACE INTO ItemTable(key,value) VALUES('cursorAuth/openAIKey','${keyLit}');`);
  }
  const r = spawnSync("sqlite3", [dbPath, sql.join("\n")], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`sqlite3 init failed: ${r.stderr || r.error?.message}`);
  }
}

/** Escape a JS value into a SQL string-literal body for JSON text. */
function jsonLit(v) {
  return JSON.stringify(v).replace(/'/g, "''");
}

/** Read the applicationUser blob back from a temp DB. */
function readBlob(dbPath) {
  const r = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='${APPLICATION_USER_KEY}';`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`sqlite3 read failed: ${r.stderr || r.error?.message}`);
  }
  const raw = r.stdout.replace(/\n$/, "");
  return raw ? JSON.parse(raw) : null;
}

function readKey(dbPath) {
  const r = spawnSync("sqlite3", [dbPath, "SELECT value FROM ItemTable WHERE key='cursorAuth/openAIKey';"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "").replace(/\n$/, "");
}

/** Resolve the sqlite3 CLI binary (honour PATH; conda's sqlite3 is fine). */
function sqliteAvailable() {
  const r = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

const HAS_SQLITE = sqliteAvailable();
const itIfSqlite = HAS_SQLITE ? it : it.skip;

/* -------------------------------------------------------------------------- */
/* Unit tests — pure blob transforms (no I/O)                                  */
/* -------------------------------------------------------------------------- */

describe("cursor-core pure transforms", () => {
  it("addUserModel dedupes, enables, and tracks ownership", () => {
    let b = baseBlob({ aiSettings: { userAddedModels: ["mine"], modelConfig: {} } });
    b = addUserModel(b, "accounts/fireworks/routers/glm-5p2");
    b = addUserModel(b, "accounts/fireworks/routers/glm-5p2"); // dedupe
    assert.deepEqual(b.aiSettings.userAddedModels, ["mine", "accounts/fireworks/routers/glm-5p2"]);
    assert.deepEqual(b.aiSettings.modelOverrideEnabled, ["accounts/fireworks/routers/glm-5p2"]);
    assert.deepEqual(b.aiSettings.fireconnectAddedModels, ["accounts/fireworks/routers/glm-5p2"]);
  });

  it("removeFireconnectModels only removes fireconnect-registered models", () => {
    let b = baseBlob();
    b = addUserModel(b, "accounts/fireworks/routers/glm-5p2");
    b.aiSettings.userAddedModels.push("user-own-model");
    b.aiSettings.modelOverrideEnabled.push("user-own-model");
    b = removeFireconnectModels(b);
    assert.deepEqual(b.aiSettings.userAddedModels, ["user-own-model"]);
    assert.deepEqual(b.aiSettings.modelOverrideEnabled, ["user-own-model"]);
    assert.deepEqual(b.aiSettings.fireconnectAddedModels, []);
  });

  it("setModeModel writes modelName + selectedModels and preserves maxMode", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "accounts/fireworks/routers/glm-latest");
    assert.equal(b.aiSettings.modelConfig.composer.modelName, "accounts/fireworks/routers/glm-latest");
    assert.equal(b.aiSettings.modelConfig.composer.maxMode, true); // preserved
    assert.deepEqual(b.aiSettings.modelConfig.composer.selectedModels, [
      { modelId: "accounts/fireworks/routers/glm-latest", parameters: [] },
    ]);
    assert.deepEqual(b.aiSettings.fireconnectTouchedModes, ["composer"]);
  });

  it("resetFireconnectModelConfig resets only touched modes", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "glm-5p2");
    b.aiSettings.modelConfig["cmd-k"] = { modelName: "user-chosen", selectedModels: [] }; // user's own
    // Default target: Cursor's literal "default" (used by the `off` strip fallback).
    b = resetFireconnectModelConfig(b);
    assert.equal(b.aiSettings.modelConfig.composer.modelName, "default");
    assert.equal(b.aiSettings.modelConfig["cmd-k"].modelName, "user-chosen"); // untouched
    assert.deepEqual(b.aiSettings.fireconnectTouchedModes, []);
  });

  it("resetFireconnectModelConfig resets touched modes to a Fireworks model when given", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "glm-5p2");
    b = resetFireconnectModelConfig(b, "accounts/fireworks/routers/glm-latest");
    assert.equal(b.aiSettings.modelConfig.composer.modelName, "accounts/fireworks/routers/glm-latest");
    assert.deepEqual(
      b.aiSettings.modelConfig.composer.selectedModels,
      [{ modelId: "accounts/fireworks/routers/glm-latest", parameters: [] }],
    );
    assert.deepEqual(b.aiSettings.fireconnectTouchedModes, []);
  });

  it("setOpenAiBaseUrl / setUseOpenAiKey set fields", () => {
    let b = baseBlob();
    b = setOpenAiBaseUrl(b, CURSOR_FIREWORKS_BASE_URL);
    b = setUseOpenAiKey(b, true);
    assert.equal(b.openAIBaseUrl, CURSOR_FIREWORKS_BASE_URL);
    assert.equal(b.useOpenAIKey, true);
  });

  it("cursorProviderStatus reflects key type + useOpenAIKey", () => {
    const fw = baseBlob({ useOpenAIKey: true });
    assert.equal(cursorProviderStatus(fw, "fw_abc"), "fireworks");
    assert.equal(cursorProviderStatus(fw, "fpk_abc"), "firepass");
    assert.equal(cursorProviderStatus(baseBlob({ useOpenAIKey: false }), "fw_abc"), "none");
    assert.equal(cursorProviderStatus(fw, "sk-ant-abc"), "none");
  });

  it("cursorCurrentModelId reads the active model for a mode", () => {
    let b = baseBlob();
    b = setModeModel(b, "composer", "glm-5p2");
    assert.equal(cursorCurrentModelId(b, "composer"), "glm-5p2");
    assert.equal(cursorCurrentModelId(b, "cmd-k"), "");
  });

  it("prettyModelName renders human-readable names", () => {
    assert.equal(prettyModelName("accounts/fireworks/models/glm-5p2"), "GLM 5.2");
    assert.equal(prettyModelName("accounts/fireworks/routers/glm-latest"), "GLM Latest");
    assert.equal(prettyModelName("accounts/fireworks/routers/kimi-k2p7-code-fast"), "Kimi K2.7 Code Fast");
    assert.equal(prettyModelName("accounts/fireworks/models/deepseek-v4-flash"), "Deepseek V4 Flash");
    assert.equal(prettyModelName("composer-2.5"), "Composer 2.5");
    assert.equal(prettyModelName("default"), "default");
    assert.equal(prettyModelName(""), "(unset)");
  });

  it("setAllExistingModes sets every existing mode and creates no new ones", () => {
    const b = baseBlob({
      aiSettings: {
        userAddedModels: [],
        modelOverrideEnabled: [],
        modelConfig: {
          composer: { modelName: "default", maxMode: true },
          "cmd-k": { modelName: "default" },
        },
      },
    });
    assert.deepEqual(existingModes(b), ["composer", "cmd-k"]);
    const next = setAllExistingModes(b, "accounts/fireworks/routers/glm-latest");
    assert.equal(cursorCurrentModelId(next, "composer"), "accounts/fireworks/routers/glm-latest");
    assert.equal(cursorCurrentModelId(next, "cmd-k"), "accounts/fireworks/routers/glm-latest");
    // no new modes created
    assert.deepEqual(existingModes(next), ["composer", "cmd-k"]);
    assert.deepEqual(next.aiSettings.fireconnectTouchedModes, ["composer", "cmd-k"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Integration tests — CLI against a real temp state.vscdb                     */
/* -------------------------------------------------------------------------- */

describe("cursor harness integration", () => {
  itIfSqlite("on writes base url, key, registers default model, sets composer", async () => {
    await withTempHome("cursor-on-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, CURSOR_FIREWORKS_BASE_URL);
      assert.equal(blob.useOpenAIKey, true);
      assert.ok(blob.aiSettings.userAddedModels.includes("accounts/fireworks/routers/glm-latest"));
      assert.ok(blob.aiSettings.fireconnectAddedModels.includes("accounts/fireworks/routers/glm-latest"));
      assert.equal(cursorCurrentModelId(blob, CURSOR_DEFAULT_MODE), "accounts/fireworks/routers/glm-latest");
      assert.equal(readKey(dbPath), "fw_test_key_12345");
    });
  });

  itIfSqlite("on with Fire Pass key registers glm-latest router only", async () => {
    await withTempHome("cursor-fp-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        ["cursor", "on", "--api-key", "fpk_test_firepass_key", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      assert.deepEqual(blob.aiSettings.userAddedModels, ["accounts/fireworks/routers/glm-latest"]);
    });
  });

  itIfSqlite("on sets every existing mode to the default model", async () => {
    await withTempHome("cursor-allmodes-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.aiSettings.modelConfig["cmd-k"] = { modelName: "old", selectedModels: [] };
      blob.aiSettings.modelConfig["background-composer"] = { modelName: "composer-2.5", selectedModels: [] };
      writeCursorDb(dbPath, blob);

      const r = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const after = readBlob(dbPath);
      assert.equal(after.aiSettings.modelConfig.composer.modelName, "accounts/fireworks/routers/glm-latest");
      assert.equal(after.aiSettings.modelConfig["cmd-k"].modelName, "accounts/fireworks/routers/glm-latest");
      assert.equal(after.aiSettings.modelConfig["background-composer"].modelName, "accounts/fireworks/routers/glm-latest");
      // no new modes created beyond the three that existed
      assert.deepEqual(Object.keys(after.aiSettings.modelConfig).sort(), ["background-composer", "cmd-k", "composer"]);
    });
  });

  itIfSqlite("off round-trips: restores base url, useOpenAIKey, models, and clears key", async () => {
    await withTempHome("cursor-off-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      assert.equal(blob.openAIBaseUrl, null);
      assert.equal(blob.useOpenAIKey, false);
      assert.deepEqual(blob.aiSettings.userAddedModels, []);
      // Restore brings back the pre-`on` blob, which never had fireconnect's
      // tracker field — so it's absent (not an empty array).
      assert.equal(blob.aiSettings.fireconnectAddedModels, undefined);
      assert.equal(blob.aiSettings.modelConfig.composer.modelName, "default");
      assert.equal(readKey(dbPath), "");
    });
  });

  itIfSqlite("off preserves user-owned custom models", async () => {
    await withTempHome("cursor-preserve-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      const blob = baseBlob();
      blob.aiSettings.userAddedModels.push("user-own-model");
      blob.aiSettings.modelOverrideEnabled.push("user-own-model");
      writeCursorDb(dbPath, blob);

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });

      const after = readBlob(dbPath);
      assert.ok(after.aiSettings.userAddedModels.includes("user-own-model"));
    });
  });

  itIfSqlite("status --json reports provider, base url, and per-mode models", async () => {
    await withTempHome("cursor-status-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCliJson(["cursor", "status", "--db-path", dbPath, "--json"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.harness, "cursor");
      assert.equal(r.json.provider, "fireworks");
      assert.equal(r.json.baseUrl, CURSOR_FIREWORKS_BASE_URL);
      assert.equal(r.json.hasKey, true);
      assert.equal(r.json.defaultMode, "composer");
      assert.equal(r.json.modes.composer, "accounts/fireworks/routers/glm-latest");
    });
  });

  itIfSqlite("model reset resets fireconnect-managed selections to the Fireworks default", async () => {
    await withTempHome("cursor-reset-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCli(["cursor", "model", "reset", "--db-path", dbPath, "--force"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      // Fireworks routing stays on; the touched mode points at the Fireworks
      // default model, not Cursor's literal "default".
      assert.equal(blob.useOpenAIKey, true);
      assert.equal(
        blob.aiSettings.modelConfig.composer.modelName,
        "accounts/fireworks/routers/glm-latest",
      );
      assert.deepEqual(blob.aiSettings.fireconnectTouchedModes, []);
    });
  });

  itIfSqlite("model reset refuses when Fireworks is not enabled", async () => {
    await withTempHome("cursor-reset-off-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const r = await runCli(["cursor", "model", "reset", "--db-path", dbPath, "--force"], { home });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /requires Fireworks to be enabled/);
    });
  });

  itIfSqlite("on --main selects the requested model", async () => {
    await withTempHome("cursor-main-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      const r = await runCli(
        [
          "cursor", "on", "--api-key", "fw_test_key_12345",
          "--main", "deepseek-v4-flash",
          "--db-path", dbPath, "--force",
        ],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      assert.equal(
        blob.aiSettings.modelConfig.composer.modelName,
        "accounts/fireworks/models/deepseek-v4-flash",
      );
      assert.ok(blob.aiSettings.userAddedModels.includes("accounts/fireworks/models/deepseek-v4-flash"));
    });
  });

  itIfSqlite("off restores pre-on per-mode model + base url + key (snapshot/restore)", async () => {
    await withTempHome("cursor-restore-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      // Pre-on: a non-default composer model, a non-Fireworks base url, and a
      // prior (non-Fireworks) key. `off` must recover these, not reset to default.
      const blob = baseBlob();
      blob.aiSettings.modelConfig.composer = {
        modelName: "user-prior-model",
        maxMode: true,
        selectedModels: [{ modelId: "user-prior-model", parameters: [] }],
      };
      blob.openAIBaseUrl = "https://prior.example/v1";
      writeCursorDb(dbPath, blob, { openAIKey: "sk-prior-key" });

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const after = readBlob(dbPath);
      assert.equal(after.openAIBaseUrl, "https://prior.example/v1");
      assert.equal(after.useOpenAIKey, false);
      assert.equal(after.aiSettings.modelConfig.composer.modelName, "user-prior-model");
      assert.deepEqual(after.aiSettings.userAddedModels, []);
      assert.equal(after.aiSettings.fireconnectAddedModels, undefined);
      assert.equal(readKey(dbPath), "sk-prior-key");
    });
  });

  itIfSqlite("off with no backup strips fireconnect-managed settings only", async () => {
    await withTempHome("cursor-strip-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      // Fireworks already active but no backup file (e.g. enabled by an older
      // build). `off` must strip what fireconnect owns without throwing.
      const blob = baseBlob();
      blob.useOpenAIKey = true;
      blob.openAIBaseUrl = CURSOR_FIREWORKS_BASE_URL;
      blob.aiSettings.userAddedModels = ["accounts/fireworks/routers/glm-latest"];
      blob.aiSettings.modelOverrideEnabled = ["accounts/fireworks/routers/glm-latest"];
      blob.aiSettings.fireconnectAddedModels = ["accounts/fireworks/routers/glm-latest"];
      blob.aiSettings.fireconnectTouchedModes = ["composer"];
      writeCursorDb(dbPath, blob, { openAIKey: "fw_test_key_12345" });

      const r = await runCli(["cursor", "off", "--db-path", dbPath, "--force"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const after = readBlob(dbPath);
      assert.equal(after.useOpenAIKey, false);
      assert.equal(after.openAIBaseUrl, null);
      assert.deepEqual(after.aiSettings.userAddedModels, []);
      assert.equal(readKey(dbPath), "");
    });
  });

  itIfSqlite("status works against a missing DB (read-only, no throw)", async () => {
    await withTempHome("cursor-missing-", async (home) => {
      const dbPath = path.join(home, "does-not-exist.vscdb");
      const r = await runCliJson(["cursor", "status", "--db-path", dbPath, "--json"], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.provider, "none");
      assert.equal(r.json.hasKey, false);
    });
  });

  itIfSqlite("model add registers a model without touching active mode selections", async () => {
    await withTempHome("cursor-add-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCli(
        ["cursor", "model", "add", "deepseek-v4-flash", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const blob = readBlob(dbPath);
      // Both the on() default and the newly added model are registered.
      assert.ok(blob.aiSettings.userAddedModels.includes("accounts/fireworks/routers/glm-latest"));
      assert.ok(blob.aiSettings.userAddedModels.includes("accounts/fireworks/models/deepseek-v4-flash"));
      assert.ok(blob.aiSettings.fireconnectAddedModels.includes("accounts/fireworks/models/deepseek-v4-flash"));
      // Active mode selection is unchanged — composer still points at the on()
      // default, not deepseek-v4-flash. `add` must not clobber active modes.
      assert.equal(cursorCurrentModelId(blob, "composer"), "accounts/fireworks/routers/glm-latest");
      // `add` touched no new modes.
      assert.deepEqual(blob.aiSettings.fireconnectTouchedModes, ["composer"]);
    });
  });

  itIfSqlite("model add also accepts --model instead of a positional", async () => {
    await withTempHome("cursor-add-flag-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());

      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });
      const r = await runCli(
        ["cursor", "model", "add", "--model", "deepseek-v4-flash", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const blob = readBlob(dbPath);
      assert.ok(blob.aiSettings.userAddedModels.includes("accounts/fireworks/models/deepseek-v4-flash"));
    });
  });

  itIfSqlite("model add refuses when Fireworks is not enabled", async () => {
    await withTempHome("cursor-add-off-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const r = await runCli(
        ["cursor", "model", "add", "deepseek-v4-flash", "--db-path", dbPath, "--force"],
        { home },
      );
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /requires Fireworks to be enabled/);
    });
  });

  itIfSqlite("model add requires a model id", async () => {
    await withTempHome("cursor-add-noid-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      await runCli(["cursor", "on", "--api-key", "fw_test_key_12345", "--db-path", dbPath, "--force"], { home });

      const r = await runCli(["cursor", "model", "add", "--db-path", dbPath, "--force"], { home });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /requires a model id/);
    });
  });

  itIfSqlite("model add is rejected for non-cursor harnesses", async () => {
    await withTempHome("cursor-add-other-", async (home) => {
      const r = await runCli(["claude", "model", "add", "deepseek-v4-flash", "--home", home], { home });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /model add is not supported for claude/);
    });
  });
});
