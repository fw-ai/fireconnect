import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  builtinGetPassword,
  builtinHasPassword,
  builtinSetPassword,
  fileDataRoot,
  secretsFilePath,
} from "../../lib/keys/builtin-file-secret-store.mjs";

const SERVICE = "FireworksAI";
const ACCOUNT = "fireworks-api-key";

describe("builtin-file-secret-store", () => {
  let home;
  let savedHome;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    home = await mkdtemp(path.join(os.tmpdir(), "fc-builtin-file-"));
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("stores secrets as encrypted bytes, not plaintext JSON", async () => {
    await builtinSetPassword(SERVICE, ACCOUNT, "fw_test_secret_value");
    const file = secretsFilePath();
    assert.ok(file);
    const raw = await readFile(file);
    assert.ok(raw.length > 32);
    assert.doesNotMatch(raw.toString("utf8"), /fw_test_secret_value/);
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "fw_test_secret_value");
    assert.equal(await builtinHasPassword(SERVICE, ACCOUNT), true);
  });

  it("uses HOME for data and config when XDG paths are unset", async () => {
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
    const altHome = await mkdtemp(path.join(os.tmpdir(), "fc-builtin-alt-home-"));
    try {
      process.env.HOME = altHome;
      await builtinSetPassword(SERVICE, ACCOUNT, "fw_home_aligned_key");
      assert.equal(fileDataRoot(), path.join(altHome, ".local", "share", "keyring"));
      assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "fw_home_aligned_key");
      const secrets = secretsFilePath();
      assert.ok(secrets?.startsWith(altHome));
    } finally {
      await rm(altHome, { recursive: true, force: true });
      process.env.HOME = home;
      process.env.XDG_DATA_HOME = path.join(home, "data");
      process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    }
  });
});
