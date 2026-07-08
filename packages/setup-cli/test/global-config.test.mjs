import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readGlobalConfig,
  writeGlobalConfig,
  resolveStoredApiKey,
  discoverHarnessesForUninstall,
  setHarnessEnabled,
  listRegisteredHarnesses,
  listEnabledHarnesses,
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  globalConfigPath,
} from "../lib/global-config.mjs";
import { getSecret } from "../lib/secret-store.mjs";
import { writeJson } from "../lib/fireconnect-core.mjs";

process.env.FIRECONNECT_SECRET_STORE ??= "memory";
process.env.FIRECONNECT_TEST ??= "1";

describe("global-config", () => {
  it("reads empty apiKey when config file is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-config-missing-"));
    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "");
    assert.equal(config._exists, false);
  });

  it("writes and reads config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-config-"));
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: {
        claude: { enabled: false },
        opencode: { enabled: false },
      },
    });

    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, FIREWORKS_API_KEY_ENV_REF);
    assert.deepEqual(listRegisteredHarnesses(config.harnesses), ["claude", "opencode"]);
    assert.deepEqual(listEnabledHarnesses(config.harnesses), []);
  });

  it("resolveStoredApiKey reads env ref", () => {
    const previous = process.env.FIREWORKS_API_KEY;
    process.env.FIREWORKS_API_KEY = "fw_test_key";
    assert.equal(resolveStoredApiKey(FIREWORKS_API_KEY_ENV_REF), "fw_test_key");
    process.env.FIREWORKS_API_KEY = previous;
  });

  it("discoverHarnessesForUninstall returns all registered harnesses including disabled ones", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-discover-"));
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: {
        claude: { enabled: true },
        opencode: { enabled: false },
      },
    });

    const ids = await discoverHarnessesForUninstall(home);
    assert.deepEqual(ids, ["claude", "opencode"]);
  });

  it("setHarnessEnabled updates config without dropping other harnesses", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-set-enabled-"));
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: {
        claude: { enabled: false },
        opencode: { enabled: false },
      },
    });

    await setHarnessEnabled(home, "claude", true);

    const config = await readGlobalConfig(home);
    assert.equal(config.harnesses.claude.enabled, true);
    assert.equal(config.harnesses.opencode.enabled, false);
  });

  it("setHarnessEnabled migrates legacy plaintext apiKey to keychain", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-legacy-migrate-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const legacyKey = "fw_legacy_global_key_12345";
    try {
      await writeJson(globalConfigPath(home), {
        apiKey: legacyKey,
        harnesses: { claude: { enabled: true } },
      });

      await setHarnessEnabled(home, "claude", false);

      const config = await readGlobalConfig(home);
      assert.equal(config.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);
      assert.equal(config.harnesses.claude.enabled, false);
      assert.equal(await getSecret(), legacyKey);
      assert.doesNotMatch(
        await readFile(globalConfigPath(home), "utf8"),
        new RegExp(legacyKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });
});
