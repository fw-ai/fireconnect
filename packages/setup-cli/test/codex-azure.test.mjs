import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { codexConfigPath } from "../lib/codex-core.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");
const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_BASE_URL = "https://msft-fw-foundry-resource.services.ai.azure.com/openai/v1";
const AZURE_KEY = "azure-test-key-1234567890";

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FIREWORKS_API_KEY: "", AZURE_API_KEY: "", ...env },
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
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-azure-"));
  try {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("codex azure harness", () => {
  it("writes a Foundry provider table with wire_api chat and a literal bearer (--api-key)", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      const result = await runFireconnect(
        ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--main", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /model_provider = "fireworks-azure"/);
      assert.match(toml, /model = "FW-MiniMax-M2\.5"/);
      assert.match(toml, /\[model_providers\.fireworks-azure\]/);
      assert.match(toml, new RegExp(`base_url = "${AZURE_BASE_URL.replace(/[.]/g, "\\.")}"`));
      assert.match(toml, /wire_api = "chat"/);
      assert.match(toml, /experimental_bearer_token = "azure-test-key-1234567890"/);
      assert.doesNotMatch(toml, /fireworks-ai/);
    });
  });

  it("normalizes a portal project endpoint to the resource-root base", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      const result = await runFireconnect(
        [
          "codex", "on", "--azure",
          "--base-url", "https://r.services.ai.azure.com/api/projects/msft-fw-foundry",
          "--api-key", AZURE_KEY,
        ],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);
      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /base_url = "https:\/\/r\.services\.ai\.azure\.com\/openai\/v1"/);
      assert.match(toml, /model = "FW-GLM-5\.1"/);
    });
  });

  it("uses env_key AZURE_API_KEY when the key comes from the environment", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      const result = await runFireconnect(
        ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /env_key = "AZURE_API_KEY"/);
      assert.doesNotMatch(toml, /experimental_bearer_token/);
    });
  });

  it("fails without a base URL", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["codex", "on", "--azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint/);
    });
  });

  it("on/off round-trip restores the original config byte-for-byte", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      const original = [
        'model = "o3"',
        "",
        "[mcp_servers.example]",
        'command = "node"',
        "",
      ].join("\n");
      await writeFile(configPath, original);

      const on = await runFireconnect(
        ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(on.code, 0, on.stderr);

      const off = await runFireconnect(["codex", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);

      const restored = await readFile(configPath, "utf8");
      assert.equal(restored, original);
    });
  });

  it("status reports the azure provider and endpoint", async () => {
    await withHome(async (home) => {
      await runFireconnect(
        ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      const status = await runFireconnect(["codex", "status", "--json"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.modelProvider, "fireworks-azure");
      assert.equal(payload.hasAuthToken, true);
      assert.equal(payload.current.main, "FW-GLM-5.1");
    });
  });

  it("re-on without --base-url reuses the stored endpoint and applies --main", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      assert.equal(
        (await runFireconnect(
          ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );

      const reon = await runFireconnect(
        ["codex", "on", "--azure", "--main", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, new RegExp(`base_url = "${AZURE_BASE_URL.replace(/[.]/g, "\\.")}"`));
      assert.match(toml, /model = "FW-MiniMax-M2\.5"/);
    });
  });

  it("switching from the Fireworks gateway to Azure does not inherit the gateway model", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      const fwOn = await runFireconnect(
        ["codex", "on", "--api-key", "fw_test_key_12345", "--main", "glm-5p1"],
        { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
      );
      assert.equal(fwOn.code, 0, fwOn.stderr);

      // Switch to Azure WITHOUT --main: must fall back to the Foundry default,
      // not carry over the gateway catalog id (glm-5p1).
      const azOn = await runFireconnect(
        ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(azOn.code, 0, azOn.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /model = "FW-GLM-5\.1"/);
      assert.doesNotMatch(toml, /model = "glm-5p1"/);
    });
  });

  it("treats a non-Azure proxy endpoint as managed (status + off work)", async () => {
    await withHome(async (home) => {
      const proxyBase = "https://gateway.example.com/openai/v1";
      const on = await runFireconnect(
        ["codex", "on", "--azure", "--base-url", "https://gateway.example.com", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(on.code, 0, on.stderr);

      const status = await runFireconnect(["codex", "status", "--json"], { HOME: home });
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, proxyBase);
      assert.equal(payload.hasAuthToken, true);

      const off = await runFireconnect(["codex", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);
      assert.equal(existsSync(codexConfigPath(home)), false);
    });
  });

  it("switching from Azure to the gateway does not inherit the Foundry deployment as a model", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      assert.equal(
        (await runFireconnect(
          ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--main", "FW-MiniMax-M2.5"],
          { HOME: home },
        )).code,
        0,
      );
      const fw = await runFireconnect(
        ["codex", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
      );
      assert.equal(fw.code, 0, fw.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /model_provider = "fireworks-ai"/);
      // Must fall back to the gateway default, not accounts/fireworks/models/FW-MiniMax-M2.5.
      assert.doesNotMatch(toml, /FW-MiniMax-M2\.5/);
    });
  });

  it("switching from Azure to the gateway does not reuse the Azure key as the Fireworks key", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      assert.equal(
        (await runFireconnect(
          ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", "az-secret-xyz-999"],
          { HOME: home },
        )).code,
        0,
      );
      const fw = await runFireconnect(
        ["codex", "on"],
        { HOME: home, FIREWORKS_API_KEY: "fw_env_key_12345" },
      );
      assert.equal(fw.code, 0, fw.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.doesNotMatch(toml, /az-secret-xyz-999/);
      assert.match(toml, /env_key = "FIREWORKS_API_KEY"/);
    });
  });

  it("switching from Azure back to the Fireworks gateway replaces the provider", async () => {
    await withHome(async (home) => {
      const configPath = codexConfigPath(home);
      await runFireconnect(
        ["codex", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      const fwOn = await runFireconnect(
        ["codex", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
      );
      assert.equal(fwOn.code, 0, fwOn.stderr);

      const toml = await readFile(configPath, "utf8");
      assert.match(toml, /model_provider = "fireworks-ai"/);
      assert.doesNotMatch(toml, /\[model_providers\.fireworks-azure\]/);
      assert.equal(existsSync(configPath), true);
    });
  });
});
