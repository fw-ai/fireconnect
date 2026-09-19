import { mkdtemp, readFile, writeFile, mkdir, unlink, access, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexBackupPath, codexCatalogPath, codexConfigPath, codexDataDir } from "../../../lib/harnesses/codex/core.mjs";
import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { writeJson } from "../../../lib/io/json.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import {
  FIRECONNECT_REFERER,
  FPK_KEY,
  FW_CODEX_KEY,
  SK_ANT_KEY,
  mockServerlessModel,
  runFireconnect,
  seedKeychainConfig,
  seedServerlessCatalogCache,
  withoutEnvFireworksKey,
  writeCodexConfig,
} from "../../helpers.mjs";

describe("codex harness integration", () => {
  it("rejects Claude Code context suffixes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-context-suffix-"));
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "kimi-k3[1m]"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /\[1m\] model suffixes are only supported by Claude Code/);
  });

  it("re-on preserves the model selected under the managed Fireworks provider", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-provider-model-"));
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      'model_provider = "fireworks-ai"',
      'model = "o4-mini"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'experimental_bearer_token = "fw_test_key_12345"',
      "",
    ].join("\n"));

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseToml(await readFile(configPath, "utf8")).root.model, "o4-mini");
  });

  it("re-on preserves a cataloged Fireworks gpt-oss model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-gpt-oss-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    seedServerlessCatalogCache(home, [
      mockServerlessModel({
        name: "accounts/fireworks/models/gpt-oss-120b",
        displayName: "GPT OSS 120B",
      }),
    ]);

    for (const args of [
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "gpt-oss-120b"],
      ["codex", "on", "--api-key", "fw_test_key_12345"],
    ]) {
      const result = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(
      parseToml(await readFile(codexConfigPath(home), "utf8")).root.model,
      "gpt-oss-120b",
    );
  });

  it("first plain on seeds over an unreferenced catalog file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-first-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(codexCatalogPath(home), '{"models":[]}\n');

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_cataloged_v1_adversarial000000"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    assert.ok(catalog.models.some((model) => model.slug === "kimi-latest"));
  });

  it("off restores an unreferenced catalog file byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-user-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const original = '{"models":[{"slug":"user-model"}]}\n';
    await writeFile(codexCatalogPath(home), original);

    const on = await runFireconnect(
      ["codex", "on", "--api-key", "fw_cataloged_v1_adversarial000000"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(on.code, 0, on.stderr);
    const off = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(codexCatalogPath(home), "utf8"), original);
  });

  it("adds an explicit model from a stale catalog cache", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-stale-cache-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    seedServerlessCatalogCache(home, [
      mockServerlessModel({
        name: "accounts/fireworks/models/cached-model",
        displayName: "Cached Model",
      }),
    ]);

    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345", "--model", "cached-model"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    assert.ok(catalog.models.some((model) => model.slug === "cached-model"));
  });

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

  it("re-on without --model preserves a FireRouter path and model_catalog_json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-firerouter-path-reron-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const apiKey = "fw_cataloged_v1_adversarial000000";
    const first = await runFireconnect(
      ["codex", "on", "--api-key", apiKey],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(first.code, 0, first.stderr);
    const select = await runFireconnect(
      ["codex", "on", "--api-key", apiKey, "--model", "firerouter/test-model"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(select.code, 0, select.stderr);
    const afterSelect = await readFile(codexConfigPath(home), "utf8");
    assert.match(afterSelect, /model = "firerouter\/test-model"/);
    assert.match(afterSelect, /model_catalog_json/);

    const rerun = await runFireconnect(
      ["codex", "on", "--api-key", apiKey],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(rerun.code, 0, rerun.stderr);
    const afterRerun = await readFile(codexConfigPath(home), "utf8");
    assert.match(afterRerun, /model = "firerouter\/test-model"/);
    assert.match(afterRerun, /model_catalog_json/);
    const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
    assert.ok(slugs.includes("firerouter/test-model"));
  });

  it("second on with no changes is a file-level no-op", async () => {
    // The thin mock catalog also exercises context repair.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-rerun-noop-"));
    const args = ["codex", "on", "--api-key", "fw_cataloged_rerun_key_0000000000", "--model", "kimi-latest"];
    const first = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(first.code, 0, first.stderr);
    const catalog = JSON.parse(await readFile(codexCatalogPath(home), "utf8"));
    const kimi = catalog.models.find((entry) => entry.slug === "kimi-latest");
    assert.ok(kimi);
    assert.ok(kimi.context_window > 0, `expected usable context, got ${kimi.context_window}`);
    const configBefore = await readFile(codexConfigPath(home), "utf8");
    const catalogBefore = await readFile(codexCatalogPath(home), "utf8");
    const configMtime = (await stat(codexConfigPath(home))).mtimeMs;
    const catalogMtime = (await stat(codexCatalogPath(home))).mtimeMs;
    const second = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await readFile(codexConfigPath(home), "utf8"), configBefore);
    assert.equal(await readFile(codexCatalogPath(home), "utf8"), catalogBefore);
    assert.equal((await stat(codexConfigPath(home))).mtimeMs, configMtime);
    assert.equal((await stat(codexCatalogPath(home))).mtimeMs, catalogMtime);
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

  it("does not attach env BYOK when firerouter is not selected", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-no-byok-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const result = await runFireconnect(
      ["codex", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "sk-ant-should-not-attach-12345",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const config = await readFile(codexConfigPath(home), "utf8");
    assert.match(config, /model = "auto"/);
    assert.doesNotMatch(config, /env_http_headers = \{ "x-anthropic-api-key"/);
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
    assert.match(enabled, /model = "auto"/);
    assert.match(enabled, /\[model_providers\.fireworks-ai\]/);
    assert.doesNotMatch(enabled, /profile = "fireconnect"/);
    assert.doesNotMatch(enabled, /\[profiles\.fireconnect\]/);
    assert.doesNotMatch(enabled, /model_catalog_json/);
    // Offline `on` no longer seeds a firerouter row — FireRouter registers in
    // Codex's catalog only when explicitly selected via --model firerouter.
    const catalogPath = path.join(home, ".codex", "fireworks-model-catalog.json");
    assert.equal(existsSync(catalogPath), false);
    assert.match(enabled, /experimental_bearer_token = "fw_test_key_12345"/);
    assert.doesNotMatch(enabled, /env_key = "FIREWORKS_API_KEY"/);
    assert.match(enabled, /wire_api = "responses"/);
    assert.match(enabled, /\[\[mcp_servers\]\]/);

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.match(offResult.stdout, /restored to your previous setup/);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
    assert.equal(existsSync(catalogPath), false);
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
      FIRECONNECT_REFERER,
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
      FIRECONNECT_REFERER,
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
      assert.match(onResult.stdout, /Codex → Fireworks · auto/);

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
      assert.match(onResult.stdout, /Codex → Fireworks · auto/);

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
      'model = "kimi-fast-latest"',
      'model = "accounts/fireworks/routers/kimi-fast-latest"',
    );
    await writeFile(configPath, legacyCanonical);
    assert.equal((await runFireconnect(["codex", "on", "--api-key", "fw_test_key_12345"], env)).code, 0);
    await assert.rejects(access(backupPath));
    assert.match(await readFile(configPath, "utf8"), /model = "auto"/);

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
