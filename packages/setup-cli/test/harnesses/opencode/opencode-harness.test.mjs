import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_AZURE_PROVIDER_ID,
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  opencodeBackupPath,
  opencodeConfigPath,
  opencodeDataDir,
} from "../../../lib/harnesses/opencode/core.mjs";
import { readJsonIfExists } from "../../../lib/io/json.mjs";
import { GLM_FAST_LATEST } from "../../helpers.mjs";

const CLI = path.join(import.meta.dirname, "..", "..", "..", "bin", "fireconnect.mjs");

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        FIRECONNECT_SECRET_STORE: "memory",
        ANTHROPIC_API_KEY: "sk-ant-test-12345", // pragma: allowlist secret
        FIRECONNECT_TEST: "1",
        ...env,
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
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
      [
        "opencode",
        "on",
        "--api-key",
        "fw_test_key_12345",
        "--model",
        "accounts/fireworks/routers/glm-fast-latest",
      ],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);
    assert.match(onResult.stdout, /OpenCode → Fireworks · glm-fast-latest/);
    assert.doesNotMatch(onResult.stdout, /Tip:|Next →|firerouter --anthropic-api-key/);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.ok(enabled.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
    assert.equal(enabled.provider?.fireworks, undefined);
    const defaultModel = GLM_FAST_LATEST;
    assert.equal(enabled.model, `${OPENCODE_FIREWORKS_PROVIDER_ID}/${defaultModel}`);
    assert.equal(enabled.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models[defaultModel].name, "GLM 5.2 Fast (Latest)");

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("adds telemetry without replacing user headers and restores them on off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-headers-"));
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = `${JSON.stringify({
      model: "fireworks-ai/accounts/fireworks/routers/glm-fast-latest",
      provider: {
        [OPENCODE_FIREWORKS_PROVIDER_ID]: {
          options: {
            apiKey: OPENCODE_API_KEY_ENV_REF,
            headers: {
              "X-User-Trace": "keep",
              "User-Agent": "custom-client/1.0",
            },
          },
        },
      },
    })}\n`;
    await writeFile(configPath, original);

    const first = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    let config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/glm-fast-latest");
    assert.ok(config.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models["glm-fast-latest"]);
    assert.equal(
      config.provider[OPENCODE_FIREWORKS_PROVIDER_ID]
        .models["accounts/fireworks/routers/glm-fast-latest"],
      undefined,
    );
    let headers = config.provider[OPENCODE_FIREWORKS_PROVIDER_ID].options.headers;
    assert.equal(headers["X-User-Trace"], "keep");
    assert.equal(headers["User-Agent"], "custom-client/1.0");
    assert.equal(headers["X-Title"], "OpenCode");
    assert.equal(
      headers["HTTP-Referer"],
      "fireconnect/v0.9.0",
    );
    assert.equal(headers["X-FireRouter-Harness"], undefined);
    assert.equal(headers["Fireworks-Use-Case"], undefined);

    headers["User-Agent"] = "fireconnect/0.7.0";
    headers["X-User-After-On"] = "also-keep";
    headers["X-FireRouter-Harness"] = "opencode";
    headers["Fireworks-Use-Case"] = "coding";
    headers["HTTP-Referer"] = "fireconnect/v0.7.0";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const repeat = await runFireconnect(
      ["opencode", "on"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(repeat.code, 0, repeat.stderr);
    config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/glm-fast-latest");
    headers = config.provider[OPENCODE_FIREWORKS_PROVIDER_ID].options.headers;
    assert.equal(headers["X-User-Trace"], "keep");
    assert.equal(headers["X-User-After-On"], "also-keep");
    assert.equal(headers["User-Agent"], undefined);
    assert.equal(headers["X-Title"], "OpenCode");
    assert.equal(
      headers["HTTP-Referer"],
      "fireconnect/v0.9.0",
    );
    assert.equal(headers["X-FireRouter-Harness"], undefined);
    assert.equal(headers["Fireworks-Use-Case"], undefined);

    const off = await runFireconnect(
      ["opencode", "off"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("registers router overrides in the provider but not models.dev catalog entries", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-catalog-"));
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n");

    // A Fire Pass key resolves an offline catalog (no network), so the full set
    // registers deterministically.
    const onResult = await runFireconnect(
      ["opencode", "on", "--api-key", "fpk_test_firepass_key"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    const models = enabled.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models;
    const ids = Object.keys(models);
    // Latest router aliases need provider overrides; models.dev entries do not.
    assert.ok(ids.includes("glm-fast-latest"));
    assert.ok(ids.includes("glm-latest"));
    assert.ok(ids.includes("kimi-fast-latest"));
    assert.deepEqual(
      models["kimi-fast-latest"].modalities,
      { input: ["text", "image"] },
    );
    assert.equal(models["glm-fast-latest"].modalities, undefined);
    assert.ok(!ids.includes("glm-5p2-fast"));
    assert.ok(!ids.includes("kimi-k2p7-code-fast"));
    assert.equal(enabled.model, `${OPENCODE_FIREWORKS_PROVIDER_ID}/glm-fast-latest`);

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    const restored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(restored.provider[OPENCODE_FIREWORKS_PROVIDER_ID], undefined);
  });

  it("rebuilds the model set on re-on so stale catalog entries don't accumulate", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-rebuild-"));
    await mkdir(path.join(home, ".config/opencode"), { recursive: true });
    const configPath = opencodeConfigPath(home);
    await writeFile(configPath, JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n");

    // First on registers the Fire Pass catalog.
    let on = await runFireconnect(["opencode", "on", "--api-key", "fpk_test_firepass_key"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(on.code, 0, on.stderr);

    // Simulate a model that was registered previously but is no longer in the catalog.
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const staleId = "accounts/fireworks/models/removed-from-catalog";
    config.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models[staleId] = { name: staleId };
    config.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models["deepseek-v4-flash"] = { name: "deepseek-v4-flash" };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

    // Re-on rebuilds from the current catalog — stale and catalog-model entries drop.
    on = await runFireconnect(["opencode", "on", "--api-key", "fpk_test_firepass_key"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(on.code, 0, on.stderr);
    const models = JSON.parse(await readFile(configPath, "utf8")).provider[OPENCODE_FIREWORKS_PROVIDER_ID].models;
    assert.equal(Object.keys(models).includes(staleId), false, "stale model should be dropped on re-on");
    assert.equal(Object.keys(models).includes("deepseek-v4-flash"), false, "catalog model should not be duplicated");
    assert.ok(Object.keys(models).includes("glm-fast-latest"));
  });

  it("custom --data-dir keeps a single backup across model switches; off restores the original", async () => {
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
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(directOn.code, 0);

    const backupPath = opencodeBackupPath(opencodeDataDir(home, customDataDir), configPath);
    assert.equal((await readJsonIfExists(backupPath)).snapshot?.raw, original);

    const routerOn = await runFireconnect(
      ["opencode", "on", "--model", "firerouter", ...dataDirArg, "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(routerOn.code, 0);
    assert.equal((await readJsonIfExists(backupPath)).snapshot?.raw, original);

    const off = await runFireconnect(["opencode", "off", ...dataDirArg], { HOME: home });
    assert.equal(off.code, 0);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal((await readJsonIfExists(backupPath)).snapshot, undefined);
  });

  it("persists --anthropic-api-key in provider headers for firerouter", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-firerouter-byok-flag-"));
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const anthropicKey = "sk-ant-opencode-firerouter-12345";

    const on = await runFireconnect(
      [
        "opencode", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "firerouter",
        "--anthropic-api-key", anthropicKey,
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(
      config.provider[OPENCODE_FIREWORKS_PROVIDER_ID].options.headers["x-anthropic-api-key"],
      anthropicKey,
    );
  });

  it("off without a backup strips Azure routing but preserves user providers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-strip-azure-"));
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      provider: {
        user: { options: { baseURL: "https://user.example/v1" } },
        [OPENCODE_AZURE_PROVIDER_ID]: {
          options: {
            baseURL: "https://foundry.example/openai/v1",
            apiKey: "az-test",
          },
        },
      },
      model: `${OPENCODE_AZURE_PROVIDER_ID}/FW-GLM-5.2`,
    }, null, 2)}\n`);

    const off = await runFireconnect(["opencode", "off"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /restored to your previous setup/);
    const after = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(after, {
      provider: {
        user: { options: { baseURL: "https://user.example/v1" } },
      },
    });
  });

  it("off strips an inactive managed provider without touching the user's model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-strip-inactive-"));
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      provider: {
        user: { options: { baseURL: "https://user.example/v1" } },
        [OPENCODE_AZURE_PROVIDER_ID]: {
          options: {
            baseURL: "https://foundry.example/openai/v1",
            apiKey: "az-test",
          },
        },
      },
      model: "user/custom",
    }, null, 2)}\n`);

    const off = await runFireconnect(["opencode", "off"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(off.code, 0, off.stderr);
    const after = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(after.model, "user/custom");
    assert.deepEqual(after.provider, {
      user: { options: { baseURL: "https://user.example/v1" } },
    });
  });

  it("off reports unchanged and preserves an unrelated config byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-off-unchanged-"));
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = `${JSON.stringify({
      provider: { user: { options: { baseURL: "https://user.example/v1" } } },
      model: "user/custom",
    }, null, 2)}\n`;
    await writeFile(configPath, original);

    const off = await runFireconnect(["opencode", "off"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /was not connected/);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("does not attach provider BYOK when firerouter is auto-cataloged but not selected", async () => {
    const { createServer } = await import("node:http");
    const gateway = await new Promise((resolve) => {
      const server = createServer((req, res) => {
        if (req.url === "/verifyApiKey") {
          res.writeHead(200, {
            "x-fireworks-developer-email": "test@example.com",
            "x-fireworks-account-id": "acct-workspace-byok",
          });
          res.end();
          return;
        }
        if (/^\/v1\/accounts\/[^/]+\/featureFlags$/.test(req.url ?? "")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            featureFlags: [{
              name: "accounts/acct-workspace-byok/featureFlags/enable-workspace-byok",
              value: "true",
            }],
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
    });
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-catalog-byok-"));
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      const on = await runFireconnect(
        ["opencode", "on", "--api-key", "fw_test_key_12345", "--model", "glm-fast-latest"],
        {
          HOME: home,
          FIREWORKS_API_KEY: "",
          ANTHROPIC_API_KEY: "sk-ant-should-not-attach-12345",
          FIRECONNECT_GATEWAY_URL: gateway.url,
          FIRECONNECT_GATEWAY_GRPC_WEB_URL: `${gateway.url}/grpc`,
        },
      );
      assert.equal(on.code, 0, on.stderr);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const headers = config.provider[OPENCODE_FIREWORKS_PROVIDER_ID].options.headers ?? {};
      assert.equal(headers["x-anthropic-api-key"], undefined);
    } finally {
      gateway.server.close();
    }
  });
});
