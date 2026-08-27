import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runCli, withTempHome } from "../../helpers.mjs";

process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT = "1";

const APPLICATION_USER_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

function baseBlob() {
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
  };
}

const jsonLit = (v) => JSON.stringify(v).replace(/'/g, "''");

function writeCursorDb(dbPath, blob) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('${APPLICATION_USER_KEY}','${jsonLit(blob)}');`,
  ];
  const r = spawnSync("sqlite3", [dbPath, sql.join("\n")], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`sqlite3 init failed: ${r.stderr || r.error?.message}`);
  }
}

function readBlob(dbPath) {
  const r = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='${APPLICATION_USER_KEY}';`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = (r.stdout ?? "").replace(/\n$/, "");
  return raw ? JSON.parse(raw) : null;
}

// A malformed model id (a truncated "firerouter/" prefix) must be rejected
// before any key verification or config write. The compound `firerouter/x`
// gateway form stays valid.
describe("cursor on --model validation (engineOn)", () => {
  const sqliteAvailable = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;
  const itIfSqlite = sqliteAvailable ? it : it.skip;

  itIfSqlite("rejects a truncated firerouter prefix without writing the blob", async () => {
    await withTempHome("cursor-model-bad-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      // No gateway URL is set: if the bad id slipped through to key
      // verification, the error would be the key message, not the model one.
      const result = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345",
          "--model", "irerouter/claude-opus-5/kimi-k3-fast",
          "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.notEqual(result.code, 0, "expected a non-zero exit for a malformed model id");
      assert.match(
        result.stderr,
        /--model must be a Fireworks model id — a stable -latest router alias like glm-fast-latest.*firerouter, or a specific id like glm-5p2/,
        `stderr was: ${result.stderr}`,
      );
      // The blob must be untouched — no verbatim bad id persisted.
      const blob = readBlob(dbPath);
      const allModelIds = [
        ...(blob?.aiSettings?.userAddedModels ?? []),
        ...(blob?.aiSettings?.modelOverrideEnabled ?? []),
        blob?.aiSettings?.modelConfig?.composer?.modelName,
        ...(blob?.aiSettings?.modelConfig?.composer?.selectedModels ?? []).map((s) => s?.modelId),
      ].filter(Boolean);
      assert.ok(
        !allModelIds.includes("irerouter/claude-opus-5/kimi-k3-fast"),
        `bad id was persisted: ${JSON.stringify(allModelIds)}`,
      );
    });
  });

  itIfSqlite("accepts the valid compound firerouter gateway form", async () => {
    await withTempHome("cursor-model-good-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      writeCursorDb(dbPath, baseBlob());
      const result = await runCli(
        ["cursor", "on", "--api-key", "fw_test_key_12345",
          "--model", "firerouter/claude-opus-5/kimi-k3-fast",
          "--db-path", dbPath, "--force"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      // Validation passes; the run may still fail later on key verification
      // (no gateway here), but it must NOT fail with the model-id message.
      assert.doesNotMatch(
        result.stderr,
        /must be a Fireworks model id/,
        `unexpected model-id rejection for valid gateway form: ${result.stderr}`,
      );
    });
  });
});
