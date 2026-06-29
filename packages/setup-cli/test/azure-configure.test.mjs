import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { globalConfigPath } from "../lib/global-config.mjs";
import { OPENCODE_AZURE_PROVIDER_ID, opencodeConfigPath } from "../lib/opencode-core.mjs";
import { codexConfigPath } from "../lib/codex-core.mjs";
import { PI_AZURE_PROVIDER, piModelsPath, piSettingsPath } from "../lib/pi-core.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");
const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com/openai/v1/chat/completions";
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
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-azure-cfg-"));
  try {
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function configureAzure(home, extraArgs = [], env = {}) {
  return runFireconnect(
    ["configure", "--harnesses", "opencode,codex,pi", "--provider", "azure", "--base-url", AZURE_ENDPOINT, ...extraArgs],
    { HOME: home, ...env },
  );
}

describe("configure azure endpoint (top-level provider)", () => {
  it("stores the normalized endpoint, key, and provider in global config", async () => {
    await withHome(async (home) => {
      const result = await configureAzure(home, ["--api-key", AZURE_KEY]);
      assert.equal(result.code, 0, result.stderr);

      const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.equal(config.provider, "azure");
      assert.equal(config.azure.baseUrl, AZURE_BASE_URL);
      assert.equal(config.azure.apiKey, AZURE_KEY);
    });
  });

  it("fails when azure is selected without an endpoint", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["configure", "--harnesses", "opencode", "--provider", "azure", "--api-key", AZURE_KEY],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Azure endpoint/);
    });
  });

  it("rejects an unknown provider", async () => {
    await withHome(async (home) => {
      const result = await runFireconnect(
        ["configure", "--harnesses", "opencode", "--provider", "bedrock"],
        { HOME: home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--provider must be one of/);
    });
  });
});

describe("harness on leverages the configured azure provider (no flags)", () => {
  it("opencode on routes through the configured Foundry endpoint", async () => {
    await withHome(async (home) => {
      assert.equal((await configureAzure(home, ["--api-key", AZURE_KEY])).code, 0);
      const on = await runFireconnect(["opencode", "on"], { HOME: home });
      assert.equal(on.code, 0, on.stderr);

      const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
      const provider = config.provider[OPENCODE_AZURE_PROVIDER_ID];
      assert.ok(provider);
      assert.equal(provider.options.baseURL, AZURE_BASE_URL);
      assert.equal(provider.options.apiKey, AZURE_KEY);
      assert.equal(config.model, `${OPENCODE_AZURE_PROVIDER_ID}/FW-GLM-5.1`);
    });
  });

  it("codex on routes through the configured Foundry endpoint", async () => {
    await withHome(async (home) => {
      assert.equal((await configureAzure(home, ["--api-key", AZURE_KEY])).code, 0);
      const on = await runFireconnect(["codex", "on"], { HOME: home });
      assert.equal(on.code, 0, on.stderr);

      const toml = await readFile(codexConfigPath(home), "utf8");
      assert.match(toml, /model_provider = "fireworks-azure"/);
      assert.match(toml, new RegExp(`base_url = "${AZURE_BASE_URL.replace(/[.]/g, "\\.")}"`));
      assert.match(toml, /experimental_bearer_token = "azure-test-key-1234567890"/);
    });
  });

  it("pi on routes through the configured Foundry endpoint", async () => {
    await withHome(async (home) => {
      assert.equal((await configureAzure(home, ["--api-key", AZURE_KEY])).code, 0);
      const on = await runFireconnect(["pi", "on"], { HOME: home });
      assert.equal(on.code, 0, on.stderr);

      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultProvider, PI_AZURE_PROVIDER);
      const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.equal(models.providers[PI_AZURE_PROVIDER].baseUrl, AZURE_BASE_URL);
      assert.equal(models.providers[PI_AZURE_PROVIDER].apiKey, AZURE_KEY);
    });
  });

  it("uses the AZURE_API_KEY env reference when configure stored no key", async () => {
    await withHome(async (home) => {
      assert.equal((await configureAzure(home)).code, 0);
      const on = await runFireconnect(["opencode", "on"], { HOME: home, AZURE_API_KEY: AZURE_KEY });
      assert.equal(on.code, 0, on.stderr);
      const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
      assert.equal(config.provider[OPENCODE_AZURE_PROVIDER_ID].options.apiKey, "{env:AZURE_API_KEY}");
    });
  });

  it("setHarnessEnabled preserves the configured provider/endpoint", async () => {
    await withHome(async (home) => {
      assert.equal((await configureAzure(home, ["--api-key", AZURE_KEY])).code, 0);
      assert.equal((await runFireconnect(["opencode", "on"], { HOME: home })).code, 0);
      // After `on` wrote harness-enabled state, the global config must still
      // carry the azure provider + endpoint.
      const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.equal(config.provider, "azure");
      assert.equal(config.azure.baseUrl, AZURE_BASE_URL);
      assert.equal(config.harnesses.opencode.enabled, true);
    });
  });
});
