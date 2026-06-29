import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OPENCODE_AZURE_PROVIDER_ID,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  opencodeConfigPath,
} from "../lib/opencode-core.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");
const AZURE_ENDPOINT = "https://my-res.services.ai.azure.com";
const AZURE_BASE_URL = "https://my-res.services.ai.azure.com/openai/v1";
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
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-oc-azure-"));
  try {
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("opencode azure harness", () => {
  it("writes a Foundry provider block with a literal key (--api-key)", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
      await writeFile(configPath, original);

      const result = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      const provider = config.provider[OPENCODE_AZURE_PROVIDER_ID];
      assert.ok(provider, "azure provider should exist");
      assert.equal(provider.npm, "@ai-sdk/openai-compatible");
      assert.equal(provider.options.baseURL, AZURE_BASE_URL);
      assert.equal(provider.options.apiKey, AZURE_KEY);
      assert.equal(config.model, `${OPENCODE_AZURE_PROVIDER_ID}/FW-GLM-5.1`);
      assert.ok(provider.models["FW-GLM-5.1"]);
      assert.equal(config.provider[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);
    });
  });

  it("normalizes a portal project endpoint and honors --main", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      const result = await runFireconnect(
        [
          "opencode", "on", "--azure",
          "--base-url", "https://r.services.ai.azure.com/api/projects/msft-fw-foundry",
          "--api-key", AZURE_KEY,
          "--main", "FW-MiniMax-M2.5",
        ],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      const provider = config.provider[OPENCODE_AZURE_PROVIDER_ID];
      assert.equal(provider.options.baseURL, "https://r.services.ai.azure.com/openai/v1");
      assert.equal(config.model, `${OPENCODE_AZURE_PROVIDER_ID}/FW-MiniMax-M2.5`);
    });
  });

  it("uses {env:AZURE_API_KEY} when the key comes from the environment", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      const result = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(
        config.provider[OPENCODE_AZURE_PROVIDER_ID].options.apiKey,
        "{env:AZURE_API_KEY}",
      );
    });
  });

  it("fails without a base URL", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      const result = await runFireconnect(
        ["opencode", "on", "--azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint/);
    });
  });

  it("re-on without --base-url reuses the stored endpoint and applies --main", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      assert.equal(
        (await runFireconnect(
          ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );

      // Re-on with only --main (no --base-url, no global configure).
      const reon = await runFireconnect(
        ["opencode", "on", "--azure", "--main", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.provider[OPENCODE_AZURE_PROVIDER_ID].options.baseURL, AZURE_BASE_URL);
      assert.equal(config.provider[OPENCODE_AZURE_PROVIDER_ID].options.apiKey, AZURE_KEY);
      assert.equal(config.model, `${OPENCODE_AZURE_PROVIDER_ID}/FW-MiniMax-M2.5`);
    });
  });

  it("rejects a reused {env:AZURE_API_KEY} reference when AZURE_API_KEY is unset", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      // First on with the env var set stores the {env:AZURE_API_KEY} reference.
      const first = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(first.code, 0, first.stderr);
      const stored = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(stored.provider[OPENCODE_AZURE_PROVIDER_ID].options.apiKey, "{env:AZURE_API_KEY}");

      // Re-on with the env var unset must fail rather than write a dead ref.
      const second = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: "" },
      );
      assert.notEqual(second.code, 0);
      assert.match(second.stderr, /No Azure API key/);
    });
  });

  it("on/off round-trip restores the original config byte-for-byte", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      const original = JSON.stringify(
        { model: "openai/gpt-4", provider: { openai: { options: { apiKey: "sk-x" } } } },
        null,
        2,
      ) + "\n";
      await writeFile(configPath, original);

      const on = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(on.code, 0, on.stderr);

      const off = await runFireconnect(["opencode", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);

      const restored = await readFile(configPath, "utf8");
      assert.equal(restored, original);
    });
  });

  it("status reports the azure provider and endpoint", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({}, null, 2) + "\n");

      await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );

      const status = await runFireconnect(["opencode", "status", "--json"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.hasAuthToken, true);
      assert.equal(payload.current.main, "FW-GLM-5.1");
    });
  });

  it("switching from Fireworks to Azure replaces the provider and preserves the original backup", async () => {
    await withHome(async (home) => {
      const configPath = opencodeConfigPath(home);
      const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
      await writeFile(configPath, original);

      const fwOn = await runFireconnect(
        ["opencode", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
      );
      assert.equal(fwOn.code, 0, fwOn.stderr);

      const azOn = await runFireconnect(
        ["opencode", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(azOn.code, 0, azOn.stderr);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.ok(config.provider[OPENCODE_AZURE_PROVIDER_ID]);
      assert.equal(config.provider[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);

      const off = await runFireconnect(["opencode", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);
      const restored = await readFile(configPath, "utf8");
      assert.equal(restored, original);
    });
  });
});
