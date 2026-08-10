import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  patchFireconnectAzureRoutingRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
  upsertProviderApiKeyRaw,
} from "../../../lib/harnesses/kimi/toml-patch.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import {
  fireconnectManagedVariant,
  kimiAuthMode,
  kimiCurrentModelId,
  kimiProviderStatus,
} from "../../../lib/harnesses/kimi/core.mjs";

const GATEWAY_PATCH = {
  alias: "fireworks/kimi-fast-latest",
  modelId: "kimi-fast-latest",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  apiKey: "fw_test_key_12345",
  maxContextSize: 262000,
  capabilities: ["image_in", "tool_use"],
};

const MANAGED_RAW = patchFireconnectRoutingRaw("", GATEWAY_PATCH);

function assertTomllibParses(raw) {
  const result = spawnSync("python3", ["-c", "import tomllib, sys; tomllib.loads(sys.stdin.read())"], {
    input: raw,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    result.stderr || "expected config.toml to parse with stdlib tomllib",
  );
}

describe("kimi-toml-patch", () => {
  it("patches routing into an empty config", () => {
    assertTomllibParses(MANAGED_RAW);
    const doc = parseToml(MANAGED_RAW);
    assert.equal(doc.root.default_model, "fireworks/kimi-fast-latest");
    assert.equal(doc.tables["providers.fireworks"].type, "openai");
    assert.equal(doc.tables["providers.fireworks"].api_key, "fw_test_key_12345");
    assert.equal(doc.tables["models.fireworks/kimi-fast-latest"].max_context_size, 262000);
    assert.deepEqual(
      doc.tables["models.fireworks/kimi-fast-latest"].capabilities,
      ["image_in", "tool_use"],
    );
  });

  it("replaces the user's default_model and preserves unrelated content", () => {
    const raw = [
      'default_model = "kimi-code/k3"',
      "",
      "[tui]",
      'theme = "dark"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    assert.equal((next.match(/^default_model/gm) || []).length, 1);
    assert.equal(parseToml(next).tables.tui.theme, "dark");
  });

  it("removes the user's default_model after an array closed by a commented line", () => {
    const raw = [
      "skills = [",
      '  "a",',
      "] # end of skills",
      'default_model = "kimi-code/k3"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    assert.equal((next.match(/^default_model/gm) || []).length, 1);
    assert.equal(parseToml(next).root.default_model, "fireworks/kimi-fast-latest");
  });

  it("is not confused by a root comment containing an unmatched bracket", () => {
    const raw = [
      "# see [docs for details",
      'default_model = "kimi-code/k3"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    assert.equal((next.match(/^default_model/gm) || []).length, 1);
  });

  it("removes the user's default_model after an array closed on its last element line", () => {
    const raw = [
      "skills = [",
      '  "a",',
      '  "b"]',
      'default_model = "kimi-code/k3"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    assert.equal((next.match(/^default_model/gm) || []).length, 1);
    assert.equal(parseToml(next).root.default_model, "fireworks/kimi-fast-latest");
  });

  it("is not confused by a root string value containing an unmatched bracket", () => {
    const raw = [
      'banner = "see [notes"',
      'default_model = "kimi-code/k3"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    assert.equal((next.match(/^default_model/gm) || []).length, 1);
    assert.equal(parseToml(next).root.default_model, "fireworks/kimi-fast-latest");
  });

  it("removes the user's default_model after a nested multiline array", () => {
    const raw = [
      "matrix = [",
      "  [1, 2],",
      "  [3, 4]",
      "]",
      'default_model = "kimi-code/k3"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    assert.equal((next.match(/^default_model/gm) || []).length, 1);
    assert.equal(parseToml(next).root.default_model, "fireworks/kimi-fast-latest");
  });

  it("removes a default_model written as a multiline string without orphaning its closer", () => {
    const raw = [
      'default_model = """',
      'kimi-code/k3"""',
      "[tui]",
      'theme = "dark"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    const doc = parseToml(next);
    assert.equal(doc.root.default_model, "fireworks/kimi-fast-latest");
    assert.equal(doc.tables.tui.theme, "dark");
    assert.doesNotMatch(next, /kimi-code\/k3/);
  });

  it("leaves a default_model line inside a multiline string intact", () => {
    const raw = [
      'notes = """',
      'default_model = "kimi-code/k3"',
      '"""',
      'default_model = "kimi-code/k3"',
      "",
    ].join("\n");
    const next = patchFireconnectRoutingRaw(raw, GATEWAY_PATCH);
    assertTomllibParses(next);
    const doc = parseToml(next);
    assert.equal(doc.root.default_model, "fireworks/kimi-fast-latest");
    assert.match(next, /notes = """\ndefault_model = "kimi-code\/k3"\n"""/);
  });

  it("azure patch replaces managed gateway routing entirely", () => {
    const next = patchFireconnectAzureRoutingRaw(MANAGED_RAW, {
      alias: "fireworks-azure/FW-GLM-5.2",
      modelId: "FW-GLM-5.2",
      baseUrl: "https://r.services.ai.azure.com/openai/v1",
      apiKey: "azure-key",
      maxContextSize: 128000,
      capabilities: ["tool_use"],
    });
    assertTomllibParses(next);
    const doc = parseToml(next);
    assert.equal(doc.root.default_model, "fireworks-azure/FW-GLM-5.2");
    assert.equal(doc.tables["providers.fireworks"], undefined);
    assert.equal(doc.tables["models.fireworks/kimi-fast-latest"], undefined);
  });

  it("strip removes managed routing and preserves unrelated content", () => {
    const next = patchFireconnectRoutingRaw('[tui]\ntheme = "dark"\n', GATEWAY_PATCH);
    const stripped = stripFireconnectRoutingRaw(next);
    assertTomllibParses(stripped);
    assert.doesNotMatch(stripped, /default_model|providers\.fireworks|models\."fireworks/);
    assert.equal(parseToml(stripped).tables.tui.theme, "dark");
  });

  it("strip leaves the user's own default_model intact", () => {
    const raw = 'default_model = "kimi-code/k3"\n';
    assert.equal(stripFireconnectRoutingRaw(raw), raw);
  });

  it("upsertProviderApiKeyRaw replaces only the api_key line", () => {
    const next = upsertProviderApiKeyRaw(MANAGED_RAW, "fw_rotated_key_67890");
    assert.equal(next, MANAGED_RAW.replace("fw_test_key_12345", "fw_rotated_key_67890"));
  });
});

describe("kimi managed-config detection", () => {
  it("detects the managed gateway variant", () => {
    const doc = parseToml(MANAGED_RAW);
    assert.equal(fireconnectManagedVariant(doc), "fireworks");
    assert.equal(kimiProviderStatus(doc), "fireworks");
    assert.equal(kimiCurrentModelId(doc), "kimi-fast-latest");
    assert.equal(kimiAuthMode(doc), "literal");
  });

  it("reports a foreign fireworks provider as custom", () => {
    const doc = parseToml([
      "[providers.fireworks]",
      'type = "openai"',
      'base_url = "https://my-own.example/v1"',
      'api_key = "user-key"',
      "",
    ].join("\n"));
    assert.equal(fireconnectManagedVariant(doc), null);
    assert.equal(kimiProviderStatus(doc), "custom");
    assert.equal(kimiCurrentModelId(doc), null);
  });

  it("reports an untouched config as default", () => {
    const doc = parseToml('default_model = "kimi-code/k3"\n');
    assert.equal(fireconnectManagedVariant(doc), null);
    assert.equal(kimiProviderStatus(doc), "default");
    assert.equal(kimiAuthMode(doc), "missing");
  });
});
