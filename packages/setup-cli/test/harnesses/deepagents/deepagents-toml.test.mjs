import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mergeDuplicateModelsSections,
  patchDeepagentsModelRaw,
  patchDeepagentsProviderModelsRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "../../../lib/harnesses/deepagents/toml-patch.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import {
  deepagentsAuthMode,
  deepagentsCurrentModelId,
  fireconnectManaged,
} from "../../../lib/harnesses/deepagents/core.mjs";

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

describe("deepagents-toml-patch", () => {
  it("patches routing into an empty config", () => {
    const next = patchFireconnectRoutingRaw("", {
      modelSpec: "fireworks:glm-fast-latest",
      modelId: "glm-fast-latest",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      authMode: "env-reference",
    });
    assert.match(next, /default = "fireworks:glm-fast-latest"/);
    assert.match(next, /models = \["glm-fast-latest"\]/);
    assert.match(next, /api_key_env = "FIREWORKS_API_KEY"/);
    assert.match(next, /enabled = true/);
  });

  it("strips managed routing and preserves unrelated tables", () => {
    const raw = [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["accounts/fireworks/routers/glm-fast-latest"]',
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n");

    const stripped = stripFireconnectRoutingRaw(raw, { stripModelsDefault: true });
    assert.doesNotMatch(stripped, /\[models\.providers\.fireworks\]/);
    assert.doesNotMatch(stripped, /default = /);
    assert.match(stripped, /\[ui\]/);
  });

  it("patches routing into an existing [models] table without duplicating it", () => {
    const raw = [
      "[models]",
      'default = "anthropic:claude-sonnet-4-5"',
      'recent = "anthropic:claude-sonnet-4-5"',
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n");

    const next = patchFireconnectRoutingRaw(raw, {
      modelSpec: "fireworks:glm-fast-latest",
      modelId: "glm-fast-latest",
      baseUrl: "https://api.fireworks.ai/inference",
      authMode: "literal",
    });

    assert.equal((next.match(/^\[models\]$/gm) || []).length, 1);
    assert.match(next, /default = "fireworks:glm-fast-latest"/);
    assert.match(next, /recent = "anthropic:claude-sonnet-4-5"/);
    assert.match(next, /\[ui\]/);
    assert.doesNotMatch(next, /anthropic:claude-sonnet-4-5"\n\n\[models\]/);
  });

  it("merges duplicate [models] sections produced by older fireconnect builds", () => {
    const broken = [
      "[models]",
      "",
      "[ui]",
      'theme = "dark"',
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["accounts/fireworks/routers/glm-fast-latest"]',
      "",
    ].join("\n");

    const fixed = mergeDuplicateModelsSections(broken);
    assert.equal((fixed.match(/^\[models\]$/gm) || []).length, 1);
    assert.match(fixed, /default = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
  });

  it("updates default model in place", () => {
    const raw = [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
    ].join("\n");
    const next = patchDeepagentsModelRaw(
      raw,
      "fireworks:glm-5p1",
    );
    assert.match(next, /default = "fireworks:glm-5p1"/);
  });

  it("preserves api_key_env when provider models line is missing", () => {
    const raw = [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n");

    const next = patchDeepagentsProviderModelsRaw(
      raw,
      "accounts/fireworks/models/glm-5p1",
      false,
    );
    assert.match(next, /api_key_env = "FIREWORKS_API_KEY"/);
    assert.match(next, /models = \["accounts\/fireworks\/models\/glm-5p1"\]/);
    assert.equal((next.match(/^\[models\]$/gm) || []).length, 1);
    assertTomllibParses(next);
  });

  it("replaces dcode multiline provider models arrays without leaving invalid tail lines", () => {
    const raw = [
      "[models]",
      'default = "fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      "models = [",
      '    "accounts/fireworks/models/nemotron-3-ultra-nvfp4",',
      "]",
      "",
    ].join("\n");

    const next = patchDeepagentsProviderModelsRaw(
      raw,
      "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
      false,
    );

    assert.match(next, /models = \["accounts\/fireworks\/models\/nemotron-3-ultra-nvfp4"\]/);
    assert.doesNotMatch(next, /^\s+"accounts\/fireworks\/models\/nemotron-3-ultra-nvfp4",/m);
    assert.doesNotMatch(next, /^\]$/m);
    assertTomllibParses(next);
  });

  it("repairs orphaned provider models tail lines from a prior bad patch", () => {
    const corrupted = [
      "[agents]",
      'recent = "agent"',
      "",
      "[models]",
      'recent = "fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4"',
      'default = "fireworks:accounts/fireworks/models/nemotron-3-ultra-nvfp4"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["accounts/fireworks/models/nemotron-3-ultra-nvfp4"]',
      '    "accounts/fireworks/models/nemotron-3-ultra-nvfp4",',
      "]",
      "",
    ].join("\n");

    assert.throws(() => assertTomllibParses(corrupted));

    const next = patchDeepagentsProviderModelsRaw(
      corrupted,
      "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
      false,
    );

    assertTomllibParses(next);
    assert.match(next, /models = \["accounts\/fireworks\/models\/nemotron-3-ultra-nvfp4"\]/);
    assert.doesNotMatch(next, /^\s+"accounts\/fireworks\/models\/nemotron-3-ultra-nvfp4",/m);
  });

  it("inserts provider models line without rebuilding routing when re-selecting current model", () => {
    const raw = [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      'recent = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[ui]",
      'theme = "dark"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n");

    const next = patchDeepagentsProviderModelsRaw(
      raw,
      "accounts/fireworks/routers/glm-fast-latest",
      false,
    );

    assert.match(next, /default = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
    assert.match(next, /recent = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
    assert.match(next, /models = \["accounts\/fireworks\/routers\/glm-fast-latest"\]/);
    assert.match(next, /api_key_env = "FIREWORKS_API_KEY"/);
    assert.match(next, /\[ui\]/);
    assert.equal((next.match(/^\[models\]$/gm) || []).length, 1);
    assert.equal(fireconnectManaged(parseToml(next)), true);
  });

});

describe("deepagents-core managed detection", () => {
  it("detects legacy canonical fireconnect-managed config", () => {
    const doc = parseToml([
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["accounts/fireworks/routers/glm-fast-latest"]',
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n"));
    assert.equal(fireconnectManaged(doc), true);
    assert.equal(deepagentsCurrentModelId(doc), "glm-fast-latest");
  });

  it("detects short fireconnect-managed config", () => {
    const doc = parseToml([
      "[models]",
      'default = "fireworks:glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["glm-fast-latest"]',
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n"));
    assert.equal(fireconnectManaged(doc), true);
    assert.equal(deepagentsCurrentModelId(doc), "glm-fast-latest");
  });
});

describe("deepagentsAuthMode", () => {
  it("returns missing when no auth is configured", () => {
    const doc = parseToml([
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      "",
    ].join("\n"));
    assert.equal(deepagentsAuthMode(doc), "missing");
  });
});
