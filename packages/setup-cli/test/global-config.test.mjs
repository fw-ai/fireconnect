import { mkdtemp } from "node:fs/promises";
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
} from "../lib/global-config.mjs";

describe("global-config", () => {
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
});
