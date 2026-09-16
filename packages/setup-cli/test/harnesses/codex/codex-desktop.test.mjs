import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CODEX_FIREWORKS_BASE_URL,
  codexBackupPath,
  codexProviderStatus,
  disableCodexFireworks,
  enableCodexFireworks,
  refreshCodexGatewayKey,
} from "../../../lib/harnesses/codex/core.mjs";
import { normalizeCodexBaseUrl } from "../../../lib/harnesses/codex/endpoint.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import { runFireconnect } from "../../helpers.mjs";

const KEY = "fw_test_key_12345";
const PROXY = "https://gateway.example.test/fireworks/v1";
const original = 'model_provider = "openai"\nmodel = "gpt-5"\nopenai_base_url = "https://original.example.test/v1"\n\n[features]\nshell_tool = true\n';
const tempHome = () => mkdtemp(path.join(os.tmpdir(), "fc-codex-desktop-"));
const readDoc = async (file) => parseToml(await readFile(file, "utf8"));

describe("Codex Desktop gateway setup", () => {
  it("overrides routing, retains the endpoint across model/key changes, and restores the original config", async () => {
    const home = await tempHome();
    const env = { HOME: home, CODEX_HOME: "", FIREWORKS_API_KEY: "" };
    const configPath = path.join(home, ".codex/config.toml");
    await mkdir(path.dirname(configPath));
    await writeFile(configPath, original);
    const enabled = await runFireconnect(["codex", "on", "--api-key", KEY, "--model", "glm-latest", "--base-url", `${PROXY}/`], env);
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.ok(enabled.stdout.includes(PROXY));
    assert.ok(enabled.stdout.includes(configPath));
    let doc = await readDoc(configPath);
    assert.equal(doc.root.model_provider, "fireworks-ai");
    assert.equal(doc.root.model, "glm-latest");
    assert.equal(doc.tables["model_providers.fireworks-ai"].base_url, PROXY);
    assert.equal(doc.tables["model_providers.fireworks-ai"].wire_api, "responses");
    assert.equal(doc.tables["model_providers.fireworks-ai"].requires_openai_auth, false);
    assert.equal(doc.root.openai_base_url, "https://original.example.test/v1");
    assert.equal(codexProviderStatus(doc), "fireworks");

    const changed = await runFireconnect(["codex", "on", "--model", "glm-fast-latest"], env);
    assert.equal(changed.code, 0, changed.stderr);
    assert.equal(await refreshCodexGatewayKey({ configPath, fireworksKey: "fw_test_rotated_key_12345" }), true);
    doc = await readDoc(configPath);
    assert.equal(doc.root.model, "glm-fast-latest");
    assert.equal(doc.tables["model_providers.fireworks-ai"].base_url, PROXY);
    assert.equal(doc.tables["model_providers.fireworks-ai"].experimental_bearer_token, "fw_test_rotated_key_12345");

    const status = await runFireconnect(["codex", "status", "--json"], env);
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.baseUrl, PROXY);
    assert.equal(payload.provider, "fireworks");
    assert.equal(payload.configPath, configPath);
    assert.equal(payload.runtimeVerified, false);
    assert.equal(payload.configurationSource, "config-file");
    assert.equal(payload.hasAuthToken, true);
    assert.doesNotMatch(status.stdout, /fw_test/);

    const reset = await runFireconnect(["codex", "on", "--base-url", CODEX_FIREWORKS_BASE_URL], env);
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal((await readDoc(configPath)).tables["model_providers.fireworks-ai"].base_url, CODEX_FIREWORKS_BASE_URL);
    const off = await runFireconnect(["codex", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("uses CODEX_HOME, with --config-path taking precedence, on both on and off", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, "desktop");
    const env = { HOME: home, CODEX_HOME: codexHome, FIREWORKS_API_KEY: "" };
    const configPath = path.join(codexHome, "config.toml");
    const on = await runFireconnect(["codex", "on", "--api-key", KEY, "--model", "glm-latest", "--base-url", PROXY], env);
    assert.equal(on.code, 0, on.stderr);
    assert.ok(existsSync(configPath));
    assert.equal(existsSync(path.join(home, ".codex/config.toml")), false);
    const status = await runFireconnect(["codex", "status", "--json"], env);
    assert.equal(JSON.parse(status.stdout).configPath, configPath);
    const desktopConfig = await readFile(configPath, "utf8");

    const explicitPath = path.join(home, "explicit", "config.toml");
    const explicit = await runFireconnect(["codex", "on", "--config-path", explicitPath, "--model", "glm-latest", "--base-url", "http://localhost:8080/v1"], env);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal((await readDoc(explicitPath)).tables["model_providers.fireworks-ai"].base_url, "http://localhost:8080/v1");
    assert.equal(await readFile(configPath, "utf8"), desktopConfig);
    assert.equal((await runFireconnect(["codex", "off", "--config-path", explicitPath], env)).code, 0);
    assert.equal(existsSync(explicitPath), false);
    assert.equal(await readFile(configPath, "utf8"), desktopConfig);
    assert.equal((await runFireconnect(["codex", "off"], env)).code, 0);
    assert.equal(existsSync(configPath), false);
  });

  it("rejects invalid URLs before saving any credentials or config", async () => {
    const home = await tempHome();
    for (const url of ["not-a-url", "file:///tmp/config", "https://user:secret@host.test/v1", "https://host.test/v1?token=secret", "https://host.test/v1#fragment", "https://host.test/\ninjected"]) {
      const result = await runFireconnect(["codex", "on", "--api-key", KEY, "--base-url", url], { HOME: home, CODEX_HOME: "" });
      assert.notEqual(result.code, 0, url);
      assert.match(result.stderr, /Codex --base-url/);
      assert.doesNotMatch(result.stderr, /secret|injected/);
      assert.equal(existsSync(path.join(home, ".codex/config.toml")), false);
      assert.equal(existsSync(path.join(home, ".fireconnect/config.json")), false);
    }
    for (const action of ["off", "status"]) {
      const result = await runFireconnect(["codex", action, "--base-url", PROXY], { HOME: home });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--base-url applies only/);
    }
  });

  it("normalizes the base path without adding an Azure or Responses suffix", () => {
    assert.equal(normalizeCodexBaseUrl(" https://proxy.test/gateway/v1/// "), "https://proxy.test/gateway/v1");
    assert.equal(normalizeCodexBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  });
});

describe("Codex Desktop catalog paths and status", () => {
  it("writes an escaped absolute catalog reference and preserves it on a later offline on", async () => {
    const home = await tempHome();
    const configPath = path.join(home, 'Desktop "test" \\ config', "config.toml");
    const catalogPath = path.join(path.dirname(configPath), "fireworks-model-catalog.json");
    const dataDir = path.join(home, "backups");
    const options = { configPath, catalogPath, dataDir, apiKey: KEY, modelId: "glm-latest", baseUrl: PROXY };
    await enableCodexFireworks({ ...options, catalog: { models: [{ slug: "glm-latest" }] } });
    assert.equal((await readDoc(configPath)).root.model_catalog_json, catalogPath);
    assert.ok(existsSync(catalogPath));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await enableCodexFireworks(options);
    assert.equal((await readDoc(configPath)).root.model_catalog_json, catalogPath);
    const status = await runFireconnect(["codex", "status", "--config-path", configPath, "--json"], { HOME: home });
    assert.deepEqual(JSON.parse(status.stdout).modelCatalog, { set: true, path: catalogPath, exists: true });
    await disableCodexFireworks({ configPath, catalogPath, dataDir });
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(catalogPath), false);
  });

  it("preserves a restored config's absolute catalog reference", async () => {
    const home = await tempHome();
    const configPath = path.join(home, "config.toml");
    const catalogPath = path.join(home, "fireworks-model-catalog.json");
    const dataDir = path.join(home, "backups");
    // Put the catalog key at root, before the first table.
    const raw = `model_catalog_json = ${JSON.stringify(catalogPath)}\n${original}`;
    await writeFile(configPath, raw);
    await writeFile(catalogPath, JSON.stringify({ models: [{ slug: "glm-latest" }] }));
    await enableCodexFireworks({ configPath, catalogPath, dataDir, apiKey: KEY, modelId: "glm-latest", baseUrl: PROXY });
    await disableCodexFireworks({ configPath, catalogPath, dataDir });
    assert.equal(await readFile(configPath, "utf8"), raw);
    assert.ok(existsSync(catalogPath));
  });

  it("recognizes and strips a custom gateway when the backup is missing", async () => {
    const home = await tempHome();
    const configPath = path.join(home, "config.toml");
    const dataDir = path.join(home, "backups");
    await enableCodexFireworks({ configPath, dataDir, apiKey: KEY, modelId: "glm-latest", baseUrl: PROXY });
    await unlink(codexBackupPath(dataDir, configPath));
    assert.equal(await disableCodexFireworks({ configPath, dataDir }), "stripped");
    assert.equal((await readDoc(configPath)).root.model_provider, undefined);
  });

  it("reports the selected provider without claiming the default config uses Fireworks", async () => {
    const home = await tempHome();
    const configPath = path.join(home, "config.toml");
    await writeFile(configPath, 'model = "gpt-5"\nopenai_base_url = "https://user:secret@api.example.test/v1?token=secret"\n');
    const status = await runFireconnect(["codex", "status", "--config-path", configPath, "--json"], { HOME: home, FIREWORKS_API_KEY: KEY });
    assert.equal(status.code, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.modelProvider, "openai");
    assert.equal(payload.provider, "default");
    assert.equal(payload.current.main, "gpt-5");
    assert.equal(payload.hasAuthToken, false);
    assert.equal(payload.baseUrl, "https://api.example.test/v1?[redacted]");
    assert.doesNotMatch(status.stdout, /secret|fw_test/);
  });

  it("reports missing catalogs using the configured path", async () => {
    const home = await tempHome();
    const configPath = path.join(home, "config.toml");
    const catalogPath = path.join(home, "missing.json");
    await writeFile(configPath, `model_catalog_json = ${JSON.stringify(catalogPath)}\n${original}`);
    const result = await runFireconnect(["codex", "status", "--config-path", configPath, "--json"], { HOME: home });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.modelCatalog.exists, false);
    assert.equal(payload.modelCatalog.path, catalogPath);
    assert.match(payload.diagnostics.join(" "), /catalog is missing/);
  });

  it("uninstalls from CODEX_HOME without removing another Codex home's catalog", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, "desktop");
    const configPath = path.join(codexHome, "config.toml");
    const catalogPath = path.join(codexHome, "fireworks-model-catalog.json");
    const defaultCatalog = path.join(home, ".codex/fireworks-model-catalog.json");
    await mkdir(path.dirname(defaultCatalog));
    await writeFile(defaultCatalog, "other Codex home");
    await enableCodexFireworks({ configPath, catalogPath, dataDir: path.join(home, ".fireconnect/codex"), apiKey: KEY, modelId: "glm-latest", baseUrl: PROXY, catalog: { models: [{ slug: "glm-latest" }] } });
    const uninstall = await runFireconnect(["uninstall"], { HOME: home, CODEX_HOME: codexHome });
    assert.equal(uninstall.code, 0, uninstall.stderr);
    assert.equal(existsSync(catalogPath), false);
    assert.equal(existsSync(configPath), false);
    assert.equal(await readFile(defaultCatalog, "utf8"), "other Codex home");
  });
});
