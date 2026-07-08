import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  crossKeychainInstalled,
  ensureCliDependencies,
  resolveSetupCliDir,
} from "../lib/ensure-cli-deps.mjs";
import { resetSecretStoreForTests } from "../lib/secret-store.mjs";

describe("ensure-cli-deps", () => {
  it("resolveSetupCliDir points at packages/setup-cli", () => {
    assert.equal(path.basename(resolveSetupCliDir()), "setup-cli");
    assert.ok(crossKeychainInstalled());
  });
});

describe("dep-less checkout configure", () => {
  let home;
  let setupDir;
  let savedHome;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    home = await mkdtemp(path.join(os.tmpdir(), "fc-fallback-"));
    process.env.HOME = home;
    resetSecretStoreForTests();

    setupDir = await mkdtemp(path.join(os.tmpdir(), "fc-setup-"));
    await cp(resolveSetupCliDir(), setupDir, { recursive: true });
    await rm(path.join(setupDir, "node_modules"), { recursive: true, force: true });
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
    await rm(setupDir, { recursive: true, force: true });
  });

  it("ensureCliDependencies installs cross-keychain from a dep-less checkout copy", () => {
    assert.equal(crossKeychainInstalled(setupDir), false);
    assert.equal(ensureCliDependencies(setupDir), true);
    assert.equal(crossKeychainInstalled(setupDir), true);
  });

  it("harness on succeeds from a dep-less checkout (auto npm install)", () => {
    const env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "cfg"),
    };
    delete env.FIRECONNECT_SECRET_STORE;
    delete env.FIREWORKS_API_KEY;

    const res = spawnSync(
      process.execPath,
      [
        path.join(setupDir, "bin/fireconnect.mjs"),
        "--home", home,
        "claude", "on",
        "--api-key", "fw_fallback_test_key",
      ],
      { env, encoding: "utf8", timeout: 120000 },
    );
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    assert.doesNotMatch(
      `${res.stdout}\n${res.stderr}`,
      /cross-keychain secret module could not be loaded/,
    );
  });

  it("harness on falls back to builtin encrypted file when deps cannot be installed", async () => {
    await rm(path.join(setupDir, "package.json"));
    const env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "cfg"),
    };
    delete env.FIRECONNECT_SECRET_STORE;
    delete env.FIREWORKS_API_KEY;

    const res = spawnSync(
      process.execPath,
      [
        path.join(setupDir, "bin/fireconnect.mjs"),
        "--home", home,
        "claude", "on",
        "--api-key", "fw_builtin_only_key",
      ],
      { env, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /encrypted file/i);
    assert.doesNotMatch(
      `${res.stdout}\n${res.stderr}`,
      /cross-keychain secret module could not be loaded/,
    );
  });
});
