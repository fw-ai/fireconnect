import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearFireworksTopLevelWithoutBackup,
  claudeFireconnectIntent,
  disableFireworksProvider,
  providerBackupPath,
  providerStatePath,
  stripFireworksOwnedEnv,
  stripManagedApiKeyHelper,
  userSettingsPath,
} from "../lib/harnesses/claude/core.mjs";
import { writeJson } from "../lib/io/json.mjs";
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

  it("removes a legacy FireConnect key-export helper when state is missing", () => {
    const helper = "/usr/bin/node '/opt/fireconnect/bin/fireconnect.mjs' --home /tmp/user key export --stored-only";
    const { settings: next, changed } = stripManagedApiKeyHelper(
      { apiKeyHelper: helper, env: {} },
      {},
    );
    assert.equal(next.apiKeyHelper, undefined);
    assert.equal(changed, true);
  });
});

describe("stripFireworksOwnedEnv", () => {
  it("removes direct auth and telemetry while preserving user headers", () => {
    const { env, changed } = stripFireworksOwnedEnv({
      ANTHROPIC_BASE_URL: FIREWORKS_INFERENCE_URL,
      ANTHROPIC_CUSTOM_HEADERS: [
        "X-Fireworks-Api-Key: fw_test",
        "User-Agent: fireconnect/0.8.0",
        "X-FireRouter-Harness: claude_code/2.1.19",
        "X-User-Trace: keep",
      ].join("\n"),
    });
    assert.equal(changed, true);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "X-User-Trace: keep");
  });
});

describe("clearFireworksTopLevelWithoutBackup", () => {
  it("removes top-level model unconditionally", () => {
    const next = clearFireworksTopLevelWithoutBackup({
      model: "claude-sonnet-5",
      env: {},
    });
    assert.equal(Object.hasOwn(next, "model"), false);
  });
});

describe("claudeFireconnectIntent", () => {
  it("treats any model mapping slot as FireConnect wiring when base URL is Fireworks", () => {
    const intent = claudeFireconnectIntent({
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_INFERENCE_URL,
        ANTHROPIC_MODEL: "claude-sonnet-5",
      },
    }, {
      backup: { snapshot: { existed: true, raw: "{}" } },
    });
    assert.equal(intent?.mode, "direct");
    assert.equal(intent?.mapping.main, "claude-sonnet-5");
  });
});

describe("disableFireworksProvider", () => {
  it("strips top-level model on off without backup when Fireworks base URL is active", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-disable-no-backup-"));
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(path.dirname(userSettingsPath(home)), { recursive: true });
    await mkdir(dataDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    await writeJson(settingsPath, {
      model: "claude-sonnet-5",
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_INFERENCE_URL,
        ANTHROPIC_MODEL: "kimi-fast-latest",
      },
    });

    await disableFireworksProvider({
      settingsPath,
      dataDir,
      wasEnabled: true,
    });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(Object.hasOwn(restored, "model"), false);
    assert.equal(restored.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(restored.env.ANTHROPIC_MODEL, undefined);
  });

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
