import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_FIREWORKS_PROVIDER_ID,
  opencodeBackupPath,
  opencodeConfigPath,
  opencodeDataDir,
} from "../lib/opencode-core.mjs";
import {
  FALLBACK_FIREROUTER_MAIN_MODEL,
  FIREROUTER_ANTHROPIC_PROVIDER_NAME,
  OPENCODE_ANTHROPIC_PROVIDER_ID,
  firerouterBackupPath,
  firerouterDataDir,
} from "../lib/opencode-firerouter-core.mjs";
import http from "node:http";
import { readJsonIfExists } from "../lib/fireconnect-core.mjs";
import { FIREROUTER_FIREWORKS_HEADER } from "../lib/firerouter-core.mjs";
import { claudeCredentialsPath, opencodeAuthPath } from "../lib/anthropic-enterprise.mjs";
import { GLM_LATEST } from "./helpers.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      // Pin the router default model so router-mode `on` never reaches out to the
      // network for FireRouter's well-known config. Tests that exercise the
      // fetch/fallback path override this with FIRECONNECT_ROUTER_MAIN_MODEL: "".
      env: {
        ...process.env,
        FIRECONNECT_ROUTER_MAIN_MODEL: FALLBACK_FIREROUTER_MAIN_MODEL,
        ANTHROPIC_API_KEY: "sk-ant-test-12345", // pragma: allowlist secret
        ...env,
      },
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

describe("opencode harness integration", () => {
  it("on/off round-trip restores opencode.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.ok(enabled.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
    assert.equal(enabled.provider?.fireworks, undefined);
    const defaultModel = `accounts/fireworks/routers/${GLM_LATEST}`;
    assert.equal(enabled.model, `${OPENCODE_FIREWORKS_PROVIDER_ID}/${defaultModel}`);
    assert.equal(enabled.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models[defaultModel].name, defaultModel);

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("router on prints accurate success output", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-msg-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);
    const output = `${onResult.stdout}\n${onResult.stderr}`;
    assert.match(output, /FireRouter enabled for OpenCode\./);
    assert.match(output, /provider:\s+Anthropic \(FireRouter\)/);
    assert.match(output, /Anthropic key written as \{env:ANTHROPIC_API_KEY\}/);
    assert.doesNotMatch(output, /redirect-only/i);
    assert.doesNotMatch(output, /No Anthropic key set/i);
  });

  it("router on fails without an Anthropic API key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-no-ant-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr + onResult.stdout, /No Anthropic API key found for FireRouter/);
  });

  it("router on works with OpenCode auth.json OAuth without writing an API key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-auth-oauth-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    await mkdir(path.dirname(opencodeAuthPath(home)), { recursive: true });
    await writeFile(
      opencodeAuthPath(home),
      JSON.stringify({ anthropic: { type: "oauth", access: "enterprise-token" } }, null, 2),
    );
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);
    assert.match(onResult.stdout, /auth\.json/i);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const headers = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers ?? {};
    assert.equal(headers["x-api-key"], undefined);
    assert.ok(headers[FIREROUTER_FIREWORKS_HEADER]);
  });

  it("router on works with OpenCode auth.json API key without copying it to opencode.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-auth-apikey-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    await mkdir(path.dirname(opencodeAuthPath(home)), { recursive: true });
    await writeFile(
      opencodeAuthPath(home),
      JSON.stringify({ anthropic: { type: "api", key: "sk-ant-from-opencode-auth" } }, null, 2),
    );
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);
    assert.match(onResult.stdout, /auth\.json/i);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const headers = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers ?? {};
    assert.equal(headers["x-api-key"], undefined);
    assert.ok(headers[FIREROUTER_FIREWORKS_HEADER]);
  });

  it("router on works with Claude OAuth credentials when OpenCode auth.json is absent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-claude-oauth-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      claudeCredentialsPath(home),
      JSON.stringify({ claudeAiOauth: { accessToken: "enterprise-token" } }, null, 2),
    );
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);
    assert.match(onResult.stdout, /enterprise credentials/i);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const headers = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers ?? {};
    assert.equal(headers["x-api-key"], undefined);
    assert.ok(headers[FIREROUTER_FIREWORKS_HEADER]);
  });

  it("router on reuses anthropic provider options.apiKey when no flag or env is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-apikey-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          provider: {
            [OPENCODE_ANTHROPIC_PROVIDER_ID]: {
              options: { apiKey: "sk-ant-test-12345" }, // pragma: allowlist secret
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const headers = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers ?? {};
    assert.equal(headers["x-api-key"], "sk-ant-test-12345"); // pragma: allowlist secret
  });

  it("router on retargets the anthropic provider and leaves model untouched", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    const original = JSON.stringify(
      { model: "anthropic/claude-opus-4-8", provider: {} },
      null,
      2,
    ) + "\n";
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    // No new provider is created.
    assert.equal(enabled.provider?.firerouter, undefined);
    const anthropic = enabled.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID];
    assert.ok(anthropic, "anthropic provider should exist");
    assert.match(anthropic.options.baseURL, /^https:\/\/router\.fireworks\.ai\/v1$/);
    assert.equal(anthropic.options.headers[FIREROUTER_FIREWORKS_HEADER], "fw_test_key_12345");
    assert.equal(anthropic.name, FIREROUTER_ANTHROPIC_PROVIDER_NAME);
    // The user's model selection is preserved — they can switch models in-session.
    assert.equal(enabled.model, "anthropic/claude-opus-4-8");
  });

  it("router on repoints a leftover non-anthropic model at the anthropic provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-leftover-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    // Simulate a leftover model from a prior direct-mode `opencode on`.
    await writeFile(
      configPath,
      JSON.stringify(
        { model: "fireworks-ai/accounts/fireworks/routers/glm-latest", provider: {} },
        null,
        2,
      ) + "\n",
    );

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(enabled.model, `${OPENCODE_ANTHROPIC_PROVIDER_ID}/${FALLBACK_FIREROUTER_MAIN_MODEL}`);
    assert.ok(enabled.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.baseURL);
  });

  it("router on honors --main as the anthropic model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-main-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345", "--main", "claude-sonnet-4-6"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(enabled.model, `${OPENCODE_ANTHROPIC_PROVIDER_ID}/claude-sonnet-4-6`);
  });

  it("router with --anthropic-api-key adds an x-api-key passthrough header", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-ant-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      [
        "opencode", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--anthropic-api-key", "sk-ant-test-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    const headers = enabled.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers ?? {};
    assert.equal(headers[FIREROUTER_FIREWORKS_HEADER], "fw_test_key_12345");
    assert.equal(headers["x-api-key"], "sk-ant-test-12345"); // pragma: allowlist secret
  });

  it("switching router -> direct -> off does not restore FireRouter wiring", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-direct-off-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
    await writeFile(configPath, original);

    const routerOn = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(routerOn.code, 0);

    const directOn = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(directOn.code, 0);

    const directBackupPath = opencodeBackupPath(opencodeDataDir(home), configPath);
    assert.equal((await readJsonIfExists(directBackupPath)).snapshot, undefined);

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(configPath, "utf8"));
    const anthropic = restored.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID];
    assert.equal(anthropic?.options?.baseURL, undefined);
    assert.equal(anthropic?.options?.headers?.[FIREROUTER_FIREWORKS_HEADER], undefined);
    assert.equal(anthropic?.name, undefined);
    assert.equal(restored.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);
  });

  it("switching router -> direct strips FireRouter wiring from the anthropic provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-switch-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const routerOn = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(routerOn.code, 0);

    const directOn = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(directOn.code, 0);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    // Direct mode active, no leftover FireRouter wiring on the anthropic provider.
    assert.ok(config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
    assert.equal(config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID], undefined);
    assert.match(config.model, /^fireworks-ai\//);

    const statusResult = await runFireconnect(["opencode", "status", "--json"], { HOME: home });
    assert.equal(statusResult.code, 0);
    assert.equal(JSON.parse(statusResult.stdout).provider, "fireworks");
  });

  it("switching direct -> router drops the fireworks-ai provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-switch2-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const directOn = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(directOn.code, 0);

    const routerOn = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(routerOn.code, 0);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);
    assert.ok(config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.baseURL);
    assert.equal(config.model, `${OPENCODE_ANTHROPIC_PROVIDER_ID}/${FALLBACK_FIREROUTER_MAIN_MODEL}`);

    const statusResult = await runFireconnect(["opencode", "status", "--json"], { HOME: home });
    assert.equal(JSON.parse(statusResult.stdout).provider, "firerouter");
  });

  it("router off restores the original config even after the model changes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-off-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    const original = JSON.stringify(
      { model: "anthropic/claude-opus-4-8", provider: {} },
      null,
      2,
    ) + "\n";
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    // Simulate the user switching models in-session.
    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    enabled.model = "anthropic/claude-sonnet-4-6";
    await writeFile(configPath, JSON.stringify(enabled, null, 2) + "\n");

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("repeat router on reuses the fireworks key stored on the anthropic provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-repeat-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const firstOn = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, PATH: process.env.PATH },
    );
    assert.equal(firstOn.code, 0);

    await rm(path.join(home, ".fireconnect/config.json"), { force: true });

    const secondOn = await runFireconnect(
      ["opencode", "on", "--router"],
      { HOME: home, PATH: process.env.PATH },
    );
    assert.equal(secondOn.code, 0);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const headers = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers ?? {};
    assert.equal(headers[FIREROUTER_FIREWORKS_HEADER], "fw_test_key_12345");
  });

  it("router on reuses a direct-mode fireworks key when no flag or env is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-reuse-direct-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const directOn = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, PATH: process.env.PATH },
    );
    assert.equal(directOn.code, 0);

    await rm(path.join(home, ".fireconnect/config.json"), { force: true });

    const routerOn = await runFireconnect(
      ["opencode", "on", "--router"],
      { HOME: home, PATH: process.env.PATH },
    );
    assert.equal(routerOn.code, 0);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const headers = config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.options?.headers ?? {};
    assert.equal(headers[FIREROUTER_FIREWORKS_HEADER], "fw_test_key_12345");
    assert.equal(config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);
  });

  it("custom --data-dir keeps direct and router backups in separate subdirs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-datadir-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    const customDataDir = path.join(home, "custom-data");
    const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
    await writeFile(configPath, original);

    const dataDirArg = ["--data-dir", customDataDir];

    const directOn = await runFireconnect(
      ["opencode", "on", ...dataDirArg, "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(directOn.code, 0);

    const directBackupPath = opencodeBackupPath(opencodeDataDir(home, customDataDir), configPath);
    const directBackup = await readJsonIfExists(directBackupPath);
    assert.equal(directBackup.snapshot?.raw, original);

    const routerOn = await runFireconnect(
      ["opencode", "on", "--router", ...dataDirArg, "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(routerOn.code, 0);

    const routerBackupPath = firerouterBackupPath(firerouterDataDir(home, customDataDir), configPath);
    assert.notEqual(directBackupPath, routerBackupPath);
    assert.equal((await readJsonIfExists(directBackupPath)).snapshot?.raw, original);

    const routerOff = await runFireconnect(["opencode", "off", ...dataDirArg], { HOME: home });
    assert.equal(routerOff.code, 0);
    assert.ok(JSON.parse(await readFile(configPath, "utf8")).provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);

    const directOff = await runFireconnect(["opencode", "off", ...dataDirArg], { HOME: home });
    assert.equal(directOff.code, 0);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("router off preserves a pre-existing anthropic provider when no backup exists", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-strip-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    // User already configured an anthropic provider with their own option.
    await writeFile(
      configPath,
      JSON.stringify(
        { provider: { [OPENCODE_ANTHROPIC_PROVIDER_ID]: { options: { apiKey: "sk-ant-user" } } } },
        null,
        2,
      ) + "\n",
    );

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    // Drop the backup so `off` must fall back to stripping only what we own.
    await rm(path.join(home, ".fireconnect/opencode/firerouter"), { recursive: true, force: true });

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(configPath, "utf8"));
    const anthropic = restored.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID];
    assert.ok(anthropic, "user's anthropic provider should survive");
    assert.equal(anthropic.options.apiKey, "sk-ant-user");
    assert.equal(anthropic.options.baseURL, undefined);
    assert.equal(anthropic.options.headers, undefined);
    assert.equal(anthropic.name, undefined);
  });

  it("router off restores a pre-existing provider display name from backup", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-name-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    const original = JSON.stringify(
      {
        model: "anthropic/claude-opus-4-8",
        provider: {
          [OPENCODE_ANTHROPIC_PROVIDER_ID]: {
            name: "My Anthropic",
            options: { apiKey: "sk-ant-user" },
          },
        },
      },
      null,
      2,
    ) + "\n";
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(
      enabled.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.name,
      FIREROUTER_ANTHROPIC_PROVIDER_NAME,
    );

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("switching router -> direct restores a custom anthropic display name", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-router-direct-name-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          model: "anthropic/claude-opus-4-8",
          provider: {
            [OPENCODE_ANTHROPIC_PROVIDER_ID]: {
              name: "My Anthropic",
              options: { apiKey: "sk-ant-user" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const routerOn = await runFireconnect(
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(routerOn.code, 0);

    const directOn = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(directOn.code, 0);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.provider?.[OPENCODE_ANTHROPIC_PROVIDER_ID]?.name, "My Anthropic");
  });

  it("router on derives the default model from FireRouter's well-known config", async () => {
    // Stub FireRouter advertising a non-default model so we prove it's read.
    const server = http.createServer((req, res) => {
      if (req.url === "/.well-known/opencode.json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "firerouter/claude-sonnet-4-6" }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-wellknown-"));
      await mkdir(path.join(home, ".config/opencode"), { recursive: true });
      const configPath = opencodeConfigPath(home);
      await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

      const onResult = await runFireconnect(
        ["opencode", "on", "--router", "--api-key", "fw_test_key_12345", "--base-url", `http://127.0.0.1:${port}`],
        { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", FIRECONNECT_ROUTER_MAIN_MODEL: "" },
      );
      assert.equal(onResult.code, 0);

      const enabled = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(enabled.model, `${OPENCODE_ANTHROPIC_PROVIDER_ID}/claude-sonnet-4-6`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("router on falls back to the bundled default when the well-known fetch fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-wellknown-fail-"));
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      // Closed port -> fetch refused -> bundled fallback.
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345", "--base-url", "http://127.0.0.1:1"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", FIRECONNECT_ROUTER_MAIN_MODEL: "" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(enabled.model, `${OPENCODE_ANTHROPIC_PROVIDER_ID}/${FALLBACK_FIREROUTER_MAIN_MODEL}`);
  });

  it("FIRECONNECT_ROUTER_MAIN_MODEL overrides the default without a network call", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-env-override-"));
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ provider: {} }, null, 2) + "\n");

    const onResult = await runFireconnect(
      // Closed port: if the env override weren't honored, the fetch would fail
      // and we'd get the bundled fallback instead of this value.
      ["opencode", "on", "--router", "--api-key", "fw_test_key_12345", "--base-url", "http://127.0.0.1:1"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", FIRECONNECT_ROUTER_MAIN_MODEL: "claude-haiku-4-5" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(enabled.model, `${OPENCODE_ANTHROPIC_PROVIDER_ID}/claude-haiku-4-5`);
  });
});
