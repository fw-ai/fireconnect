import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  APPLICATION_USER_KEY,
  CURSOR_AUTH_OPENAI_KEY,
  CURSOR_AUTH_OPENAI_KEY_SECRET,
  CURSOR_FIREWORKS_BASE_URL,
  cursorProviderStatus,
  readCursorState,
} from "../../lib/harnesses/cursor/core.mjs";
import { applyCursorWrites, ensureCursorTable } from "../../lib/harnesses/cursor/sqlite.mjs";
import { cursorPathsFor } from "../../lib/harness/context.mjs";
import { fireconnectSecretIds, vscodeStateDbPath } from "../../lib/harnesses/vscode/core.mjs";
import { writeItemTableValue } from "../../lib/harnesses/vscode/vscdb-sqlite.mjs";
import { itIfSqlite, runCli, runCliJson, withTempHome } from "../helpers.mjs";

// Decrypting Cursor's / VS Code's `secret://` cell reads the app's Safe Storage
// password from the OS keychain, and on macOS each new process doing so raises
// a password prompt. Status commands get polled, so they must never touch the
// keychain, and `cursor off` only may when it restores the user's own key.
// These specs run with real (non-plaintext) ciphertext and a PATH whose
// `security` / `secret-tool` only log that they were called.

const FW_KEY = "fw_test_key_12345";
/** A `safeStorage.encryptString` result: `v11` prefix + opaque bytes. */
const CIPHERTEXT = JSON.stringify({ type: "Buffer", data: [118, 49, 49, ...Array.from({ length: 16 }, (_, i) => i)] });

const managedBlob = (overrides = {}) => ({
  openAIBaseUrl: CURSOR_FIREWORKS_BASE_URL,
  useOpenAIKey: true,
  aiSettings: { fireconnectAddedModels: ["accounts/fireworks/models/glm-5"] },
  ...overrides,
});

async function seedCursor(home, { blob = managedBlob(), legacy = FW_KEY, secret = CIPHERTEXT } = {}) {
  const { dbPath } = cursorPathsFor({ home });
  await mkdir(path.dirname(dbPath), { recursive: true });
  await ensureCursorTable(dbPath);
  const writes = [{ op: "set", key: APPLICATION_USER_KEY, value: JSON.stringify(blob) }];
  if (legacy !== null) writes.push({ op: "set", key: CURSOR_AUTH_OPENAI_KEY, value: legacy });
  if (secret !== null) writes.push({ op: "set", key: CURSOR_AUTH_OPENAI_KEY_SECRET, value: secret });
  await applyCursorWrites(dbPath, writes);
  return dbPath;
}

/** A bin dir whose keychain tools append their argv to `<home>/keychain.log`. */
async function keychainSpy(home) {
  const bin = path.join(home, "spy-bin");
  const log = path.join(home, "keychain.log");
  await mkdir(bin, { recursive: true });
  for (const tool of ["security", "secret-tool"]) {
    const file = path.join(bin, tool);
    await writeFile(file, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`);
    await chmod(file, 0o755);
  }
  return {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, NEXUS_VSCODE_SECRET_PLAINTEXT: "" },
    calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}

const itIfPosixSqlite = process.platform === "win32" ? it.skip : itIfSqlite;

/**
 * A temp HOME that Cursor's data dir follows on every platform: on Linux it
 * lives under XDG_CONFIG_HOME and on Windows under APPDATA when those are set
 * (as in CI or a real desktop), which would otherwise point specs at a shared
 * or real state.vscdb. Spawned CLIs inherit both through runCli.
 */
function withHome(prefix, fn) {
  return withTempHome(prefix, async (home) => {
    const overrides = {
      XDG_CONFIG_HOME: path.join(home, ".config"),
      APPDATA: path.join(home, "AppData", "Roaming"),
    };
    const prev = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
    Object.assign(process.env, overrides);
    try {
      return await fn(home);
    } finally {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}

describe("status reads never touch the keychain", () => {
  itIfPosixSqlite("cursor status, status and harnesses report Cursor as routed without a keychain read", async () => {
    await withHome("keychain-free-cursor-", async (home) => {
      await seedCursor(home);
      const spy = await keychainSpy(home);

      const cursor = await runCliJson(["cursor", "status", "--json"], { home, env: spy.env });
      assert.equal(cursor.code, 0, cursor.stderr);
      assert.equal(cursor.json.provider, "fireworks");
      assert.equal(cursor.json.hasKey, true);

      const global = await runCli(["status", "--json"], { home, env: spy.env });
      assert.match(global.stdout, /"cursor"/);
      const harnesses = await runCliJson(["harnesses", "--json"], { home, env: spy.env });
      assert.equal(harnesses.json.harnesses.find((row) => row.id === "cursor")?.connected, true);

      assert.deepEqual(await spy.calls(), []);
    });
  });

  itIfPosixSqlite("vscode status reports a stored key without a keychain read", async () => {
    await withHome("keychain-free-vscode-", async (home) => {
      const vscodePath = path.join(home, "Code", "User", "chatLanguageModels.json");
      const on = await (await runCli(["login", "--api-key", FW_KEY], { home, env: { NEXUS_VSCODE_SECRET_PLAINTEXT: "1" } }), await runCli(["vscode", "on", "--vscode-path", vscodePath, "--force"], { home, env: { NEXUS_VSCODE_SECRET_PLAINTEXT: "1" } }));
      assert.equal(on.code, 0, on.stderr);
      const secretId = fireconnectSecretIds(JSON.parse(await readFile(vscodePath, "utf8")))[0];
      await writeItemTableValue(vscodeStateDbPath({ vscodePath }), `secret://${secretId}`, CIPHERTEXT);
      const spy = await keychainSpy(home);

      const status = await runCliJson(["vscode", "status", "--json", "--vscode-path", vscodePath], { home, env: spy.env });
      assert.equal(status.code, 0, status.stderr);
      assert.equal(status.json.provider, "fireworks");
      assert.equal(status.json.hasKey, true);
      assert.deepEqual(await spy.calls(), []);
    });
  });

  itIfPosixSqlite("cursor off with no key to restore leaves the keychain alone", async () => {
    await withHome("keychain-free-cursor-off-", async (home) => {
      const { dbPath } = cursorPathsFor({ home });
      await mkdir(path.dirname(dbPath), { recursive: true });
      await ensureCursorTable(dbPath);
      const on = await (await runCli(["login", "--api-key", FW_KEY], { home, env: { NEXUS_VSCODE_SECRET_PLAINTEXT: "1" } }), await runCli(["cursor", "on", "--force"], { home, env: { NEXUS_VSCODE_SECRET_PLAINTEXT: "1" } }));
      assert.equal(on.code, 0, on.stderr);
      const spy = await keychainSpy(home);

      const off = await runCli(["cursor", "off", "--force"], { home, env: spy.env });
      assert.equal(off.code, 0, off.stderr);
      assert.deepEqual(await spy.calls(), []);
      const state = await readCursorState(dbPath, { keychain: false });
      assert.equal(state.keyStored, false);
      assert.equal(cursorProviderStatus(state.blob, state.openAIKey), "none");
    });
  });
});

describe("readCursorState({ keychain: false })", () => {
  const withPlaintextOff = async (fn) => {
    const prev = process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.NEXUS_VSCODE_SECRET_PLAINTEXT;
      else process.env.NEXUS_VSCODE_SECRET_PLAINTEXT = prev;
    }
  };

  itIfSqlite("trusts the plaintext copy while Cursor still points at Fireworks", async () => {
    await withHome("keychain-free-read-", (home) => withPlaintextOff(async () => {
      const state = await readCursorState(await seedCursor(home), { keychain: false });
      assert.equal(state.openAIKey, FW_KEY);
      assert.equal(state.keyStored, true);
      assert.equal(cursorProviderStatus(state.blob, state.openAIKey), "fireworks");
    }));
  });

  itIfSqlite("ignores a stale plaintext copy once the user points Cursor elsewhere", async () => {
    await withHome("keychain-free-stale-", (home) => withPlaintextOff(async () => {
      const dbPath = await seedCursor(home, {
        blob: managedBlob({ openAIBaseUrl: "https://api.openai.com/v1", aiSettings: {} }),
      });
      const state = await readCursorState(dbPath, { keychain: false });
      assert.equal(state.openAIKey, "");
      assert.equal(state.keyStored, true);
      assert.equal(cursorProviderStatus(state.blob, state.openAIKey), "none");
    }));
  });

  itIfSqlite("reads the plaintext cell when there is no ciphertext (older Cursor)", async () => {
    await withHome("keychain-free-legacy-", (home) => withPlaintextOff(async () => {
      const dbPath = await seedCursor(home, { secret: null, blob: managedBlob({ openAIBaseUrl: "https://example.test/v1" }) });
      const state = await readCursorState(dbPath, { keychain: false });
      assert.equal(state.openAIKey, FW_KEY);
    }));
  });

  itIfSqlite("reports no key when both cells are empty", async () => {
    await withHome("keychain-free-empty-", (home) => withPlaintextOff(async () => {
      const dbPath = await seedCursor(home, { legacy: null, secret: JSON.stringify({ type: "Buffer", data: [] }) });
      const state = await readCursorState(dbPath, { keychain: false });
      assert.equal(state.openAIKey, "");
      assert.equal(state.keyStored, false);
    }));
  });
});
