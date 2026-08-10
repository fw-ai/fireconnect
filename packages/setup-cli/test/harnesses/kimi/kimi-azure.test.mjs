import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { kimiConfigPath } from "../../../lib/harnesses/kimi/core.mjs";

const CLI = path.join(import.meta.dirname, "..", "..", "..", "bin", "fireconnect.mjs");
const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_BASE_URL = "https://msft-fw-foundry-resource.services.ai.azure.com/openai/v1";
const AZURE_KEY = "azure-test-key-1234567890";

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FIREWORKS_API_KEY: "", AZURE_API_KEY: "", FIRECONNECT_SECRET_STORE: "memory", FIRECONNECT_TEST: "1", ...env },
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

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-kimi-azure-"));
  try {
    await mkdir(path.join(home, ".kimi-code"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("kimi azure harness", () => {
  it("writes a fireworks-azure provider table with a literal api_key (--api-key)", async () => {
    await withHome(async (home) => {
      const configPath = kimiConfigPath(home);
      const result = await runFireconnect(
        ["kimi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--model", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /default_model = "fireworks-azure\/FW-MiniMax-M2\.5"/);
      assert.match(toml, /\[providers\.fireworks-azure\]/);
      assert.match(toml, /type = "openai"/);
      assert.match(toml, new RegExp(`base_url = "${AZURE_BASE_URL.replace(/[.]/g, "\\.")}"`));
      assert.match(toml, /\[models\."fireworks-azure\/FW-MiniMax-M2\.5"\]/);
      assert.match(toml, /model = "FW-MiniMax-M2\.5"/);
      assert.match(toml, /api_key = "azure-test-key-1234567890"/);
      assert.doesNotMatch(toml, /accounts\/fireworks/);
    });
  });

  it("bakes a literal api_key when the key comes from the environment", async () => {
    await withHome(async (home) => {
      const configPath = kimiConfigPath(home);
      const result = await runFireconnect(
        ["kimi", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /api_key = "azure-test-key-1234567890"/);
      assert.doesNotMatch(toml, /api_key_env/);
    });
  });

  it("fails without a base URL", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["kimi", "on", "--azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint/);
    });
  });

  it("on/off round-trip restores the original config byte-for-byte", async () => {
    await withHome(async (home) => {
      const configPath = kimiConfigPath(home);
      const original = [
        'default_model = "kimi-code/k3"',
        "",
        "[tui]",
        'theme = "dark"',
        "",
      ].join("\n");
      await writeFile(configPath, original);

      const on = await runFireconnect(
        ["kimi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(on.code, 0, on.stderr);

      const off = await runFireconnect(["kimi", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);

      const restored = await readFile(configPath, "utf8");
      assert.equal(restored, original);
    });
  });

  it("status reports the azure provider and endpoint", async () => {
    await withHome(async (home) => {
      await runFireconnect(
        ["kimi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      const status = await runFireconnect(["kimi", "status", "--json"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.modelProvider, "fireworks-azure");
      assert.equal(payload.hasAuthToken, true);
      assert.equal(payload.current.main, "FW-GLM-5.2");

      const human = await runFireconnect(["kimi", "status"], { HOME: home });
      assert.equal(human.code, 0, human.stderr);
      assert.match(human.stdout, /Auth: stored in config/);
    });
  });

  it("re-on without --base-url reuses the stored endpoint and applies --model", async () => {
    await withHome(async (home) => {
      const configPath = kimiConfigPath(home);
      assert.equal(
        (await runFireconnect(
          ["kimi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );

      const reon = await runFireconnect(
        ["kimi", "on", "--azure", "--model", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, new RegExp(`base_url = "${AZURE_BASE_URL.replace(/[.]/g, "\\.")}"`));
      assert.match(toml, /default_model = "fireworks-azure\/FW-MiniMax-M2\.5"/);
    });
  });

  it("switching from the Fireworks gateway to Azure does not inherit the gateway model", async () => {
    await withHome(async (home) => {
      const configPath = kimiConfigPath(home);
      const fwOn = await runFireconnect(
        ["kimi", "on", "--api-key", "fw_test_key_12345", "--model", "glm-5p1"],
        { HOME: home, FIREWORKS_API_KEY: "" },
      );
      assert.equal(fwOn.code, 0, fwOn.stderr);

      const azOn = await runFireconnect(
        ["kimi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(azOn.code, 0, azOn.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /default_model = "fireworks-azure\/FW-GLM-5\.2"/);
      assert.doesNotMatch(toml, /glm-5p1/);
    });
  });

  it("switching from Azure back to the gateway replaces the provider and drops the azure key", async () => {
    await withHome(async (home) => {
      const configPath = kimiConfigPath(home);
      await runFireconnect(
        ["kimi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", "az-secret-xyz-999"],
        { HOME: home },
      );
      const fwOn = await runFireconnect(
        ["kimi", "on"],
        { HOME: home, FIREWORKS_API_KEY: "fw_env_key_12345" },
      );
      assert.equal(fwOn.code, 0, fwOn.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.doesNotMatch(toml, /\[providers\.fireworks-azure\]/);
      assert.doesNotMatch(toml, /az-secret-xyz-999/);
      assert.match(toml, /api_key = "fw_env_key_12345"/);
      assert.match(toml, /default_model = "fireworks\/kimi-fast-latest"/);
      assert.doesNotMatch(toml, /FW-GLM-5\.2/);
    });
  });
});
