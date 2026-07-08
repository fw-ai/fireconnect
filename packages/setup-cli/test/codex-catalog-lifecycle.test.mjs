import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodexCatalog } from "../lib/codex-catalog.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_CATALOG_RELATIVE_PATH,
  CODEX_CATALOG_TOML_REF,
  codexBackupPath,
  codexCatalogPath,
  codexConfigPath,
  codexDataDir,
  disableCodexFireworks,
  enableCodexFireworks,
  updateCodexModel,
} from "../lib/codex-core.mjs";
import { writeJson } from "../lib/fireconnect-core.mjs";
import { patchFireconnectRoutingRaw } from "../lib/codex-toml-patch.mjs";
import { parseToml } from "../lib/codex-toml.mjs";

const ROUTING = {
  providerId: "fireworks-ai",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "accounts/fireworks/routers/glm-latest",
  apiKey: "fw_test_key_12345",
  literalAuth: true,
};

function mockCatalog() {
  return buildCodexCatalog([
    {
      name: "accounts/fireworks/models/glm-5p2",
      displayName: "GLM 5.2",
      description: "GLM 5.2",
      contextLength: 1048576,
      supportsImageInput: false,
      supportsTools: true,
      kind: "CHAT_COMPLETION_MODEL",
    },
  ]);
}

function catalogWithoutRouter() {
  return {
    models: [
      {
        slug: "accounts/fireworks/models/glm-5p2",
        display_name: "GLM 5.2",
      },
    ],
  };
}

async function seedCodexConfig(home, { withCatalogRef = false, withCatalogFile = false } = {}) {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  const configPath = codexConfigPath(home);
  const catalogPath = codexCatalogPath(home);
  const raw = patchFireconnectRoutingRaw("", {
    ...ROUTING,
    catalogPath: withCatalogRef ? CODEX_CATALOG_TOML_REF : "",
  });
  await writeFile(configPath, raw, "utf8");
  if (withCatalogFile) {
    await writeFile(catalogPath, JSON.stringify(mockCatalog(), null, 2), "utf8");
  }
  return { configPath, catalogPath };
}

describe("codex catalog lifecycle via updateCodexModel", () => {
  it("writes catalog file and config reference when both are missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-recover-"));
    const { configPath, catalogPath } = await seedCodexConfig(home);

    const result = await updateCodexModel({
      configPath,
      modelId: "glm-latest",
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(result.catalogReferenced, true);
    assert.equal(existsSync(catalogPath), true);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
    assert.equal(
      (config.match(/model_catalog_json = /g) ?? []).length,
      1,
      "should not duplicate model_catalog_json",
    );
    assert.equal(parseToml(config).root.model_catalog_json, CODEX_CATALOG_TOML_REF);
  });

  it("adds config reference when catalog file already exists", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-ref-only-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, { withCatalogFile: true });

    const result = await updateCodexModel({
      configPath,
      modelId: "glm-latest",
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(result.catalogReferenced, true);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
  });

  it("recreates missing catalog file when config reference already exists", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-file-only-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, { withCatalogRef: true });
    assert.equal(existsSync(catalogPath), false);

    const result = await updateCodexModel({
      configPath,
      modelId: "glm-latest",
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(result.catalogReferenced, false);
    assert.equal(existsSync(catalogPath), true);
    const config = await readFile(configPath, "utf8");
    assert.equal(
      (config.match(/model_catalog_json = /g) ?? []).length,
      1,
      "should not duplicate model_catalog_json",
    );
  });

  it("refreshes catalog file without duplicating config reference", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-refresh-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    await writeFile(catalogPath, JSON.stringify({ models: [] }), "utf8");

    const result = await updateCodexModel({
      configPath,
      modelId: "accounts/fireworks/models/glm-5p2",
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(result.catalogReferenced, false);
    const refreshed = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.ok(refreshed.models.length > 0);
    const config = await readFile(configPath, "utf8");
    assert.equal((config.match(/model_catalog_json = /g) ?? []).length, 1);
  });

  it("refreshes an existing catalog file during model update", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-refresh-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    await writeFile(catalogPath, JSON.stringify({ models: [] }, null, 2), "utf8");

    await updateCodexModel({
      configPath,
      modelId: "glm-latest",
      catalogPath,
      catalog: mockCatalog(),
    });

    const written = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.ok(written.models.length > 0);
  });

  it("does not write catalog artifacts when catalog payload is omitted", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-skip-"));
    const { configPath, catalogPath } = await seedCodexConfig(home);

    const result = await updateCodexModel({
      configPath,
      modelId: "glm-latest",
    });

    assert.equal(result.catalogReferenced, false);
    assert.equal(existsSync(catalogPath), false);
    const config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /model_catalog_json/);
  });

  it("does not add catalog reference when active model is missing from catalog", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-missing-model-"));
    const { configPath, catalogPath } = await seedCodexConfig(home);

    const result = await updateCodexModel({
      configPath,
      modelId: "accounts/fireworks/routers/kimi-latest",
      catalogPath,
      catalog: catalogWithoutRouter(),
    });

    assert.equal(result.catalogReferenced, false);
    assert.equal(existsSync(catalogPath), true);
    const config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /model_catalog_json/);
  });

  it("simulates failed codex on recovery via model reset path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-reset-"));
    const { configPath, catalogPath } = await seedCodexConfig(home);
    const enabled = await readFile(configPath, "utf8");
    assert.doesNotMatch(enabled, /model_catalog_json/);

    const result = await updateCodexModel({
      configPath,
      modelId: "accounts/fireworks/routers/glm-latest",
      apiKey: ROUTING.apiKey,
      literalAuth: true,
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(result.catalogReferenced, true);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
    assert.match(config, /experimental_bearer_token = "fw_test_key_12345"/);
    assert.equal(existsSync(catalogPath), true);
    assert.equal(existsSync(path.join(home, CODEX_CATALOG_RELATIVE_PATH)), true);
  });

  it("model select path uses env ref auth instead of bearer literal", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-model-select-auth-"));
    const { configPath, catalogPath } = await seedCodexConfig(home);

    const result = await updateCodexModel({
      configPath,
      modelId: "glm-latest",
      apiKey: CODEX_API_KEY_ENV_REF,
      literalAuth: false,
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(result.model, "accounts/fireworks/routers/glm-latest");
    const config = await readFile(configPath, "utf8");
    assert.match(config, /env_key = "FIREWORKS_API_KEY"/);
    assert.doesNotMatch(config, /experimental_bearer_token/);
  });

  it("does not leave a stale catalog file when config reference is removed manually", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-catalog-stale-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    await unlink(catalogPath);

    await updateCodexModel({
      configPath,
      modelId: "glm-latest",
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(existsSync(catalogPath), true);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
  });
});

describe("codex catalog lifecycle via enableCodexFireworks", () => {
  it("writes catalog file and config reference on enable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-enable-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = codexConfigPath(home);
    const catalogPath = codexCatalogPath(home);
    const dataDir = codexDataDir(home);

    const result = await enableCodexFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      apiKeyFromFlag: true,
      catalogPath,
      catalog: mockCatalog(),
    });

    assert.equal(result.catalogWritten, true);
    assert.equal(existsSync(catalogPath), true);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
    assert.match(config, /model_provider = "fireworks-ai"/);
  });

  it("preserves catalog reference when re-enable cannot refresh catalog", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-enable-preserve-ref-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    const dataDir = codexDataDir(home);

    const result = await enableCodexFireworks({
      configPath,
      dataDir,
      apiKey: ROUTING.apiKey,
      apiKeyFromFlag: true,
      modelId: "glm-latest",
      catalogPath,
      catalog: null,
    });

    assert.equal(result.catalogWritten, false);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
    assert.equal(existsSync(catalogPath), true);
  });

  it("drops catalog reference when re-enable cannot refresh missing catalog file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-enable-drop-stale-ref-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, { withCatalogRef: true });
    const dataDir = codexDataDir(home);

    const result = await enableCodexFireworks({
      configPath,
      dataDir,
      apiKey: ROUTING.apiKey,
      apiKeyFromFlag: true,
      modelId: "glm-latest",
      catalogPath,
      catalog: null,
    });

    assert.equal(result.catalogWritten, false);
    const config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /model_catalog_json/);
    assert.equal(existsSync(catalogPath), false);
  });

  it("re-enables when existing catalog file contains invalid JSON", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-enable-invalid-catalog-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    await writeFile(catalogPath, "{not valid json", "utf8");
    const dataDir = codexDataDir(home);

    const result = await enableCodexFireworks({
      configPath,
      dataDir,
      apiKey: ROUTING.apiKey,
      apiKeyFromFlag: true,
      modelId: "glm-latest",
      catalogPath,
      catalog: null,
    });

    assert.equal(result.catalogWritten, false);
    const config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /model_catalog_json/);
    assert.match(config, /model_provider = "fireworks-ai"/);
    assert.equal(existsSync(catalogPath), true);
  });
});

describe("codex catalog lifecycle via disableCodexFireworks", () => {
  it("removes catalog file after successful strip", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-disable-strip-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    const dataDir = codexDataDir(home);

    const outcome = await disableCodexFireworks({
      configPath,
      dataDir,
      catalogPath,
      wasEnabled: true,
    });

    assert.equal(outcome, "stripped");
    assert.equal(existsSync(catalogPath), false);
    const config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /model_catalog_json/);
  });

  it("removes catalog file after successful restore when backup omits catalog ref", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-disable-restore-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    const dataDir = codexDataDir(home);
    const backupPath = codexBackupPath(dataDir, configPath);
    const original = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
      "",
    ].join("\n");
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: original },
    });

    const outcome = await disableCodexFireworks({
      configPath,
      dataDir,
      catalogPath,
      wasEnabled: true,
    });

    assert.equal(outcome, "restored");
    assert.equal(existsSync(catalogPath), false);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("keeps catalog file after restore when backup still references it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-disable-restore-keep-catalog-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    const dataDir = codexDataDir(home);
    const backupPath = codexBackupPath(dataDir, configPath);
    const original = [
      'model_provider = "openai"',
      `model_catalog_json = "${CODEX_CATALOG_TOML_REF}"`,
      'model = "gpt-4.1"',
      "",
    ].join("\n");
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: original },
    });

    const outcome = await disableCodexFireworks({
      configPath,
      dataDir,
      catalogPath,
      wasEnabled: true,
    });

    assert.equal(outcome, "restored");
    assert.equal(existsSync(catalogPath), true);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("removes orphaned catalog when config.toml is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-disable-missing-config-"));
    const catalogPath = codexCatalogPath(home);
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFile(catalogPath, JSON.stringify(mockCatalog(), null, 2), "utf8");

    const outcome = await disableCodexFireworks({
      configPath,
      dataDir: codexDataDir(home),
      catalogPath,
      wasEnabled: true,
    });

    assert.equal(outcome, "noop");
    assert.equal(existsSync(catalogPath), false);
    assert.equal(existsSync(configPath), false);
  });

  it("removes orphaned catalog when disable strip is a noop", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-disable-strip-noop-"));
    const configPath = codexConfigPath(home);
    const catalogPath = codexCatalogPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "[tui]\nshow_tooltips = true\n", "utf8");
    await writeFile(catalogPath, JSON.stringify(mockCatalog(), null, 2), "utf8");

    const outcome = await disableCodexFireworks({
      configPath,
      dataDir: codexDataDir(home),
      catalogPath,
      wasEnabled: true,
    });

    assert.equal(outcome, "noop");
    assert.equal(existsSync(catalogPath), false);
    assert.doesNotMatch(await readFile(configPath, "utf8"), /model_catalog_json/);
  });

  it("keeps catalog file when backup validation fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-disable-backup-mismatch-"));
    const { configPath, catalogPath } = await seedCodexConfig(home, {
      withCatalogRef: true,
      withCatalogFile: true,
    });
    const dataDir = codexDataDir(home);
    const backupPath = codexBackupPath(dataDir, configPath);
    await writeJson(backupPath, {
      configPath: "/different/config.toml",
      snapshot: { existed: true, raw: 'model = "gpt-4.1"\n' },
    });

    await assert.rejects(
      () => disableCodexFireworks({
        configPath,
        dataDir,
        catalogPath,
        wasEnabled: true,
      }),
      /refusing to restore/,
    );

    assert.equal(existsSync(catalogPath), true);
    const config = await readFile(configPath, "utf8");
    assert.match(config, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
  });

  it("removes orphaned catalog when harness was not enabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-codex-disable-orphan-not-enabled-"));
    const catalogPath = codexCatalogPath(home);
    const configPath = codexConfigPath(home);
    await mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFile(catalogPath, JSON.stringify(mockCatalog(), null, 2), "utf8");

    const outcome = await disableCodexFireworks({
      configPath,
      dataDir: codexDataDir(home),
      catalogPath,
      wasEnabled: false,
    });

    assert.equal(outcome, "noop");
    assert.equal(existsSync(catalogPath), false);
    assert.equal(existsSync(configPath), false);
  });
});
