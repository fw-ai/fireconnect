import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveFireworksKeyWithSource, harnessStatusKeySource } from "../../lib/keys/api-key.mjs";
import { activeKeySourceNote } from "../../lib/keys/storage-report.mjs";
import {
  getSecret,
  resetSecretStoreForTests,
} from "../../lib/keys/secret-store.mjs";
import {
  readGlobalConfig,
  writeGlobalConfig,
} from "../../lib/config/global-config.mjs";
import {
  FW_CLAUDE_KEY,
  seedKeychainConfig,
  withTempHome,
  withoutEnvFireworksKey,
} from "../helpers.mjs";

const ENV_KEY = "fw_env_key_1111111111111111111111";
const FLAG_KEY = "fw_flag_key_2222222222222222222222";

/** Run `fn` with FIREWORKS_API_KEY set to `value` (or unset when undefined). */
function withEnvFireworksKey(value, fn) {
  const prev = process.env.FIREWORKS_API_KEY;
  if (value === undefined) {
    delete process.env.FIREWORKS_API_KEY;
  } else {
    process.env.FIREWORKS_API_KEY = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.FIREWORKS_API_KEY;
    } else {
      process.env.FIREWORKS_API_KEY = prev;
    }
  }
}

describe("resolveFireworksKeyWithSource precedence", () => {
  test("an explicit --api-key flag wins over env and stored", async () => {
    await withTempHome("src-flag", async (home) => {
      resetSecretStoreForTests();
      await seedKeychainConfig(home, FW_CLAUDE_KEY);
      await withEnvFireworksKey(ENV_KEY, async () => {
        const res = await resolveFireworksKeyWithSource({ apiKey: FLAG_KEY, home });
        assert.deepEqual(res, { key: FLAG_KEY, source: "flag" });
      });
    });
  });

  test("the stored key wins over FIREWORKS_API_KEY env (env is not a source)", async () => {
    await withTempHome("src-env", async (home) => {
      resetSecretStoreForTests();
      await seedKeychainConfig(home, FW_CLAUDE_KEY);
      await withEnvFireworksKey(ENV_KEY, async () => {
        const res = await resolveFireworksKeyWithSource({ home });
        assert.deepEqual(res, { key: FW_CLAUDE_KEY, source: "stored" });
      });
    });
  });

  test("falls back to the stored key when neither flag nor env is set", async () => {
    await withTempHome("src-stored", async (home) => {
      await withoutEnvFireworksKey(async () => {
        resetSecretStoreForTests();
        await seedKeychainConfig(home, FW_CLAUDE_KEY);
        const res = await resolveFireworksKeyWithSource({ home });
        assert.deepEqual(res, { key: FW_CLAUDE_KEY, source: "stored" });
      });
    });
  });

  test("reports source 'none' when nothing is available", async () => {
    await withTempHome("src-none", async (home) => {
      await withoutEnvFireworksKey(async () => {
        resetSecretStoreForTests();
        const res = await resolveFireworksKeyWithSource({ home });
        assert.deepEqual(res, { key: "", source: "none" });
      });
    });
  });

  test("preserves both credentials when a legacy literal conflicts with keychain", async () => {
    await withTempHome("src-conflict", async (home) => {
      await withoutEnvFireworksKey(async () => {
        const storedKey = "fw_stored_key_3333333333333333333333";
        const legacyKey = "fw_legacy_key_4444444444444444444444";
        resetSecretStoreForTests();
        await seedKeychainConfig(home, storedKey);
        await writeGlobalConfig(home, { apiKey: legacyKey });

        const result = await resolveFireworksKeyWithSource({ home });

        assert.deepEqual(result, { key: legacyKey, source: "stored" });
        assert.equal(await getSecret(home), storedKey);
        assert.equal((await readGlobalConfig(home)).apiKey, legacyKey);
      });
    });
  });
});

describe("activeKeySourceNote", () => {
  test("notes the env var is ignored and masks the stored key", () => {
    withEnvFireworksKey("fw_env_override_9999", () => {
      const note = activeKeySourceNote("fw_stored_key_1234");
      assert.match(note, /Nexus ignores it/);
      assert.match(note, /fw_…1234/);
      // Never leak the env or stored key into output.
      assert.doesNotMatch(note, /fw_env_override_9999/);
      assert.doesNotMatch(note, /fw_stored_key_1234/);
    });
  });

  test("affirms the stored key is the source of truth with no env override", () => {
    withEnvFireworksKey(undefined, () => {
      assert.match(activeKeySourceNote("fw_stored_key_1234"), /source of truth/);
    });
  });

  test("points at login when only the env var is set", () => {
    withEnvFireworksKey("fw_same_key_5678", () => {
      const note = activeKeySourceNote("");
      assert.match(note, /Nexus ignores it/);
      assert.match(note, /nexus login/);
      assert.doesNotMatch(note, /fw_same_key_5678/);
    });
  });

  test("returns empty when there is no key at all", () => {
    withEnvFireworksKey(undefined, () => {
      assert.equal(activeKeySourceNote(""), "");
    });
  });
});

describe("harnessStatusKeySource", () => {
  test("Claude apiKeyHelper auth uses the export hook label", () => {
    assert.equal(
      harnessStatusKeySource("claude", "fireworks", { authMode: "apiKeyHelper" }),
      "nexus key export hook",
    );
  });

  test("Claude custom header auth uses the settings header label", () => {
    assert.equal(
      harnessStatusKeySource("claude", "fireworks", { authMode: "customHeader" }),
      "X-Fireworks-Api-Key header in settings.json",
    );
  });
});
