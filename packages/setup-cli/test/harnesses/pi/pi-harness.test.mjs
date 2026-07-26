import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { piSettingsPath, piAuthPath, piModelsPath, PI_API_KEY_ENV_REF, PI_DATA_RELATIVE_DIR, PI_AZURE_PROVIDER } from "../../../lib/harnesses/pi/core.mjs";
import { resolvePiEffectiveFireworksModel } from "../../../lib/harnesses/pi/fireworks-models.mjs";
import { runFireconnect } from "../../helpers.mjs";

const AZURE_ENDPOINT = "https://msft-fw-foundry-resource.services.ai.azure.com";
const AZURE_KEY = "azure-test-key-1234567890";
const USER_FIREWORKS_MODEL = {
  id: "accounts/fireworks/models/custom-user-model",
  name: "Custom user model",
};

describe("pi harness integration", () => {
  it("re-on preserves and migrates a legacy canonical active model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-reon-model-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });

    const first = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345", "--model", "deepseek-v4-flash"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    assert.equal(settings.defaultModel, "deepseek-v4-flash");
    settings.defaultModel = "accounts/fireworks/models/deepseek-v4-flash";
    await writeFile(piSettingsPath(home), `${JSON.stringify(settings, null, 2)}\n`);

    const second = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(second.code, 0, second.stderr);
    const after = JSON.parse(await readFile(piSettingsPath(home), "utf8")).defaultModel;
    assert.equal(after, "deepseek-v4-flash");
  });

  it("status reports Fireworks as provider and firerouter as model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-firerouter-status-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });

    const on = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345", "--model", "firerouter"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const status = await runFireconnect(["pi", "status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.current.main, "firerouter");
  });

  it("persists --anthropic-api-key in models.json headers for firerouter", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-firerouter-byok-flag-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const anthropicKey = "sk-ant-pi-firerouter-12345";

    const on = await runFireconnect(
      [
        "pi", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "firerouter",
        "--anthropic-api-key", anthropicKey,
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    assert.equal(
      models.providers.fireworks.headers["x-anthropic-api-key"],
      anthropicKey,
    );
  });

  it("registers the preferred latest/newest catalog in models.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-catalog-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const originalModels = JSON.stringify({ providers: { ollama: { models: [{ id: "llama3" }] } } }, null, 2) + "\n";
    await writeFile(piModelsPath(home), originalModels);

    // A Fire Pass key resolves an offline catalog (no network), so the full set
    // registers deterministically.
    const onResult = await runFireconnect(
      ["pi", "on", "--api-key", "fpk_test_firepass_key"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    const fw = models.providers.fireworks;
    const ids = [
      ...(fw.models ?? []).map((m) => m.id),
      ...Object.keys(fw.modelOverrides ?? {}),
    ];
    // Every catalog model is registered for Pi's /model picker...
    assert.ok(ids.includes("glm-fast-latest"));
    assert.ok(ids.includes("glm-latest"));
    assert.ok(ids.includes("kimi-fast-latest"));
    // ...with latest aliases preferred over the pinned versions they cover.
    assert.ok(!ids.includes("glm-5p2-fast"));
    assert.ok(ids.every((id) => !id.startsWith("accounts/fireworks/")));

    const state = JSON.parse(
      await readFile(path.join(home, PI_DATA_RELATIVE_DIR, "state.json"), "utf8"),
    );
    assert.ok(state.managedModelIds.length > 0);
    assert.ok(state.managedModelIds.every((id) => !id.startsWith("accounts/fireworks/")));

    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    // off restores the pre-existing models.json byte-for-byte (fireworks gone).
    assert.equal(await readFile(piModelsPath(home), "utf8"), originalModels);
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
    assert.equal(enabledSettings.defaultModel, "glm-fast-latest");

    const enabledModels = JSON.parse(await readFile(modelsPath, "utf8"));
    const fireworksModels = enabledModels.providers.fireworks.models;
    assert.ok(fireworksModels.some((model) => model.id === "glm-latest"));
    const glmFast = fireworksModels.find((model) => model.id === "glm-5p2-fast");
    assert.ok(glmFast);
    assert.equal(glmFast.contextWindow, 1_048_575);
    assert.equal(glmFast.cost.input, 2.1);
    assert.ok(fireworksModels.every(
      (model) => !model.id.startsWith("accounts/fireworks/"),
    ));
    assert.ok(Object.keys(
      enabledModels.providers.fireworks.modelOverrides ?? {},
    ).every((id) => !id.startsWith("accounts/fireworks/")));
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

  it("writes a literal key into auth.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-env-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const authPath = piAuthPath(home);

    const onResult = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);
    assert.match(onResult.stdout, /Pi → Fireworks · glm-fast-latest/);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(auth.fireworks.key, "fw_test_key_12345");
    assert.equal(auth.fireworks.managedBy, "fireconnect");
  });

  it("adds telemetry without replacing user headers and restores them on off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-headers-"));
    const dir = path.join(home, ".pi/agent");
    await mkdir(dir, { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);
    const originalSettings = '{"defaultProvider":"user"}\n';
    const originalAuth = '{"user":{"key":"keep"}}\n';
    const originalModels = `${JSON.stringify({
      providers: {
        fireworks: {
          headers: {
            "X-User-Trace": "keep",
            "User-Agent": "custom-pi/1.0",
          },
        },
      },
    })}\n`;
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);
    await writeFile(modelsPath, originalModels);

    const first = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    let models = JSON.parse(await readFile(modelsPath, "utf8"));
    let headers = models.providers.fireworks.headers;
    assert.equal(headers["X-User-Trace"], "keep");
    assert.equal(headers["User-Agent"], "custom-pi/1.0");
    assert.equal(headers["X-Title"], "Pi");
    assert.equal(
      headers["HTTP-Referer"],
      "fireconnect/v0.9.0",
    );
    assert.equal(headers["X-FireRouter-Harness"], undefined);
    assert.equal(headers["Fireworks-Use-Case"], undefined);

    headers["User-Agent"] = "fireconnect/0.7.0";
    headers["X-User-After-On"] = "also-keep";
    headers["X-FireRouter-Harness"] = "pi";
    headers["Fireworks-Use-Case"] = "coding";
    headers["HTTP-Referer"] = "fireconnect/v0.7.0";
    await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
    const repeat = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(repeat.code, 0, repeat.stderr);
    models = JSON.parse(await readFile(modelsPath, "utf8"));
    headers = models.providers.fireworks.headers;
    assert.equal(headers["X-User-Trace"], "keep");
    assert.equal(headers["X-User-After-On"], "also-keep");
    assert.equal(headers["User-Agent"], undefined);
    assert.equal(headers["X-Title"], "Pi");
    assert.equal(
      headers["HTTP-Referer"],
      "fireconnect/v0.9.0",
    );
    assert.equal(headers["X-FireRouter-Harness"], undefined);
    assert.equal(headers["Fireworks-Use-Case"], undefined);

    const off = await runFireconnect(
      ["pi", "off"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
    assert.equal(await readFile(modelsPath, "utf8"), originalModels);
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
    assert.match(secondOff.stdout, /was not connected/);

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
          headers: {
            "User-Agent": "fireconnect/0.8.0",
            "X-FireRouter-Harness": "pi",
            "X-Title": "FireConnect/0.8.0",
            "Fireworks-Use-Case": "coding",
            "HTTP-Referer": "fireconnect/v0.8.0",
            "x-routing-preference": "3",
            "X-User-Trace": "keep",
          },
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
    assert.deepEqual(models.providers.fireworks.headers, {
      "X-User-Trace": "keep",
    });
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
          models: [{ id: "accounts/fireworks/routers/glm-latest", name: "GLM Latest" }],
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
              name: "GLM 5.2 Fast",
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
    const env = { HOME: home, FIREWORKS_API_KEY: "" };

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

  it("on with --model glm-5p2-fast keeps Pi catalog context in a complete short row", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-glm-fast-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    const result = await runFireconnect(["pi", "on", "--model", "glm-5p2-fast"], env);
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
    assert.equal(settings.defaultModel, "glm-5p2-fast");

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    const fireworks = models.providers.fireworks;
    const entry = fireworks.models.find((model) => model.id === "glm-5p2-fast");
    assert.equal(entry.name, "GLM 5.2 Fast");
    assert.equal(entry.input[0], "text");
    assert.equal(fireworks.modelOverrides?.["glm-5p2-fast"], undefined);

    const effective = resolvePiEffectiveFireworksModel(
      fireworks,
      "glm-5p2-fast",
    );
    assert.ok(effective.contextWindow >= 1_000_000);
    assert.equal(effective.cost.input, 2.1);
  });

  it("on with --model glm-latest gives non-catalog router 1M context in models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-glm-latest-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    const result = await runFireconnect(["pi", "on", "--model", "glm-latest"], env);
    assert.equal(result.code, 0, result.stderr);

    const models = JSON.parse(await readFile(piModelsPath(home), "utf8"));
    const entry = models.providers.fireworks.models.find(
      (model) => model.id === "glm-latest",
    );
    assert.ok(entry);
    assert.ok(entry.contextWindow >= 1_000_000);

    const effective = resolvePiEffectiveFireworksModel(
      models.providers.fireworks,
      "glm-latest",
    );
    assert.ok(effective.contextWindow >= 1_000_000);
    assert.equal(effective.cost.input, 1.4);
  });

});
