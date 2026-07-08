import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  providerBackupPath,
  providerStatePath,
  userSettingsPath,
  writeJson,
} from "../lib/fireconnect-core.mjs";
import {
  disableFirerouterClaude,
  enableFirerouterClaude,
} from "../lib/claude-firerouter.mjs";
import { FIREROUTER_BASE_URL } from "../lib/firerouter-core.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FIRECONNECT_SECRET_STORE: "memory", FIRECONNECT_TEST: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("claude --router", () => {
  it("on/off round-trip restores prior settings and strips model mapping", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        model: "sonnet",
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_CUSTOM_HEADERS: "X-User-Header: keep-me",
          CLAUDE_CODE_ATTRIBUTION_HEADER: "1",
        },
      }),
    );

    const onResult = await runFireconnect(
      [
        "claude", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--anthropic-key", "sk-ant-test-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.env.ANTHROPIC_BASE_URL, FIREROUTER_BASE_URL);
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-test-12345");
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-FireRouter-Fireworks-Key: fw_test_key_12345/);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.env.ANTHROPIC_MODEL, undefined);
    assert.equal(enabled.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(enabled.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, "1");
    assert.equal(enabled.env.DISABLE_TELEMETRY, "1");
    assert.equal(enabled.env.DO_NOT_TRACK, "1");
    assert.equal(enabled.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(Object.hasOwn(enabled.env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
    assert.equal(enabled.model, "sonnet");

    const select = await runFireconnect(["claude", "model", "select"], { HOME: home });
    assert.notEqual(select.code, 0);
    assert.match(select.stderr, /--router mode/);

    const offResult = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(restored.env.ANTHROPIC_MODEL, "claude-sonnet-4-20250514");
    assert.equal(restored.env.ANTHROPIC_CUSTOM_HEADERS, "X-User-Header: keep-me");
    assert.equal(restored.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "1");
    assert.equal(Object.hasOwn(restored.env, "DISABLE_TELEMETRY"), false);
    assert.equal(Object.hasOwn(restored.env, "DO_NOT_TRACK"), false);
    assert.equal(Object.hasOwn(restored.env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"), false);
    assert.equal(restored.model, "sonnet");
  });

  it("switches between router and direct without leaking headers or stale backups", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-modes-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-native-only",
        },
      }),
    );

    await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    await runFireconnect(
      ["claude", "on", "--router", "--anthropic-key", "sk-ant-test-12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );

    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, FIREROUTER_BASE_URL);

    await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(settings.env.ANTHROPIC_API_KEY, "sk-ant-native-only");

    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: FIREROUTER_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: "sk-ant-router",
          ANTHROPIC_CUSTOM_HEADERS: "X-FireRouter-Fireworks-Key: fw_router_key",
          CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
        },
      }),
    );
    await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_direct_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.fireworks.ai/inference");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, undefined);

    await rm(path.join(home, ".fireconnect", "claude"), { recursive: true, force: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-native-only",
        },
      }),
    );
    await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    const off = await runFireconnect(
      ["claude", "off", "--router"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(off.code, 0);
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(settings.env.ANTHROPIC_API_KEY, "sk-ant-native-only");
  });

  it("off restores native for custom router URL when global routerBaseUrl is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-orphan-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-native-only",
        },
      }),
    );

    await runFireconnect(
      [
        "claude", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--base-url", "https://router-dev.example.com",
        "--anthropic-key", "sk-ant-test-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );

    await writeFile(
      path.join(home, ".fireconnect/config.json"),
      JSON.stringify({
        apiKey: "fw_test_key_12345",
        anthropicApiKey: "sk-ant-test-12345",
        routerBaseUrl: "",
        harnesses: { claude: { enabled: true, mode: "router" } },
      }),
    );

    const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(off.code, 0, off.stderr);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(settings.env.ANTHROPIC_API_KEY, "sk-ant-native-only");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  });

  it("on keeps a pre-existing user apiKeyHelper; off leaves it in place", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-helper-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const userHelper = "/usr/local/bin/my-key-helper";
    await writeFile(
      settingsPath,
      JSON.stringify({
        apiKeyHelper: userHelper,
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    const onResult = await runFireconnect(
      [
        "claude", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--anthropic-key", "sk-ant-test-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, userHelper, "router mode keeps the user's own helper");

    const offResult = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.apiKeyHelper, userHelper, "user helper untouched after off");
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
  });

  it("on with no helper keeps it absent across on/off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-nohelper-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    const onResult = await runFireconnect(
      [
        "claude", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--anthropic-key", "sk-ant-test-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(Object.hasOwn(enabled, "apiKeyHelper"), false);

    const offResult = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(Object.hasOwn(restored, "apiKeyHelper"), false);
  });

  it("direct-on then router-on: managed helper is dropped, user's own helper picked up and kept", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-from-direct-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const userHelper = "/usr/local/bin/my-key-helper";
    await writeFile(
      settingsPath,
      JSON.stringify({
        apiKeyHelper: userHelper,
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    // direct-on replaces the user's helper with the managed one (user's saved in direct backup)
    const directOn = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(directOn.code, 0, directOn.stderr);
    const afterDirect = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(afterDirect.apiKeyHelper);
    assert.notEqual(afterDirect.apiKeyHelper, userHelper);

    // router-on runs direct-off first (restoring the user's helper), then keeps it
    const routerOn = await runFireconnect(
      ["claude", "on", "--router", "--anthropic-key", "sk-ant-test-12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(routerOn.code, 0, routerOn.stderr);
    const afterRouter = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(afterRouter.apiKeyHelper, userHelper, "router picks up the user's helper from off mode");
    assert.notEqual(afterRouter.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");

    // router-off leaves the user's helper in place
    const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(off.code, 0);
    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.apiKeyHelper, userHelper, "user helper still present after full cycle");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
  });

  it("direct-on (no user helper) then router-on: managed helper is dropped, none lingers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-from-direct-none-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    const directOn = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(directOn.code, 0, directOn.stderr);
    const afterDirect = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(afterDirect.apiKeyHelper, "direct-on sets managed helper");

    const routerOn = await runFireconnect(
      ["claude", "on", "--router", "--anthropic-key", "sk-ant-test-12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(routerOn.code, 0, routerOn.stderr);
    const afterRouter = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(afterRouter.apiKeyHelper, undefined, "managed helper must not linger in router mode");
  });

  it("router-on then direct-on: user helper kept in router, replaced by managed in direct, restored on off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-to-direct-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const userHelper = "/usr/local/bin/my-key-helper";
    await writeFile(
      settingsPath,
      JSON.stringify({
        apiKeyHelper: userHelper,
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    const routerOn = await runFireconnect(
      [
        "claude", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--anthropic-key", "sk-ant-test-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(routerOn.code, 0, routerOn.stderr);
    const afterRouter = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(afterRouter.apiKeyHelper, userHelper, "router keeps user helper");

    // direct-on runs router-off first, then backs up the user's helper and sets managed
    const directOn = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(directOn.code, 0, directOn.stderr);
    const afterDirect = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(afterDirect.apiKeyHelper);
    assert.notEqual(afterDirect.apiKeyHelper, userHelper);

    const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(off.code, 0);
    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.apiKeyHelper, userHelper, "user helper restored after direct off");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
  });

  it("enableFirerouterClaude strips a managed helper via provider-state even when recompute would drift", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-state-strip-"));
    const settingsDir = path.join(home, ".claude");
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    // A managed helper string that fireconnectKeyExportCommand(tempHome) cannot
    // produce (no launcher in temp home → argv/fallback form), simulating path
    // drift between direct-on and router-on.
    const managedHelper = "/usr/local/bin/fireconnect --home /tmp/elsewhere key export --stored-only";
    await writeJson(settingsPath, {
      apiKeyHelper: managedHelper,
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant-original" },
    });
    await writeJson(providerStatePath(dataDir), {
      authMode: "apiKeyHelper",
      managedApiKeyHelper: managedHelper,
    });

    await enableFirerouterClaude({
      settingsPath,
      dataDir,
      fireworksKey: "fw_test_key_12345",
      anthropicKey: "sk-ant-test-12345",
      home,
    });

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, undefined, "state-managed helper must be stripped despite recompute drift");
  });

  it("disableFirerouterClaude strips a managed helper via state when home is empty", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-homeless-"));
    const settingsDir = path.join(home, ".claude");
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const managedHelper = "/usr/local/bin/fireconnect key export --stored-only";
    await writeJson(settingsPath, {
      apiKeyHelper: managedHelper,
      env: {
        ANTHROPIC_BASE_URL: FIREROUTER_BASE_URL,
        ANTHROPIC_CUSTOM_HEADERS: "X-FireRouter-Fireworks-Key: fw_test_key_12345",
      },
    });
    await writeJson(providerStatePath(dataDir), {
      authMode: "apiKeyHelper",
      managedApiKeyHelper: managedHelper,
    });

    await disableFirerouterClaude({
      settingsPath,
      dataDir,
      wasEnabled: true,
      routerBaseUrl: FIREROUTER_BASE_URL,
      home: "",
    });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.apiKeyHelper, undefined, "state-based strip must work without home");
  });

  it("disableFirerouterClaude strips a managed helper even when the backup has no topLevel", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-notoplevel-"));
    const settingsDir = path.join(home, ".claude");
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const managedHelper = "/usr/local/bin/fireconnect key export --stored-only";
    await writeJson(settingsPath, {
      apiKeyHelper: managedHelper,
      env: {
        ANTHROPIC_BASE_URL: FIREROUTER_BASE_URL,
        ANTHROPIC_CUSTOM_HEADERS: "X-FireRouter-Fireworks-Key: fw_test_key_12345",
      },
    });
    await writeJson(providerStatePath(dataDir), {
      authMode: "apiKeyHelper",
      managedApiKeyHelper: managedHelper,
    });
    // Pre-fix backup with NO topLevel — the strip must not be gated on it.
    await writeJson(providerBackupPath(dataDir), {
      values: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant-original" },
      missing: [],
    });

    await disableFirerouterClaude({
      settingsPath,
      dataDir,
      wasEnabled: true,
      routerBaseUrl: FIREROUTER_BASE_URL,
      home,
    });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.apiKeyHelper, undefined, "managed helper must be stripped despite missing topLevel");
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
  });

  it("router-on with no anthropic key throws BEFORE tearing down direct mode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-prereq-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    // Establish direct mode (writes managed helper + direct backup + state).
    const directOn = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(directOn.code, 0, directOn.stderr);
    const dataDir = path.join(home, ".fireconnect/claude");
    assert.ok(await readFile(providerBackupPath(dataDir), "utf8").then(() => true).catch(() => false), "direct backup exists before router-on");

    // router-on with no anthropic key and no OAuth (CLAUDE_CONFIG_DIR cleared so
    // claudeCredentialsPath uses the temp home; test keychain blob disabled) in a
    // non-TTY → must throw before the pre-off tears down direct mode.
    const routerOn = await runFireconnect(
      ["claude", "on", "--router"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        CLAUDE_CONFIG_DIR: "",
        FIRECONNECT_TEST_CLAUDE_KEYCHAIN: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.notEqual(routerOn.code, 0, "router-on must fail without an anthropic key");
    assert.match(routerOn.stderr, /No Anthropic API key found/);

    // Direct mode must be intact: managed helper still present, backup still on disk.
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(settings.apiKeyHelper, "direct mode managed helper must NOT be torn down on prereq failure");
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.fireworks.ai/inference", "direct mode env intact");
    assert.ok(await readFile(providerBackupPath(dataDir), "utf8").then(() => true).catch(() => false), "direct backup must still exist");
  });

  it("direct-on with no fireworks key throws BEFORE tearing down router mode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-direct-prereq-"));
    const settingsDir = path.join(home, ".claude");
    const dataDir = path.join(home, ".fireconnect/claude");
    const fireconnectDir = path.join(home, ".fireconnect");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const settingsPath = userSettingsPath(home);

    // Establish router mode manually (no persisted fireworks key) so the
    // subsequent `claude on` finds no key and throws before the pre-off.
    await writeJson(settingsPath, {
      env: {
        ANTHROPIC_BASE_URL: FIREROUTER_BASE_URL,
        ANTHROPIC_CUSTOM_HEADERS: "X-FireRouter-Fireworks-Key: fw_router_key",
      },
    });
    await writeJson(providerBackupPath(dataDir), {
      values: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant-original" },
      missing: [],
      topLevel: { values: { model: "opus" }, missing: [] },
    });
    await writeJson(path.join(fireconnectDir, "config.json"), {
      apiKey: "",
      anthropicApiKey: "",
      routerBaseUrl: FIREROUTER_BASE_URL,
      harnesses: { claude: { enabled: true, mode: "router" } },
    });

    // direct-on with no fireworks key (no flag, env empty, nothing stored) →
    // must throw before the pre-off tears down router mode.
    const directOn = await runFireconnect(
      ["claude", "on"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        CLAUDE_CONFIG_DIR: "",
        FIRECONNECT_TEST_CLAUDE_KEYCHAIN: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.notEqual(directOn.code, 0, "direct-on must fail without a fireworks key");
    assert.match(directOn.stderr, /No Fireworks API key found/);

    // Router mode must be intact: router env still present, backup still on disk.
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, FIREROUTER_BASE_URL, "router mode env must NOT be torn down on prereq failure");
    assert.ok(await readFile(providerBackupPath(dataDir), "utf8").then(() => true).catch(() => false), "firerouter backup must still exist");
  });

  it("on --router infers direct mode from env when config mode is missing (legacy)", async () => {
    // Legacy/partial config: Claude enabled with Fireworks-direct settings but
    // no `mode` field. harnessModeFromConfig returns "" here. Router-on must
    // still tear down direct mode first (strip the managed apiKeyHelper),
    // inferred from the Fireworks env, instead of skipping the pre-off.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-legacy-mode-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const { writeGlobalConfig } = await import("../lib/global-config.mjs");
    const dataDir = path.join(home, ".fireconnect", "claude");

    // Run direct-on first to get a real managed apiKeyHelper + Fireworks env + backup.
    await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    const afterDirect = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(afterDirect.apiKeyHelper, "direct-on set a managed helper");

    // Simulate a legacy config: enabled with no `mode` field.
    await writeGlobalConfig(home, {
      apiKey: "fw_test_key_12345",
      anthropicApiKey: "sk-ant-test-12345",
      routerBaseUrl: "",
      harnesses: { claude: { enabled: true } },
    });

    const routerOn = await runFireconnect(
      ["claude", "on", "--router", "--anthropic-key", "sk-ant-test-12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(routerOn.code, 0, routerOn.stderr);

    const afterRouter = JSON.parse(await readFile(settingsPath, "utf8"));
    // The pre-off must have run (inferred direct mode from the Fireworks env),
    // stripping the managed helper that direct-on left behind.
    assert.equal(afterRouter.apiKeyHelper, undefined, "managed helper stripped despite missing mode field");
    assert.equal(afterRouter.env.ANTHROPIC_BASE_URL, FIREROUTER_BASE_URL);
  });
});
