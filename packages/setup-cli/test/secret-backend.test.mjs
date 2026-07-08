import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  detectSecretBackend,
  setSecret,
  getSecret,
  hasSecret,
  deleteSecret,
  resetSecretStoreForTests,
  FIRECONNECT_KEY_STORAGE_ENV,
} from "../lib/secret-store.mjs";
import {
  keyStatusSummary,
  persistApiKeyToKeychain,
} from "../lib/api-key.mjs";
import { readGlobalConfig, writeGlobalConfig, setHarnessEnabled, globalConfigPath } from "../lib/global-config.mjs";
import { plaintextMode } from "../lib/vscode-safestorage.mjs";
import { shellHookBlock } from "../lib/shell-env-hook.mjs";
import { verifyKeyExportWorks } from "../lib/key-selfcheck.mjs";
import { resolveHarnessOnApiKey } from "../lib/fireworks-models.mjs";

const CLI = path.resolve("bin/fireconnect.mjs");
const KEY = "fw_backend_test_key_000000000000";

/**
 * Run the CLI in a child process with a fully controlled environment so the
 * file-backend path is exercised (no memory test-seam, no host keychain).
 */
function runCli(args, env) {
  const childEnv = { ...process.env };
  // Never use the in-memory test seam for these; we want the real file backend.
  delete childEnv.FIRECONNECT_SECRET_STORE;
  delete childEnv.FIREWORKS_API_KEY;
  Object.assign(childEnv, env);
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: childEnv,
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function fileBackendEnv(home) {
  return {
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "cfg"),
    [FIRECONNECT_KEY_STORAGE_ENV]: "file",
  };
}

describe("secret backend detection + file backend", () => {
  let home;
  let savedEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-backend-"));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      [FIRECONNECT_KEY_STORAGE_ENV]: process.env[FIRECONNECT_KEY_STORAGE_ENV],
    };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    process.env[FIRECONNECT_KEY_STORAGE_ENV] = "file";
    resetSecretStoreForTests();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env[FIRECONNECT_KEY_STORAGE_ENV];
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("detectSecretBackend reports the file backend with its on-disk location", async () => {
    const backend = await detectSecretBackend(home);
    assert.equal(backend.backend, "file");
    assert.match(backend.label, /Encrypted file/);
    assert.equal(backend.location, path.join(home, "data", "keyring", "secrets.json"));
    assert.equal(backend.forced, true);
  });

  it("round-trips a key through the encrypted file backend with no plaintext on disk", async () => {
    await setSecret(KEY, home);
    assert.equal(await getSecret(home), KEY);
    assert.equal(await hasSecret(home), true);
    const raw = await readFile(path.join(home, "data", "keyring", "secrets.json"), "utf8");
    assert.ok(!raw.includes(KEY), "key must not appear in plaintext in the store file");
    await deleteSecret(home);
    assert.equal(await hasSecret(home), false);
  });

  it("detectSecretBackend reports unavailable for the null backend", async () => {
    process.env[FIRECONNECT_KEY_STORAGE_ENV] = "null";
    resetSecretStoreForTests();
    const backend = await detectSecretBackend(home);
    assert.equal(backend.backend, "unavailable");
    assert.ok(backend.error);
  });

  it("detectSecretBackend ignores an unknown backend value (falls back to auto)", async () => {
    process.env[FIRECONNECT_KEY_STORAGE_ENV] = "bogus";
    resetSecretStoreForTests();
    const backend = await detectSecretBackend(home);
    // On the CI host a native keychain may or may not be present; either keychain
    // or file is acceptable — just not "unavailable" and not "memory".
    assert.notEqual(backend.backend, "memory");
    assert.notEqual(backend.backend, "unavailable");
  });

  it("persistApiKeyToKeychain refuses and leaves config unchanged when the backend is unavailable", async () => {
    process.env[FIRECONNECT_KEY_STORAGE_ENV] = "null";
    resetSecretStoreForTests();
    // Seed an existing config so we can prove it is NOT overwritten on failure.
    await writeGlobalConfig(home, { apiKey: "{env:FIREWORKS_API_KEY}", harnesses: {} });

    await assert.rejects(() => persistApiKeyToKeychain(home, KEY), /Cannot store the API key/);

    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "{env:FIREWORKS_API_KEY}", "config must be untouched on failure");
  });

  it("keyStatusSummary includes backend, location, and perHarness entries", async () => {
    await persistApiKeyToKeychain(home, KEY);
    await setHarnessEnabled(home, "claude", true, { mode: "direct" });

    const summary = await keyStatusSummary(home);
    assert.equal(summary.backend, "file");
    assert.ok(summary.location);
    assert.equal(summary.keychainPresent, true);
    assert.ok(Array.isArray(summary.perHarness));
    assert.ok(summary.perHarness.length >= 6);

    const claude = summary.perHarness.find((h) => h.id === "claude");
    assert.ok(claude, "claude entry present");
    assert.equal(claude.enabled, true);
    assert.match(claude.readsFrom, /apiKeyHelper/);
    assert.match(claude.storage, /Encrypted file/);

    const vscode = summary.perHarness.find((h) => h.id === "vscode");
    assert.equal(vscode.storage, "IDE Electron safeStorage (encrypted)");
    const cursor = summary.perHarness.find((h) => h.id === "cursor");
    assert.equal(cursor.storage, "Cursor SQLite (plaintext cell)");
  });

  it("keychain fallback repairs the config ref so the shell hook can install", async () => {
    // Seed the key in the file backend, but leave config.json ABSENT (simulating
    // a lost {keychain} ref). resolveHarnessOnApiKey should recover the key from
    // the store AND repair config.json to {keychain:fireworks-api-key} — otherwise the
    // shell env hook (gated on isKeychainConfigRef) wouldn't install and
    // Codex/OpenCode/Pi would be enabled with {env:…} but no exported key.
    await setSecret(KEY, home);
    // No config.json present.
    const resolved = await resolveHarnessOnApiKey({
      apiKey: "",
      home,
      harnessEnvRef: "{env:FIREWORKS_API_KEY}",
      getExistingHarnessKey: async () => "",
    });
    assert.equal(resolved.effectiveKey, KEY, "key recovered from the keychain");

    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "{keychain:fireworks-api-key}", "config ref repaired so the shell hook installs");
  });

  it("keychain fallback does not fire in env mode (user manages the env var)", async () => {
    // env mode = config.apiKey is {env:FIREWORKS_API_KEY}; the user manages the
    // var themselves, so the fallback must NOT recover from the keychain (that
    // would enable the harness with {env:…} while the env var is unset).
    await setSecret(KEY, home);
    await writeGlobalConfig(home, { apiKey: "{env:FIREWORKS_API_KEY}" });
    await assert.rejects(
      () => resolveHarnessOnApiKey({
        apiKey: "",
        home,
        harnessEnvRef: "{env:FIREWORKS_API_KEY}",
        getExistingHarnessKey: async () => "",
      }),
      /Fireworks API key/,
    );
    // Config unchanged — not repaired to keychain ref in env mode.
    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "{env:FIREWORKS_API_KEY}");
  });
});

describe("configure / on via CLI with file backend", () => {
  let home;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-cli-backend-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("claude on --api-key stores via the file backend and uses apiKeyHelper (no literal in settings)", async () => {
    const res = runCli(["claude", "on", "--api-key", KEY], fileBackendEnv(home));
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /encrypted file/i);

    const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));
    assert.ok(settings.apiKeyHelper, "apiKeyHelper should be set");
    assert.ok(!JSON.stringify(settings).includes(KEY), "no literal key in settings.json");
  });

  it("harness on refuses with a friendly error when the backend is unavailable", async () => {
    const env = fileBackendEnv(home);
    env[FIRECONNECT_KEY_STORAGE_ENV] = "null";
    const res = runCli(["claude", "on", "--api-key", KEY], env);
    assert.notEqual(res.code, 0);
    // Graceful failure (no stack-trace crash) when nothing can persist the key.
    assert.match(res.stderr, /Cannot store the API key|Storage verification failed/);
    // Config must not have been created with a keychain ref pointing at nothing.
    try {
      const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.notEqual(config.apiKey, "{keychain:fireworks-api-key}");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
});

describe("shell hook interactive hint", () => {
  it("shellHookBlock guards the empty-key hint to interactive shells ([ -t 2 ])", () => {
    const block = shellHookBlock("/tmp/fc-shell-hook-test");
    assert.match(block, /export FIREWORKS_API_KEY="\$\(/);
    assert.match(block, /\[ -t 2 \]/);
    assert.match(block, /fireconnect status/);
    // The hint must NOT execute `fireconnect status` via command substitution:
    // the echo argument is single-quoted so backticks are literal.
    const echoLine = block.split("\n").find((l) => l.includes("echo"));
    assert.ok(echoLine, "echo hint line present");
    assert.ok(/^  echo '/.test(echoLine), "echo argument is single-quoted (no command substitution)");
  });
});


describe("vscode-safestorage plaintextMode strict parse", () => {
  it("treats only the exact value '1' as enabled (not '0' or other strings)", () => {
    const prev = process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT;
    try {
      for (const v of ["0", "false", "yes", "true", ""]) {
        process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT = v;
        assert.equal(plaintextMode(), false, `value ${JSON.stringify(v)} must NOT enable plaintext`);
      }
      process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT = "1";
      assert.equal(plaintextMode(), true);
    } finally {
      if (prev === undefined) delete process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT;
      else process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT = prev;
    }
  });
});

describe("key export self-check", () => {
  let home;
  let savedEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "fc-selfcheck-"));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      [FIRECONNECT_KEY_STORAGE_ENV]: process.env[FIRECONNECT_KEY_STORAGE_ENV],
    };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    process.env[FIRECONNECT_KEY_STORAGE_ENV] = "file";
    resetSecretStoreForTests();

    // Install a real launcher at ~/.local/bin/fireconnect so the self-check
    // resolves the CLI the way it does in production (not via process.argv[1],
    // which is the test file in this process).
    const binDir = path.join(home, ".local/bin");
    await mkdir(binDir, { recursive: true });
    const launcher = path.join(binDir, "fireconnect");
    await writeFile(
      launcher,
      `#!/usr/bin/env bash\nexec "${process.execPath}" "${CLI}" "$@"\n`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env[FIRECONNECT_KEY_STORAGE_ENV];
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("verifyKeyExportWorks succeeds when a key is stored in the file backend", async () => {
    await setSecret(KEY, home);
    const result = await verifyKeyExportWorks(home, { expectedKey: KEY });
    assert.equal(result.ok, true, result.reason ?? "expected ok");
  });

  it("verifyKeyExportWorks reports a failure when no key is stored", async () => {
    const result = await verifyKeyExportWorks(home);
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  });
});
