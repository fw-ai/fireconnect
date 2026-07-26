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
} from "../../lib/keys/secret-store.mjs";
import { seedKeychainConfig, withTempHome } from "../helpers.mjs";

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
      const { readGlobalConfig } = await import("../../lib/config/global-config.mjs");
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
      keyStorage: process.env.FIRECONNECT_KEY_STORAGE,
      masterKey: process.env.KEYRING_FILE_MASTER_KEY,
      xdgData: process.env.XDG_DATA_HOME,
      xdgConfig: process.env.XDG_CONFIG_HOME,
      fireworksKey: process.env.FIREWORKS_API_KEY,
    };

    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "config");
    process.env.FIRECONNECT_SECRET_STORE = "memory";
    // Isolate from the host OS keychain; the prod gate is about the memory seam,
    // not whether libsecret happens to hold a key on the dev machine.
    process.env.FIRECONNECT_KEY_STORAGE = "file";
    process.env.KEYRING_FILE_MASTER_KEY = "a".repeat(64);
    delete process.env.FIRECONNECT_TEST;
    delete process.env.NODE_ENV;
    delete process.env.FIREWORKS_API_KEY;
    resetSecretStoreForTests();

    try {
      await mkdir(path.dirname(secretPath), { recursive: true });
      await writeFile(secretPath, "fw_should_not_load_123", { mode: 0o600 });

      assert.equal(await getSecret(), null);

      await setSecret("fw_test_key_12345");
      assert.equal(await readFile(secretPath, "utf8"), "fw_should_not_load_123");
      assert.equal(await getSecret(), "fw_test_key_12345");
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
      if (prev.keyStorage === undefined) {
        delete process.env.FIRECONNECT_KEY_STORAGE;
      } else {
        process.env.FIRECONNECT_KEY_STORAGE = prev.keyStorage;
      }
      if (prev.masterKey === undefined) {
        delete process.env.KEYRING_FILE_MASTER_KEY;
      } else {
        process.env.KEYRING_FILE_MASTER_KEY = prev.masterKey;
      }
      if (prev.xdgData === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = prev.xdgData;
      }
      if (prev.xdgConfig === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prev.xdgConfig;
      }
      if (prev.fireworksKey === undefined) {
        delete process.env.FIREWORKS_API_KEY;
      } else {
        process.env.FIREWORKS_API_KEY = prev.fireworksKey;
      }
      resetSecretStoreForTests();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("caches secure reads in-process but stays fresh across write and delete", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-secret-cache-"));
    const prev = {
      home: process.env.HOME,
      store: process.env.FIRECONNECT_SECRET_STORE,
      test: process.env.FIRECONNECT_TEST,
      nodeEnv: process.env.NODE_ENV,
      keyStorage: process.env.FIRECONNECT_KEY_STORAGE,
      masterKey: process.env.KEYRING_FILE_MASTER_KEY,
      xdgData: process.env.XDG_DATA_HOME,
      xdgConfig: process.env.XDG_CONFIG_HOME,
      fireworksKey: process.env.FIREWORKS_API_KEY,
    };

    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "config");
    process.env.FIRECONNECT_KEY_STORAGE = "file";
    process.env.KEYRING_FILE_MASTER_KEY = "b".repeat(64);
    delete process.env.FIRECONNECT_SECRET_STORE;
    delete process.env.FIRECONNECT_TEST;
    delete process.env.NODE_ENV;
    delete process.env.FIREWORKS_API_KEY;
    resetSecretStoreForTests();

    try {
      await setSecret("fw_cache_key_aaaa");
      // Repeated reads in the same process return the value without going stale
      // (served from the in-process cache that collapses OS-keychain prompts).
      for (let i = 0; i < 5; i += 1) {
        assert.equal(await getSecret(), "fw_cache_key_aaaa");
      }
      assert.equal(await hasSecret(), true);

      // A write updates the cache — the next read must not return the old value.
      await setSecret("fw_cache_key_bbbb");
      assert.equal(await getSecret(), "fw_cache_key_bbbb");

      // A delete invalidates the cache — the next read must be null.
      await deleteSecret();
      assert.equal(await getSecret(), null);
      assert.equal(await hasSecret(), false);
    } finally {
      const restore = (key, value) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      };
      restore("HOME", prev.home);
      restore("FIRECONNECT_SECRET_STORE", prev.store);
      restore("FIRECONNECT_TEST", prev.test);
      restore("NODE_ENV", prev.nodeEnv);
      restore("FIRECONNECT_KEY_STORAGE", prev.keyStorage);
      restore("KEYRING_FILE_MASTER_KEY", prev.masterKey);
      restore("XDG_DATA_HOME", prev.xdgData);
      restore("XDG_CONFIG_HOME", prev.xdgConfig);
      restore("FIREWORKS_API_KEY", prev.fireworksKey);
      resetSecretStoreForTests();
      await rm(home, { recursive: true, force: true });
    }
  });
});
