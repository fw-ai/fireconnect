import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  deleteSecret,
  getSecret,
  hasSecret,
  resetSecretStoreForTests,
  setSecret,
} from "../lib/secret-store.mjs";
import { seedKeychainConfig, withTempHome } from "./helpers.mjs";

describe("secret-store", () => {
  it("stores and retrieves secrets in memory mode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-secret-mem-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    process.env.FIRECONNECT_SECRET_STORE = "memory";
    process.env.FIRECONNECT_TEST = "1";
    resetSecretStoreForTests();
    try {
      await setSecret("fw_test_secret_12345");
      assert.equal(await getSecret(), "fw_test_secret_12345");
      assert.equal(await hasSecret(), true);
      await deleteSecret();
      assert.equal(await hasSecret(), false);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it("persists memory secrets under HOME for subprocess reads", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-secret-store-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    process.env.FIRECONNECT_SECRET_STORE = "memory";
    process.env.FIRECONNECT_TEST = "1";
    resetSecretStoreForTests();
    try {
      await setSecret("fw_cross_process_key_123");
      const secretPath = path.join(home, ".fireconnect", ".secret-memory");
      assert.equal(await readFile(secretPath, "utf8"), "fw_cross_process_key_123");

      resetSecretStoreForTests();
      assert.equal(await getSecret(), "fw_cross_process_key_123");
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it("seedKeychainConfig writes keychain ref and secret file", async () => {
    await withTempHome("seed-keychain", async (home) => {
      await seedKeychainConfig(home, "fw_seed_key_12345");
      const { readGlobalConfig } = await import("../lib/global-config.mjs");
      const config = await readGlobalConfig(home);
      assert.equal(config.apiKey, "{keychain:fireworks-api-key}");
      assert.equal(
        await readFile(path.join(home, ".fireconnect", ".secret-memory"), "utf8"),
        "fw_seed_key_12345",
      );
    });
  });

  it("ignores FIRECONNECT_SECRET_STORE=memory outside test context", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-secret-prod-gate-"));
    const secretPath = path.join(home, ".fireconnect", ".secret-memory");
    const prev = {
      home: process.env.HOME,
      store: process.env.FIRECONNECT_SECRET_STORE,
      test: process.env.FIRECONNECT_TEST,
      nodeEnv: process.env.NODE_ENV,
    };

    process.env.HOME = home;
    process.env.FIRECONNECT_SECRET_STORE = "memory";
    delete process.env.FIRECONNECT_TEST;
    delete process.env.NODE_ENV;
    resetSecretStoreForTests();

    try {
      await mkdir(path.dirname(secretPath), { recursive: true });
      await writeFile(secretPath, "fw_should_not_load_123", { mode: 0o600 });

      assert.equal(await getSecret(), null);

      await assert.rejects(() => setSecret("fw_test_key_12345"));
      assert.equal(await readFile(secretPath, "utf8"), "fw_should_not_load_123");
    } finally {
      if (prev.home === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prev.home;
      }
      if (prev.store === undefined) {
        delete process.env.FIRECONNECT_SECRET_STORE;
      } else {
        process.env.FIRECONNECT_SECRET_STORE = prev.store;
      }
      if (prev.test === undefined) {
        delete process.env.FIRECONNECT_TEST;
      } else {
        process.env.FIRECONNECT_TEST = prev.test;
      }
      if (prev.nodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prev.nodeEnv;
      }
      resetSecretStoreForTests();
      await rm(home, { recursive: true, force: true });
    }
  });
});
