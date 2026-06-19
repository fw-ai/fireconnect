import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  patchCodexModelRaw,
  patchCodexProviderAuthRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "../lib/codex-toml-patch.mjs";
import { parseToml } from "../lib/codex-toml.mjs";
import { fireconnectManaged } from "../lib/codex-core.mjs";

const ROUTING = {
  providerId: "fireworks-ai",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "accounts/fireworks/routers/glm-5p1",
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
      "accounts/fireworks/routers/kimi-k2p7-code-fast",
    );
    assert.match(updated, /model = "accounts\/fireworks\/routers\/kimi-k2p7-code-fast"/);
    assert.match(updated, /model_provider = "fireworks-ai"/);
    assert.equal(parseToml(updated).root.model, "accounts/fireworks/routers/kimi-k2p7-code-fast");
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

    const updated = patchCodexModelRaw(patched, "accounts/fireworks/models/glm-5p2");
    const withAuth = patchCodexProviderAuthRaw(updated, {
      apiKey: "fw_test_key_12345",
      literalAuth: true,
    });
    assert.match(withAuth, /model = "accounts\/fireworks\/models\/glm-5p2"/);
    assert.match(withAuth, /experimental_bearer_token = "fw_test_key_12345"/);
  });
});
