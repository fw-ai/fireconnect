import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  patchCodexCatalogRefRaw,
  patchCodexModelRaw,
  patchCodexProviderAuthRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "../../../lib/harnesses/codex/toml-patch.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import {
  codexCurrentModelId,
  fireconnectManaged,
} from "../../../lib/harnesses/codex/core.mjs";

const ROUTING = {
  providerId: "fireworks-ai",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "glm-5p1",
};

describe("codex-toml-patch", () => {
  it("preserves array-of-tables through patch and strip", () => {
    const input = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
      "",
      "[[mcp_servers]]",
      'name = "test"',
      'command = "echo"',
      "",
    ].join("\n");

    const patched = patchFireconnectRoutingRaw(input, ROUTING);
    assert.match(patched, /\[\[mcp_servers\]\]/);
    assert.match(patched, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(patched, /profile = "fireconnect"/);
    assert.doesNotMatch(patched, /\[profiles\.fireconnect\]/);

    const stripped = stripFireconnectRoutingRaw(patched, { stripRootRouting: true });
    assert.match(stripped, /\[\[mcp_servers\]\]/);
    assert.doesNotMatch(stripped, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(stripped, /\[model_providers\.fireworks-ai\]/);
  });

  it("patches the root model for Codex 0.134+ routing", () => {
    const input = patchFireconnectRoutingRaw("", ROUTING);
    const updated = patchCodexModelRaw(
      input,
      "kimi-k3-fast",
    );
    assert.match(updated, /model = "kimi-k3-fast"/);
    assert.match(updated, /model_provider = "fireworks-ai"/);
    assert.equal(parseToml(updated).root.model, "kimi-k3-fast");
  });

  it("replaces existing root routing keys when enabling", () => {
    const input = [
      'profile = "default"',
      'model_provider = "openai"',
      'model = "gpt-4.1"',
      "",
      "[tui]",
      "show_tooltips = true",
      "",
    ].join("\n");

    const patched = patchFireconnectRoutingRaw(input, ROUTING);
    const doc = parseToml(patched);
    assert.equal(doc.root.model_provider, "fireworks-ai");
    assert.equal(doc.root.model, ROUTING.modelId);
    assert.equal(doc.root.profile, undefined);
    assert.match(patched, /\[tui\]/);
    assert.ok(fireconnectManaged(doc));
    assert.equal(codexCurrentModelId(doc), "glm-5p1");
  });

  it("does not treat a non-Fireworks root model as managed when a Fireworks provider table remains", () => {
    const doc = parseToml([
      'model_provider = "fireworks-ai"',
      'model = "gpt-4.1"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'experimental_bearer_token = "fw_test_key_12345"',
      "",
    ].join("\n"));
    assert.equal(fireconnectManaged(doc), false);
    assert.equal(codexCurrentModelId(doc), null);
  });

  it("recognizes legacy canonical root models as managed", () => {
    const doc = parseToml([
      'model_provider = "fireworks-ai"',
      'model = "accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'env_key = "FIREWORKS_API_KEY"',
      "",
    ].join("\n"));
    assert.equal(fireconnectManaged(doc), true);
    assert.equal(codexCurrentModelId(doc), "glm-fast-latest");
  });

  it("keeps routing keys at document root when user config ends in [tui] tables", () => {
    const input = [
      "[tui]",
      "show_tooltips = true",
      "",
      "[tui.model_availability_nux]",
      "gpt-4.1 = 2",
      "",
    ].join("\n");

    const patched = patchFireconnectRoutingRaw(input, ROUTING);
    const lines = patched.split("\n");
    assert.equal(lines[0], 'model_provider = "fireworks-ai"');
    assert.equal(lines[1], `model = "${ROUTING.modelId}"`);
    assert.match(patched, /\[tui\.model_availability_nux\]/);
    assert.match(patched, /^gpt-4\.1 = 2$/m);
    assert.doesNotMatch(patched, /\[tui\.model_availability_nux\]\nmodel_provider = /);
  });

  it("migrates legacy profile config to root routing", () => {
    const legacy = [
      'profile = "fireconnect"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'env_key = "FIREWORKS_API_KEY"',
      "requires_openai_auth = false",
      "",
      "[profiles.fireconnect]",
      'model_provider = "fireworks-ai"',
      'model = "accounts/fireworks/models/old-model"',
      "",
    ].join("\n");

    const patched = patchFireconnectRoutingRaw(legacy, ROUTING);
    assert.doesNotMatch(patched, /profile = "fireconnect"/);
    assert.doesNotMatch(patched, /\[profiles\.fireconnect\]/);
    const doc = parseToml(patched);
    assert.equal(doc.root.model_provider, "fireworks-ai");
    assert.equal(doc.root.model, ROUTING.modelId);
    assert.ok(fireconnectManaged(doc));
  });

  it("writes bearer token auth when literalAuth is enabled", () => {
    const patched = patchFireconnectRoutingRaw("", {
      ...ROUTING,
      apiKey: "fw_test_key_12345",
      literalAuth: true,
    });
    assert.match(patched, /experimental_bearer_token = "fw_test_key_12345"/);
    assert.doesNotMatch(patched, /env_key = "FIREWORKS_API_KEY"/);

    const updated = patchCodexModelRaw(patched, "glm-5p2");
    const withAuth = patchCodexProviderAuthRaw(updated, {
      apiKey: "fw_test_key_12345",
      literalAuth: true,
    });
    assert.match(withAuth, /model = "glm-5p2"/);
    assert.match(withAuth, /experimental_bearer_token = "fw_test_key_12345"/);
  });

  it("writes and parses static and env request headers", () => {
    const patched = patchFireconnectRoutingRaw("", {
      ...ROUTING,
      httpHeaders: {
        "User-Agent": "custom-client/1.0",
        "X-User-Trace": "keep",
      },
      envHttpHeaders: {
        "x-anthropic-api-key": "ANTHROPIC_API_KEY",
        "X-User-Env": "USER_ENV",
      },
    });
    const table = parseToml(patched).tables["model_providers.fireworks-ai"];
    assert.deepEqual(table.http_headers, {
      "User-Agent": "custom-client/1.0",
      "X-User-Trace": "keep",
    });
    assert.deepEqual(table.env_http_headers, {
      "x-anthropic-api-key": "ANTHROPIC_API_KEY",
      "X-User-Env": "USER_ENV",
    });
  });

  it("patchFireconnectRoutingRaw includes model_catalog_json between model_provider and model when catalogPath is set", () => {
    const patched = patchFireconnectRoutingRaw("", {
      ...ROUTING,
      catalogPath: "~/.codex/fireworks-model-catalog.json",
    });
    const lines = patched.split("\n");
    const providerIndex = lines.findIndex((line) => line.startsWith('model_provider = '));
    const catalogIndex = lines.findIndex((line) => line.startsWith('model_catalog_json = '));
    const modelIndex = lines.findIndex((line) => line.startsWith('model = '));
    assert.ok(providerIndex >= 0);
    assert.ok(catalogIndex > providerIndex, "catalog line should come after model_provider");
    assert.ok(modelIndex > catalogIndex, "model line should come after model_catalog_json");
    assert.match(patched, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
  });

  it("patchFireconnectRoutingRaw without catalogPath omits model_catalog_json", () => {
    const patched = patchFireconnectRoutingRaw("", ROUTING);
    assert.doesNotMatch(patched, /model_catalog_json/);
    assert.match(patched, /model_provider = "fireworks-ai"/);
    assert.match(patched, /model = "glm-5p1"/);
  });

  it("stripFireconnectRoutingRaw with stripRootRouting removes model_catalog_json lines", () => {
    const input = [
      'model_provider = "fireworks-ai"',
      'model_catalog_json = "~/.codex/fireworks-model-catalog.json"',
      'model = "accounts/fireworks/routers/glm-latest"',
      "",
      "[model_providers.fireworks-ai]",
      'name = "Fireworks"',
      'base_url = "https://api.fireworks.ai/inference/v1"',
      'env_key = "FIREWORKS_API_KEY"',
      "requires_openai_auth = false",
      "",
    ].join("\n");

    const stripped = stripFireconnectRoutingRaw(input, { stripRootRouting: true });
    assert.doesNotMatch(stripped, /model_catalog_json/);
    assert.doesNotMatch(stripped, /model_provider = "fireworks-ai"/);
    assert.doesNotMatch(stripped, /^model = /m);
    assert.doesNotMatch(stripped, /\[model_providers\.fireworks-ai\]/);
  });

  it("patchCodexCatalogRefRaw inserts model_catalog_json after model_provider when missing", () => {
    const input = patchFireconnectRoutingRaw("", ROUTING);
    const patched = patchCodexCatalogRefRaw(input, "~/.codex/fireworks-model-catalog.json");
    const lines = patched.split("\n");
    const providerIndex = lines.findIndex((line) => line.startsWith('model_provider = '));
    const catalogIndex = lines.findIndex((line) => line.startsWith('model_catalog_json = '));
    const modelIndex = lines.findIndex((line) => line.startsWith('model = '));
    assert.ok(catalogIndex > providerIndex);
    assert.ok(modelIndex > catalogIndex);
    assert.match(patched, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
  });

  it("patchCodexCatalogRefRaw updates an existing model_catalog_json line", () => {
    const input = [
      'model_provider = "fireworks-ai"',
      'model_catalog_json = "~/old-catalog.json"',
      'model = "accounts/fireworks/routers/glm-latest"',
      "",
    ].join("\n");
    const patched = patchCodexCatalogRefRaw(input, "~/.codex/fireworks-model-catalog.json");
    assert.equal(
      (patched.match(/model_catalog_json = /g) ?? []).length,
      1,
      "should not duplicate model_catalog_json",
    );
    assert.match(patched, /model_catalog_json = "~\/\.codex\/fireworks-model-catalog\.json"/);
    assert.doesNotMatch(patched, /old-catalog\.json/);
  });
});
