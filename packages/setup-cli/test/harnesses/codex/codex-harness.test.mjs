import { mkdtemp, readFile, writeFile, mkdir, unlink, access, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexBackupPath, codexConfigPath, codexDataDir } from "../../../lib/harnesses/codex/core.mjs";
import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { writeJson } from "../../../lib/io/json.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import { FPK_KEY, FW_CODEX_KEY, runFireconnect, seedKeychainConfig, withoutEnvFireworksKey, writeCodexConfig } from "../../helpers.mjs";

describe("codex harness integration", () => {
  it("firerouter can be selected explicitly without local Anthropic credentials", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-firerouter-manual-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      [
        "codex",
        "on",
        "--api-key",
        "fw_test_key_12345",
        "--model",
        "accounts/fireworks/routers/firerouter",
      ],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /model = "firerouter"/);
    assert.match(config, /model_provider = "fireworks-ai"/);
  });

  it("plain on succeeds without Anthropic credentials when firerouter is not requested", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-plain-on-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(codexConfigPath(home), "utf8"), /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(result.stderr, /ANTHROPIC_API_KEY or workspace BYOK/);
  });

  it("rejects MiniMax models with an explanatory error", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-minimax-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "minimax-m3"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MiniMax is not supported with Codex/);
    assert.match(result.stderr, /Responses API/);
    assert.match(result.stderr, /tool_calls/);
  });

  it("rejects re-on when config already has a MiniMax model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-minimax-reon-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      'model_provider = "fireworks-ai"',
      'model = "minimax-m3"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "fw_test_key_12345"',
      "requires_openai_auth = false",
      "",
    ].join("\n"));

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MiniMax is not supported with Codex/);
    assert.match(result.stderr, /Responses API/);
  });

  it("does not attach env BYOK when firerouter is auto-cataloged but not selected", async () => {
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
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-byok-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const result = await runFireconnect(
        ["codex", "on", "--api-key", "fw_test_key_12345"],
        {
          HOME: home,
          FIREWORKS_API_KEY: "",
          ANTHROPIC_API_KEY: "sk-ant-should-not-attach-12345",
          FIRECONNECT_GATEWAY_URL: gateway.url,
          FIRECONNECT_GATEWAY_GRPC_WEB_URL: `${gateway.url}/grpc`,
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /model = "glm-fast-latest"/);
      assert.doesNotMatch(config, /env_http_headers = \{ "x-anthropic-api-key"/);
    } finally {
      gateway.server.close();
    }
  });

  it("firerouter exposes a configured Anthropic key through Codex's env header", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-firerouter-stored-byok-"));
    await seedKeychainConfig(home, "fw_test_key_12345");
    await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-stored" });

    const result = await runFireconnect(
      ["codex", "on", "--model", "firerouter"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        SHELL: "/bin/bash",
        ZSH_VERSION: "",
        BASH_VERSION: "5",
      },
    );
    assert.equal(result.code, 0, result.stderr);

    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /env_http_headers = \{ "x-anthropic-api-key" = "ANTHROPIC_API_KEY" \}/);
    const shellConfig = process.platform === "darwin" ? ".bash_profile" : ".bashrc";
    const shell = await readFile(path.join(home, shellConfig), "utf8");
    assert.match(shell, /export ANTHROPIC_API_KEY=/);
    assert.match(shell, /key export --stored-only --anthropic/);
    assert.doesNotMatch(shell, /sk-ant-stored/);
  });

  it("on/off round-trip restores config.toml", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-"));
    const configDir = path.join(home, ".codex");
    await mkdir(configDir, { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
      "",
      "[[mcp_servers]]",
      'name = "test"',
      'command = "echo"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /model_provider = "fireworks-ai"/);
    assert.match(enabled, /model = "glm-fast-latest"/);
    assert.match(enabled, /\[model_providers\.fireworks-ai\]/);
    assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    assert.doesNotMatch(enabled, /\[profiles\.fireconnect\]/);
    assert.doesNotMatch(enabled, /model_catalog_json/);
    assert.equal(existsSync(path.join(home, ".codex", "fireworks-model-catalog.json")), false);
    assert.match(onResult.stdout, /could not generate model catalog/i);
    assert.match(enabled, /experimental_bearer_token = "fw_test_key_12345"/);
    assert.doesNotMatch(enabled, /env_key = "FIREWORKS_API_KEY"/);
    assert.match(enabled, /wire_api = "responses"/);
    assert.match(enabled, /\[\[mcp_servers\]\]/);

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("adds telemetry without replacing user headers and restores them on off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-headers-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = 'model_provider = "openai"\nmodel = "gpt-4.1"\n';
    await writeFile(configPath, original);

    const first = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    let config = await readFile(configPath, "utf8");
    let table = parseToml(config).tables["model_providers.fireworks-ai"];
    assert.equal(table.http_headers["User-Agent"], undefined);
    assert.equal(table.http_headers["X-Title"], "Codex");
    assert.equal(
      table.http_headers["HTTP-Referer"],
      "fireconnect/v0.9.0",
    );
    assert.equal(table.http_headers["X-FireRouter-Harness"], undefined);
    assert.equal(table.http_headers["Fireworks-Use-Case"], undefined);

    config = config.replace(
      /^http_headers = .*$/m,
      "http_headers = { User-Agent = 'custom-codex/1.0', X-User-Trace = 'keep', X-FireRouter-Harness = 'codex', Fireworks-Use-Case = 'coding', HTTP-Referer = 'fireconnect/v0.7.0' }",
    ).replace(
      /^experimental_bearer_token = .*$/m,
      "$&\nenv_http_headers = { X-User-Env = 'USER_ENV', x-anthropic-api-key = 'OLD_ANTHROPIC' }",
    );
    await writeFile(configPath, config);

    const repeat = await runFireconnect(
      ["codex", "on"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" },
    );
    assert.equal(repeat.code, 0, repeat.stderr);
    table = parseToml(await readFile(configPath, "utf8"))
      .tables["model_providers.fireworks-ai"];
    assert.equal(table.http_headers["X-User-Trace"], "keep");
    assert.equal(table.http_headers["User-Agent"], "custom-codex/1.0");
    assert.equal(table.http_headers["X-Title"], "Codex");
    assert.equal(
      table.http_headers["HTTP-Referer"],
      "fireconnect/v0.9.0",
    );
    assert.equal(table.http_headers["X-FireRouter-Harness"], undefined);
    assert.equal(table.http_headers["Fireworks-Use-Case"], undefined);
    assert.equal(table.env_http_headers["X-User-Env"], "USER_ENV");
    assert.equal(table.env_http_headers["x-anthropic-api-key"], undefined);

    const off = await runFireconnect(
      ["codex", "off"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("on resolves API key from keychain when env is unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-global-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await seedKeychainConfig(home, "fw_test_key_12345");

      const onResult = await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(onResult.code, 0, onResult.stderr);
      assert.match(onResult.stdout, /Codex → Fireworks · glm-fast-latest/);

      const configPath = codexConfigPath(home);
      const enabled = await readFile(configPath, "utf8");
      assert.match(enabled, /model_provider = "fireworks-ai"/);
      assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    });
  });

  it("on reuses harness-local bearer token when global config and env are unset", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-harness-literal-"));
      await writeCodexConfig(home, { apiKey: FW_CODEX_KEY, envRef: false });

      const onResult = await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(onResult.code, 0, onResult.stderr);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /experimental_bearer_token = "fw_test_codex_key_00000000000000"/);
      assert.doesNotMatch(config, /env_key = "FIREWORKS_API_KEY"/);

      const exportResult = await runFireconnect(["key", "export"], {
        HOME: home,
        FIREWORKS_API_KEY: "",
      });
      assert.equal(exportResult.code, 0, exportResult.stderr);
      assert.equal(exportResult.stdout.trim(), FW_CODEX_KEY);
    });
  });

  it("on with env only writes a literal bearer token", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-env-on-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });

      const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
      const onResult = await runFireconnect(["codex", "on"], env);
      assert.equal(onResult.code, 0);
      assert.match(onResult.stdout, /Codex → Fireworks · glm-fast-latest/);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /experimental_bearer_token = "fw_test_key_12345"/);
      assert.doesNotMatch(config, /env_key = "FIREWORKS_API_KEY"/);
    });
  });

  it("on with a literal bearer does not tighten config.toml permissions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-env-perms-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);

    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };
    const onResult = await runFireconnect(["codex", "on"], env);
    assert.equal(onResult.code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /experimental_bearer_token = "fw_test_key_12345"/);
    assert.doesNotMatch(enabled, /env_key = "FIREWORKS_API_KEY"/);

    const st = await stat(configPath);
    assert.equal(st.mode & 0o700, 0o600, "config.toml should remain owner-readable/writable");
  });

  it("off strips routing when backup is missing or contains Fireworks config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-backup-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
    ].join("\n") + "\n";
    await writeFile(configPath, original);

    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await unlink(backupPath);

    const legacyCanonical = (await readFile(configPath, "utf8")).replace(
      'model = "glm-fast-latest"',
      'model = "accounts/fireworks/routers/glm-fast-latest"',
    );
    await writeFile(configPath, legacyCanonical);
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    await assert.rejects(access(backupPath));
    assert.match(await readFile(configPath, "utf8"), /model = "glm-fast-latest"/);

    let offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup|was not connected/);

    let restored = await readFile(configPath, "utf8");
    assert.doesNotMatch(restored, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(restored, /\[model_providers\.fireworks-ai\]/);

    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    const fireworksConfig = await readFile(configPath, "utf8");
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: fireworksConfig },
    });

    offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup|was not connected/);

    restored = await readFile(configPath, "utf8");
    assert.doesNotMatch(restored, /model_provider = "fireworks-ai"/);
    await assert.rejects(access(backupPath));
  });

  it("on snapshots and off restores when user already has fireworks-ai provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-existing-provider-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);
    const original = [
      'model_provider = "fireworks-ai"',
      'model = "accounts/fireworks/models/custom-model"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "My Fireworks"',
      'base_url = "https://custom.example/v1"',
      'env_key = "FIREWORKS_API_KEY"',
      "",
    ].join("\n");
    await writeFile(configPath, original);

    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);

    const enabled = await readFile(configPath, "utf8");
    assert.match(enabled, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    assert.match(enabled, /base_url = "https:\/\/api\.fireworks\.ai\/inference\/v1"/);

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });

  it("codex on rejects Fire Pass key with helpful error", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-fpk-env-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    const env = { HOME: home, FIREWORKS_API_KEY: "" };
    const result = await runFireconnect(["codex", "on", "--api-key", FPK_KEY], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /\/responses endpoint is not supported for Fire Pass keys yet/);
    assert.match(result.stderr, /standard Fireworks API key/);
  });

  it("codex on rejects Fire Pass key sourced from global config", async () => {
    await withoutEnvFireworksKey(async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-reset-"));
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await seedKeychainConfig(home, FPK_KEY);

      const env = { HOME: home, FIREWORKS_API_KEY: "" };
      const result = await runFireconnect(["codex", "on"], env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /\/responses endpoint is not supported for Fire Pass keys yet/);
      assert.match(result.stderr, /standard Fireworks API key/);
    });
  });
});
