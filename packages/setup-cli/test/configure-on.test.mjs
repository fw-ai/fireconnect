import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIREWORKS_API_KEY_ENV_REF, globalConfigPath, writeGlobalConfig } from "../lib/global-config.mjs";
import { piAuthPath } from "../lib/pi-core.mjs";
import { opencodeConfigPath } from "../lib/opencode-core.mjs";
import { codexConfigPath } from "../lib/codex-core.mjs";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../lib/fireconnect-core.mjs";
import { claudeCredentialsPath } from "../lib/anthropic-enterprise.mjs";
import { MISSING_ANTHROPIC_KEY_MESSAGE } from "../lib/firerouter-core.mjs";
import { runFireconnect, seedKeychainConfig } from "./helpers.mjs";

describe("configure to harness on propagation", () => {
  it("pi on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-pi-on-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["pi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0);

    const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
  });

  it("pi on writes the plaintext key when only FIREWORKS_API_KEY is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-pi-env-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });

    const onResult = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
  });

  it("pi on fails with guidance when no key is available", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-pi-missing-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });

    const onResult = await runFireconnect(["pi", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr, new RegExp(MISSING_FIREWORKS_API_KEY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("pi on accepts legacy global env ref when FIREWORKS_API_KEY is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-pi-legacy-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_ENV_REF,
      harnesses: { pi: { enabled: false } },
    });

    const onResult = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
  });

  it("opencode on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-oc-on-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["opencode", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0, onResult.stderr);

    const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
    assert.equal(config.provider["fireworks-ai"].options.apiKey, "fw_test_key_12345");
  });

  it("codex on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-codex-on-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0);

    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /env_key = "FIREWORKS_API_KEY"/);
    assert.doesNotMatch(config, /experimental_bearer_token/);
  });

  it("deepagents on reads keychain key from configure global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-deepagents-on-"));
    await mkdir(path.join(home, ".deepagents"), { recursive: true });
    await seedKeychainConfig(home, "fw_test_key_12345");

    const onResult = await runFireconnect(["deepagents", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(onResult.code, 0);

    const config = await readFile(path.join(home, ".deepagents/config.toml"), "utf8");
    assert.match(config, /api_key_env = "FIREWORKS_API_KEY"/);
    assert.match(config, /base_url = "https:\/\/api\.fireworks\.ai\/inference"/);
  });

  it("deepagents on fails with guidance when configure stored no key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-deepagents-missing-"));
    await mkdir(path.join(home, ".deepagents"), { recursive: true });

    const onResult = await runFireconnect(["deepagents", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr, new RegExp(MISSING_FIREWORKS_API_KEY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("on --anthropic-api-key persists the key to global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-on-persist-anthropic-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });

    const onResult = await runFireconnect(
      [
        "claude", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--anthropic-api-key", "sk-ant-global-key-12345",
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(globalConfig.anthropicApiKey, "sk-ant-global-key-12345");
  });

  it("rejects invalid --anthropic-api-key without persisting to global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-on-invalid-anthropic-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });

    const onResult = await runFireconnect(
      [
        "claude", "on", "--router",
        "--api-key", "fw_test_key_12345",
        "--anthropic-api-key", "fw_not_anthropic",
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr, /sk-ant-/);

    const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(globalConfig.anthropicApiKey ?? "", "");
  });

  it("claude on --router fails without an Anthropic key or enterprise credentials", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-router-no-anthropic-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: "fw_test_key_12345",
      harnesses: { claude: { enabled: false } },
    });

    const onResult = await runFireconnect(
      ["claude", "on", "--router"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(onResult.code, 0);
    assert.match(onResult.stderr + onResult.stdout, new RegExp(MISSING_ANTHROPIC_KEY_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("claude on --router works with enterprise credentials file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-router-enterprise-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      claudeCredentialsPath(home),
      JSON.stringify({ claudeAiOauth: { accessToken: "enterprise-token" } }, null, 2),
    );
    await writeGlobalConfig(home, {
      apiKey: "fw_test_key_12345",
      harnesses: { claude: { enabled: false } },
    });

    const onResult = await runFireconnect(
      ["claude", "on", "--router"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.match(settings.env.ANTHROPIC_BASE_URL, /router\.fireworks\.ai/);
    assert.match(onResult.stdout, /enterprise credentials/i);
  });

  it("claude on --router reads Anthropic key from global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-router-global-anthropic-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: "fw_test_key_12345",
      anthropicApiKey: "sk-ant-from-global-12345",
      harnesses: { claude: { enabled: false } },
    });

    const onResult = await runFireconnect(
      ["claude", "on", "--router"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-from-global-12345");
  });

  it("on --api-key persists the key to global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-on-persist-global-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_new_global_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(globalConfig.apiKey, "{keychain:fireworks-api-key}");
  });

  it("on without --api-key does not overwrite global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-on-no-global-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });
    await writeGlobalConfig(home, {
      apiKey: "fw_existing_global_key_12345",
      harnesses: { opencode: { enabled: false } },
    });

    const onResult = await runFireconnect(
      ["opencode", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_env_only_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(globalConfig.apiKey, "{keychain:fireworks-api-key}");
  });

  it("opencode on writes the plaintext key when only FIREWORKS_API_KEY is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-oc-env-"));
    await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });

    const onResult = await runFireconnect(
      ["opencode", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
    assert.equal(config.provider["fireworks-ai"].options.apiKey, "fw_test_key_12345");
  });
});
