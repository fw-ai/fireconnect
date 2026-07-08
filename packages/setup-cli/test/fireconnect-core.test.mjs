import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  disableFireworksProvider,
  providerBackupPath,
  providerStatePath,
  stripManagedApiKeyHelper,
  userSettingsPath,
  writeJson,
} from "../lib/fireconnect-core.mjs";
import { FIREWORKS_INFERENCE_URL } from "./helpers.mjs";

describe("stripManagedApiKeyHelper", () => {
  it("removes helper when it matches managedApiKeyHelper and reports changed", () => {
    const helper = "/usr/local/bin/fireconnect key export";
    const { settings: next, changed } = stripManagedApiKeyHelper(
      { apiKeyHelper: helper, env: {} },
      { managedApiKeyHelper: helper },
    );
    assert.equal(next.apiKeyHelper, undefined);
    assert.equal(changed, true);
  });

  it("preserves a user-owned helper restored from backup and reports unchanged", () => {
    const userHelper = "/usr/bin/my-key-helper";
    const { settings: next, changed } = stripManagedApiKeyHelper(
      { apiKeyHelper: userHelper, env: {} },
      { managedApiKeyHelper: "/usr/local/bin/fireconnect key export" },
    );
    assert.equal(next.apiKeyHelper, userHelper);
    assert.equal(changed, false);
  });
});

describe("disableFireworksProvider", () => {
  it("removes managed apiKeyHelper when backup is env-only", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-disable-helper-"));
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(path.dirname(userSettingsPath(home)), { recursive: true });
    await mkdir(dataDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    const managedHelper = "/usr/local/bin/fireconnect key export";
    await writeJson(settingsPath, {
      apiKeyHelper: managedHelper,
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_INFERENCE_URL,
        ANTHROPIC_MODEL: "accounts/fireworks/routers/glm-latest[1m]",
      },
    });
    await writeJson(providerBackupPath(dataDir), {
      values: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
      missing: [],
    });
    await writeJson(providerStatePath(dataDir), {
      authMode: "apiKeyHelper",
      managedApiKeyHelper: managedHelper,
    });

    await disableFireworksProvider({
      settingsPath,
      dataDir,
      wasEnabled: true,
    });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.apiKeyHelper, undefined);
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  });
});
