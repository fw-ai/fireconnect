import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userSettingsPath } from "../lib/fireconnect-core.mjs";
import { FIREROUTER_BASE_URL } from "../lib/firerouter-core.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
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
});
