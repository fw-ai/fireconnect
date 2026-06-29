import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PI_AZURE_PROVIDER, piSettingsPath, piModelsPath } from "../lib/pi-core.mjs";

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
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-azure-"));
  try {
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("pi azure harness", () => {
  it("registers a custom openai-completions provider with a literal key (--api-key)", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY, "--main", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);

      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultProvider, PI_AZURE_PROVIDER);
      assert.equal(settings.defaultModel, "FW-MiniMax-M2.5");

      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      const provider = models.providers[PI_AZURE_PROVIDER];
      assert.equal(provider.api, "openai-completions");
      assert.equal(provider.baseUrl, AZURE_BASE_URL);
      assert.equal(provider.authHeader, true);
      assert.equal(provider.apiKey, AZURE_KEY);
      assert.deepEqual(provider.models, [{ id: "FW-MiniMax-M2.5" }]);
    });
  });

  it("normalizes a portal project endpoint and defaults the model", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        [
          "pi", "on", "--azure",
          "--base-url", "https://r.services.ai.azure.com/api/projects/p",
          "--api-key", AZURE_KEY,
        ],
        { HOME: home },
      );
      assert.equal(result.code, 0, result.stderr);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER].baseUrl, "https://r.services.ai.azure.com/openai/v1");
      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultModel, "FW-GLM-5.1");
    });
  });

  it("uses $AZURE_API_KEY when the key comes from the environment", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT],
        { HOME: home, AZURE_API_KEY: AZURE_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER].apiKey, "$AZURE_API_KEY");
    });
  });

  it("fails without a base URL", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["pi", "on", "--azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint/);
    });
  });

  it("on/off round-trip restores the original settings and models byte-for-byte", async () => {
    await withHome(async (home) => {
      const settingsPath = piSettingsPath(home);
      const modelsPath = piModelsPath(home);
      const originalSettings = JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude" }, null, 2) + "\n";
      const originalModels = JSON.stringify({ providers: { ollama: { baseUrl: "http://x/v1", api: "openai-completions" } } }, null, 2) + "\n";
      await writeFile(settingsPath, originalSettings);
      await writeFile(modelsPath, originalModels);

      const on = await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.equal(on.code, 0, on.stderr);

      const off = await runFireconnect(["pi", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);

      assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
      assert.equal(await readFile(modelsPath, "utf8"), originalModels);
    });
  });

  it("re-on without --base-url reuses the stored endpoint and applies --main", async () => {
    await withHome(async (home) => {
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );

      const reon = await runFireconnect(
        ["pi", "on", "--azure", "--main", "FW-MiniMax-M2.5"],
        { HOME: home },
      );
      assert.equal(reon.code, 0, reon.stderr);

      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultModel, "FW-MiniMax-M2.5");
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER].baseUrl, AZURE_BASE_URL);
    });
  });

  it("status hasAuthToken reflects the AZURE_API_KEY env var for env-referenced keys", async () => {
    await withHome(async (home) => {
      // Store the $AZURE_API_KEY reference (env-mode on).
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT],
          { HOME: home, AZURE_API_KEY: AZURE_KEY },
        )).code,
        0,
      );

      const withEnv = await runFireconnect(["pi", "status", "--json"], { HOME: home, AZURE_API_KEY: AZURE_KEY });
      assert.equal(JSON.parse(withEnv.stdout).hasAuthToken, true);

      const withoutEnv = await runFireconnect(["pi", "status", "--json"], { HOME: home, AZURE_API_KEY: "" });
      assert.equal(JSON.parse(withoutEnv.stdout).hasAuthToken, false);
    });
  });

  it("switching from Azure to the Fireworks gateway drops the fireworks-azure provider", async () => {
    await withHome(async (home) => {
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );
      const fw = await runFireconnect(
        ["pi", "on", "--api-key", "fw_test_key_12345"],
        { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
      );
      assert.equal(fw.code, 0, fw.stderr);

      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER], undefined);
    });
  });

  it("azure on -> fireworks on -> off restores the original config byte-for-byte", async () => {
    await withHome(async (home) => {
      const settingsPath = piSettingsPath(home);
      const modelsPath = piModelsPath(home);
      const origSettings = JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude" }, null, 2) + "\n";
      const origModels = JSON.stringify(
        { providers: { ollama: { baseUrl: "http://x/v1", api: "openai-completions" } } },
        null,
        2,
      ) + "\n";
      await writeFile(settingsPath, origSettings);
      await writeFile(modelsPath, origModels);

      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
          { HOME: home },
        )).code,
        0,
      );
      assert.equal(
        (await runFireconnect(
          ["pi", "on", "--api-key", "fw_test_key_12345"],
          { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
        )).code,
        0,
      );
      assert.equal((await runFireconnect(["pi", "off"], { HOME: home })).code, 0);

      // off must restore the genuine pre-FireConnect config, not the Azure state.
      assert.equal(await readFile(settingsPath, "utf8"), origSettings);
      assert.equal(await readFile(modelsPath, "utf8"), origModels);
    });
  });

  it("status reports the azure provider and endpoint", async () => {
    await withHome(async (home) => {
      await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        { HOME: home },
      );
      const status = await runFireconnect(["pi", "status", "--json"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.provider, "azure");
      assert.equal(payload.baseUrl, AZURE_BASE_URL);
      assert.equal(payload.defaultProvider, PI_AZURE_PROVIDER);
      assert.equal(payload.hasAuthToken, true);
      assert.equal(payload.current.main, "FW-GLM-5.1");
    });
  });
});
