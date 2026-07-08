import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { piSettingsPath, piAuthPath, piModelsPath, PI_API_KEY_ENV_REF, PI_DATA_RELATIVE_DIR, PI_AZURE_PROVIDER } from "../lib/pi-core.mjs";
import { resolvePiEffectiveFireworksModel } from "../lib/pi-fireworks-models.mjs";
import { FALLBACK_FIREROUTER_MAIN_MODEL } from "../lib/firerouter-core.mjs";
import { runFireconnect, seedKeychainConfig, withoutEnvFireworksKey } from "./helpers.mjs";

const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_KEY = "azure-test-key-1234567890";
const USER_FIREWORKS_MODEL = {
  id: "accounts/fireworks/models/custom-user-model",
  name: "Custom user model",
};

describe("pi harness integration", () => {
  it("router on retargets the built-in Anthropic provider and reports status", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };

    const result = await runFireconnect(["pi", "on", "--router"], env);
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    assert.equal(settings.defaultProvider, "anthropic");
    assert.equal(settings.defaultModel, "claude-opus-4-8");

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.equal(models.providers.anthropic.name, "Anthropic (FireRouter)");
    assert.equal(models.providers.anthropic.baseUrl, "https://router.fireworks.ai");
    assert.equal(models.providers.anthropic.compat.sendSessionAffinityHeaders, true);
    assert.equal(
      models.providers.anthropic.headers["X-FireRouter-Fireworks-Key"],
      "fw_test_key_12345",
    );

    const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
    assert.equal(auth.anthropic.key, "sk-ant-test-12345"); // pragma: allowlist secret
    assert.equal(auth.anthropic.managedBy, "fireconnect");

    const status = await runFireconnect(["pi", "status", "--json"], env);
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.provider, "anthropic");
    assert.equal(payload.mode, "router");
    assert.equal(payload.firerouterConfigured, true);
    assert.equal(payload.routingActive, true);
    assert.equal(payload.baseUrl, "https://router.fireworks.ai");
    assert.equal(payload.current.main, "claude-opus-4-8");
  });

  it("router on repoints a leftover Fireworks model when defaultProvider is anthropic", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-leftover-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
      FIRECONNECT_ROUTER_MAIN_MODEL: "",
    };
    await writeFile(piSettingsPath(home), `${JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "accounts/fireworks/routers/glm-latest",
    }, null, 2)}\n`);

    const result = await runFireconnect(["pi", "on", "--router"], env);
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    assert.equal(settings.defaultProvider, "anthropic");
    assert.equal(settings.defaultModel, FALLBACK_FIREROUTER_MAIN_MODEL);
  });

  it("router mode rejects --main and --model selection flags", async () => {
    for (const flag of ["--main", "--model"]) {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-model-flag-"));
      const result = await runFireconnect(
        ["pi", "on", "--router", flag, "claude-sonnet-4-6"],
        {
          HOME: home,
          FIREWORKS_API_KEY: "fw_test_key_12345",
          ANTHROPIC_API_KEY: "sk-ant-test-12345",
        },
      );
      assert.equal(result.code, 1);
      assert.match(result.stderr, /not supported with Pi router mode/);
      assert.match(result.stderr, /Choose Anthropic models inside Pi with \/model/);
      assert.match(result.stderr, /turn off router mode first by running `fireconnect pi on`/);
    }
  });

  it("reports FireRouter as configured but inactive after Pi selects another provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-inactive-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };

    assert.equal((await runFireconnect(["pi", "on", "--router"], env)).code, 0);
    await writeFile(piSettingsPath(home), `${JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    }, null, 2)}\n`);
    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    models.providers.openai = { baseUrl: "https://api.openai.com/v1" };
    await writeFile(piModelsPath(home), `${JSON.stringify(models, null, 2)}\n`);

    const status = await runFireconnect(["pi", "status", "--json"], env);
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.provider, "openai");
    assert.equal(payload.firerouterConfigured, true);
    assert.equal(payload.routingActive, false);
    assert.equal(payload.baseUrl, "https://api.openai.com/v1");
    assert.equal(payload.current.main, "gpt-5");

    const textStatus = await runFireconnect(["pi", "status"], env);
    assert.match(textStatus.stdout, /FireRouter configured: yes/);
    assert.match(textStatus.stdout, /Routing active: no/);
    assert.match(textStatus.stdout, /Active provider: openai/);
    assert.match(textStatus.stdout, /Active model: gpt-5/);
    assert.match(textStatus.stdout, /Base URL: https:\/\/api\.openai\.com\/v1/);
  });

  it("labels an inactive built-in provider URL as Pi's default when it has no override", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-default-url-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };

    assert.equal((await runFireconnect(["pi", "on", "--router"], env)).code, 0);
    await writeFile(piSettingsPath(home), `${JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    }, null, 2)}\n`);

    const status = await runFireconnect(["pi", "status", "--json"], env);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.routingActive, false);
    assert.equal(payload.baseUrl, null);

    const textStatus = await runFireconnect(["pi", "status"], env);
    assert.match(textStatus.stdout, /Base URL: \(Pi provider default\)/);
  });

  it("re-on after switching away from anthropic does not overwrite router backup", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-reon-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);
    const originalSettings = `${JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5" }, null, 2)}\n`;
    const originalAuth = `${JSON.stringify({ openai: { type: "api_key", key: "sk-user" } }, null, 2)}\n`;
    const originalModels = `${JSON.stringify({ providers: { ollama: { models: [{ id: "llama3" }] } } }, null, 2)}\n`;
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);
    await writeFile(modelsPath, originalModels);
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };

    assert.equal((await runFireconnect(["pi", "on", "--router"], env)).code, 0);
    await writeFile(settingsPath, `${JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-5",
    }, null, 2)}\n`);

    assert.equal((await runFireconnect(["pi", "on", "--router"], env)).code, 0);
    assert.equal((await runFireconnect(["pi", "off"], env)).code, 0);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
    assert.equal(await readFile(modelsPath, "utf8"), originalModels);
  });

  it("router on/off restores settings, auth, and models byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-restore-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);
    const originalSettings = `${JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5" }, null, 2)}\n`;
    const originalAuth = `${JSON.stringify({ openai: { type: "api_key", key: "sk-user" } }, null, 2)}\n`;
    const originalModels = `${JSON.stringify({ providers: { ollama: { models: [{ id: "llama3" }] } } }, null, 2)}\n`;
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);
    await writeFile(modelsPath, originalModels);
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };

    assert.equal((await runFireconnect(["pi", "on", "--router"], env)).code, 0);
    assert.equal((await runFireconnect(["pi", "off"], env)).code, 0);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
    assert.equal(await readFile(modelsPath, "utf8"), originalModels);
  });

  it("switches router to direct without preserving router wiring", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-direct-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };

    assert.equal((await runFireconnect(["pi", "on", "--router"], env)).code, 0);
    assert.equal((await runFireconnect(["pi", "on"], env)).code, 0);

    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
    assert.equal(settings.defaultProvider, "fireworks");
    assert.equal(models.providers.anthropic, undefined);
    assert.equal(auth.anthropic, undefined);
  });

  it("router mode rejects FireConnect model commands after Pi selects another provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-model-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };
    assert.equal((await runFireconnect(["pi", "on", "--router"], env)).code, 0);

    await writeFile(piSettingsPath(home), `${JSON.stringify({
      defaultProvider: "fireworks",
      defaultModel: "accounts/fireworks/routers/glm-latest",
    }, null, 2)}\n`);

    const reset = await runFireconnect(["pi", "model", "reset"], env);
    assert.equal(reset.code, 1);
    assert.match(reset.stderr, /does not apply in --router mode/);
    assert.match(reset.stderr, /turn off router mode first by running `fireconnect pi on`/);

    const select = await runFireconnect(["pi", "model", "select"], env);
    assert.equal(select.code, 1);
    assert.match(select.stderr, /does not apply in --router mode/);
    assert.match(select.stderr, /turn off router mode first by running `fireconnect pi on`/);

    const list = await runFireconnect(["pi", "model", "list"], env);
    assert.equal(list.code, 1);
    assert.match(list.stderr, /does not apply in --router mode/);
    assert.match(list.stderr, /turn off router mode first by running `fireconnect pi on`/);
  });

  it("strips a trailing /v1 from --base-url so Pi's SDK doesn't double it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-v1-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      ANTHROPIC_API_KEY: "sk-ant-test-12345",
    };

    const result = await runFireconnect(
      ["pi", "on", "--router", "--base-url", "https://router.fireworks.ai/v1"],
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.equal(models.providers.anthropic.baseUrl, "https://router.fireworks.ai");
  });

  it("router on requires Anthropic authentication", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-no-anthropic-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const result = await runFireconnect(
      ["pi", "on", "--router"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No Anthropic API key found for FireRouter/);
  });

  it("router off without backups strips only FireConnect-owned provider fields", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-router-strip-"));
    const agentDir = path.join(home, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(piSettingsPath(home), `${JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
    }, null, 2)}\n`);
    await writeFile(piAuthPath(home), `${JSON.stringify({
      anthropic: {
        type: "api_key",
        key: "$ANTHROPIC_API_KEY",
        managedBy: "fireconnect",
      },
    }, null, 2)}\n`);
    await writeFile(piModelsPath(home), `${JSON.stringify({
      providers: {
        anthropic: {
          name: "Anthropic (FireRouter)",
          baseUrl: "https://router.fireworks.ai/v1",
          compat: {
            sendSessionAffinityHeaders: true,
            supportsCacheControlOnTools: true,
          },
          headers: {
            "X-FireRouter-Fireworks-Key": "$FIREWORKS_API_KEY",
            "x-user-header": "keep-me",
          },
          modelOverrides: { "claude-opus-4-8": { name: "My Opus" } },
        },
      },
    }, null, 2)}\n`);

    const result = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.equal(settings.defaultProvider, undefined);
    assert.equal(settings.defaultModel, undefined);
    assert.equal(models.providers.anthropic.baseUrl, undefined);
    assert.equal(models.providers.anthropic.name, undefined);
    assert.equal(models.providers.anthropic.compat.sendSessionAffinityHeaders, undefined);
    assert.equal(models.providers.anthropic.compat.supportsCacheControlOnTools, true);
    assert.equal(models.providers.anthropic.headers["X-FireRouter-Fireworks-Key"], undefined);
    assert.equal(models.providers.anthropic.headers["x-user-header"], "keep-me");
    assert.equal(models.providers.anthropic.modelOverrides["claude-opus-4-8"].name, "My Opus");
  });

  it("on/off round-trip restores settings and auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-"));
    const settingsDir = path.join(home, ".pi/agent");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);
    const originalSettings = JSON.stringify({ defaultProvider: "openai" }, null, 2) + "\n";
    const originalAuth = JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2) + "\n";
    const originalModels = JSON.stringify({ providers: { ollama: { models: [{ id: "llama3" }] } } }, null, 2) + "\n";
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);
    await writeFile(modelsPath, originalModels);

    const onResult = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const enabledSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabledSettings.defaultProvider, "fireworks");
    assert.ok(enabledSettings.defaultModel.startsWith("accounts/fireworks/"));

    const enabledModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const fireworksModels = enabledModels.providers.fireworks.models;
    assert.ok(fireworksModels.some((model) => model.id === "accounts/fireworks/routers/glm-latest"));
    assert.equal(
      fireworksModels.some((model) => model.id === "accounts/fireworks/routers/glm-5p2-fast"),
      false,
    );
    assert.equal(
      enabledModels.providers.fireworks.modelOverrides["accounts/fireworks/routers/glm-5p2-fast"].name,
      "GLM 5.2 Fast via Fireworks",
    );
    assert.equal(enabledModels.providers.fireworks.compat.sendSessionAffinityHeaders, true);

    const enabledAuth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(enabledAuth.fireworks.managedBy, "fireconnect");
    assert.equal(enabledAuth.fireworks.key, "fw_test_key_12345");

    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restoredSettings = await readFile(settingsPath, "utf8");
    const restoredAuth = await readFile(authPath, "utf8");
    const restoredModels = await readFile(modelsPath, "utf8");
    assert.equal(restoredSettings, originalSettings);
    assert.equal(restoredAuth, originalAuth);
    assert.equal(restoredModels, originalModels);
  });

  it("writes the resolved key as plaintext into auth.json (from environment)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-env-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const authPath = piAuthPath(home);

    const onResult = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);
    assert.match(onResult.stdout, /auth\.json/);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
    assert.equal(auth.fireworks.managedBy, "fireconnect");
  });

  it("second off after on/off round-trip leaves settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-double-off-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const originalSettings = JSON.stringify({ defaultProvider: "openai" }, null, 2) + "\n";
    const originalAuth = JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2) + "\n";
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);

    await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    await runFireconnect(["pi", "off"], { HOME: home });

    const secondOff = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(secondOff.code, 0);
    assert.match(secondOff.stdout, /not enabled for Pi/);

    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
  });

  it("off removes models.json when it did not exist before on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-no-models-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const modelsPath = piModelsPath(home);
    await writeFile(settingsPath, `${JSON.stringify({ defaultProvider: "openai" }, null, 2)}\n`);

    await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.ok((await readFile(modelsPath, "utf8")).includes("glm-latest"));

    await runFireconnect(["pi", "off"], { HOME: home });

    let modelsMissing = false;
    try {
      await readFile(modelsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        modelsMissing = true;
      } else {
        throw error;
      }
    }
    assert.ok(modelsMissing);
  });

  it("on enables x-session-affinity via provider compat on direct Fireworks path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-session-affinity-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    const result = await runFireconnect(["pi", "on"], env);
    assert.equal(result.code, 0, result.stderr);

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.equal(models.providers.fireworks.compat.sendSessionAffinityHeaders, true);
  });

  it("switching from Fireworks gateway to Azure strips managed compat from a remaining user fireworks provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-azure-compat-"));
    const modelsPath = piModelsPath(home);
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await writeFile(modelsPath, `${JSON.stringify({
      providers: { fireworks: { models: [USER_FIREWORKS_MODEL] } },
    }, null, 2)}\n`);
    const env = {
      HOME: home,
      FIREWORKS_API_KEY: "fw_test_key_12345",
      AZURE_API_KEY: AZURE_KEY,
    };

    assert.equal((await runFireconnect(["pi", "on"], env)).code, 0);
    assert.equal(
      (await runFireconnect(
        ["pi", "on", "--azure", "--base-url", AZURE_ENDPOINT, "--api-key", AZURE_KEY],
        env,
      )).code,
      0,
    );

    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.ok(models.providers[PI_AZURE_PROVIDER]);
    assert.equal(models.providers.fireworks.compat?.sendSessionAffinityHeaders, undefined);
    assert.ok(models.providers.fireworks.models.some(
      (model) => model.id === USER_FIREWORKS_MODEL.id,
    ));
  });

  it("off without backups strips session-affinity compat when managed models are already gone", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-strip-compat-"));
    const agentDir = path.join(home, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);

    await writeFile(settingsPath, `${JSON.stringify({
      defaultProvider: "fireworks",
      defaultModel: USER_FIREWORKS_MODEL.id,
    }, null, 2)}\n`);
    await writeFile(authPath, `${JSON.stringify({
      fireworks: { type: "api_key", key: PI_API_KEY_ENV_REF, managedBy: "fireconnect" },
    }, null, 2)}\n`);
    await writeFile(modelsPath, `${JSON.stringify({
      providers: {
        fireworks: {
          compat: { sendSessionAffinityHeaders: true, supportsCacheControlOnTools: true },
          models: [USER_FIREWORKS_MODEL],
        },
      },
    }, null, 2)}\n`);
    await writeFile(path.join(home, PI_DATA_RELATIVE_DIR, "state.json"), `${JSON.stringify({ enabled: true })}\n`);

    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    assert.equal(models.providers.fireworks.compat.sendSessionAffinityHeaders, undefined);
    assert.equal(models.providers.fireworks.compat.supportsCacheControlOnTools, true);
    assert.deepEqual(models.providers.fireworks.models, [USER_FIREWORKS_MODEL]);
  });

  it("off without backups strips managed models.json entries", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-strip-models-"));
    const agentDir = path.join(home, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);

    await writeFile(settingsPath, `${JSON.stringify({
      defaultProvider: "fireworks",
      defaultModel: "accounts/fireworks/routers/glm-latest",
    }, null, 2)}\n`);
    await writeFile(authPath, `${JSON.stringify({
      fireworks: { type: "api_key", key: PI_API_KEY_ENV_REF, managedBy: "fireconnect" },
    }, null, 2)}\n`);
    await writeFile(modelsPath, `${JSON.stringify({
      providers: {
        fireworks: {
          compat: { sendSessionAffinityHeaders: true },
          models: [{ id: "accounts/fireworks/routers/glm-latest", name: "GLM Latest via Fireworks" }],
        },
      },
    }, null, 2)}\n`);
    await writeFile(path.join(home, PI_DATA_RELATIVE_DIR, "state.json"), `${JSON.stringify({ enabled: true })}\n`);

    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    let modelsMissing = false;
    try {
      await readFile(modelsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        modelsMissing = true;
      } else {
        throw error;
      }
    }
    assert.ok(modelsMissing);
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultProvider, undefined);
  });

  it("off without backups strips managed modelOverrides entries", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-strip-overrides-"));
    const agentDir = path.join(home, ".pi/agent");
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);

    await writeFile(settingsPath, `${JSON.stringify({
      defaultProvider: "fireworks",
      defaultModel: "accounts/fireworks/routers/glm-5p2-fast",
    }, null, 2)}\n`);
    await writeFile(authPath, `${JSON.stringify({
      fireworks: { type: "api_key", key: PI_API_KEY_ENV_REF, managedBy: "fireconnect" },
    }, null, 2)}\n`);
    await writeFile(modelsPath, `${JSON.stringify({
      providers: {
        fireworks: {
          compat: { sendSessionAffinityHeaders: true },
          modelOverrides: {
            "accounts/fireworks/routers/glm-5p2-fast": {
              name: "GLM 5.2 Fast via Fireworks",
              reasoning: true,
            },
          },
        },
      },
    }, null, 2)}\n`);
    await writeFile(path.join(home, PI_DATA_RELATIVE_DIR, "state.json"), `${JSON.stringify({
      enabled: true,
      managedModelIds: ["accounts/fireworks/routers/glm-5p2-fast"],
    })}\n`);

    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    let modelsMissing = false;
    try {
      await readFile(modelsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        modelsMissing = true;
      } else {
        throw error;
      }
    }
    assert.ok(modelsMissing);
  });

  it("status reflects fireworks while enabled and default after off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-status-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    await writeFile(settingsPath, `${JSON.stringify({ defaultProvider: "openai" }, null, 2)}\n`);

    await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    const onStatus = await runFireconnect(["pi", "status", "--json"], { HOME: home });
    assert.equal(onStatus.code, 0);
    assert.match(onStatus.stdout, /"provider": "fireworks"/);

    await runFireconnect(["pi", "off"], { HOME: home });
    const offStatus = await runFireconnect(["pi", "status", "--json"], { HOME: home });
    assert.equal(offStatus.code, 0);
    assert.match(offStatus.stdout, /"provider": "default"/);
    assert.doesNotMatch(offStatus.stdout, /"defaultProvider": "fireworks"/);
  });

  it("re-on after data dir wipe snapshots so off can restore", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-wipe-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    await writeFile(settingsPath, `${JSON.stringify({ defaultProvider: "openai" }, null, 2)}\n`);
    await writeFile(authPath, `${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2)}\n`);

    await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], env);
    const beforeReOnSettings = await readFile(settingsPath, "utf8");
    const beforeReOnAuth = await readFile(authPath, "utf8");

    await rm(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true, force: true });

    await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], env);
    await runFireconnect(["pi", "off"], env);

    assert.equal(await readFile(settingsPath, "utf8"), beforeReOnSettings);
    assert.equal(await readFile(authPath, "utf8"), beforeReOnAuth);
  });

  it("on with --main glm-5p2-fast keeps Pi catalog context via modelOverrides", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-glm-fast-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    const result = await runFireconnect(["pi", "on", "--main", "glm-5p2-fast"], env);
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    assert.equal(settings.defaultModel, "accounts/fireworks/routers/glm-5p2-fast");

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    const fireworks = models.providers.fireworks;
    assert.equal(
      fireworks.models?.some((model) => model.id === "accounts/fireworks/routers/glm-5p2-fast"),
      false,
    );
    assert.equal(
      fireworks.modelOverrides["accounts/fireworks/routers/glm-5p2-fast"].name,
      "GLM 5.2 Fast via Fireworks",
    );

    const effective = resolvePiEffectiveFireworksModel(
      fireworks,
      "accounts/fireworks/routers/glm-5p2-fast",
    );
    assert.ok(effective.contextWindow >= 1_000_000);
    assert.equal(effective.cost.input, 2.1);
  });

  it("on with --main glm-latest gives non-catalog router 1M context in models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-glm-latest-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    const result = await runFireconnect(["pi", "on", "--main", "glm-latest"], env);
    assert.equal(result.code, 0, result.stderr);

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    const entry = models.providers.fireworks.models.find(
      (model) => model.id === "accounts/fireworks/routers/glm-latest",
    );
    assert.ok(entry);
    assert.ok(entry.contextWindow >= 1_000_000);

    const effective = resolvePiEffectiveFireworksModel(
      models.providers.fireworks,
      "accounts/fireworks/routers/glm-latest",
    );
    assert.ok(effective.contextWindow >= 1_000_000);
    assert.equal(effective.cost.input, 1.4);
  });

  it("model reset keeps resolved keychain key when FIREWORKS_API_KEY env is unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-reset-keychain-"));
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await seedKeychainConfig(home, "fw_test_key_12345");
      const env = { HOME: home, FIREWORKS_API_KEY: "" };

      const onResult = await runFireconnect(["pi", "on"], env);
      assert.equal(onResult.code, 0, onResult.stderr);

      const resetResult = await runFireconnect(["pi", "model", "reset"], env);
      assert.equal(resetResult.code, 0, resetResult.stderr);

      const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
      assert.equal(auth.fireworks?.key, "fw_test_key_12345");
    });
  });
});
