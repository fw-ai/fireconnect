import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mergeDuplicateModelsSections,
  patchDeepagentsModelRaw,
  patchDeepagentsProviderModelsRaw,
  patchFireconnectRoutingRaw,
  stripFireconnectRoutingRaw,
} from "../lib/deepagents-toml-patch.mjs";
import { parseToml } from "../lib/codex-toml.mjs";
import { fireconnectManaged, resolveDeepagentsOnAuth, updateDeepagentsModel } from "../lib/deepagents-core.mjs";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
      modelSpec: "fireworks:accounts/fireworks/routers/glm-fast-latest",
      modelId: "accounts/fireworks/routers/glm-fast-latest",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      authMode: "env-reference",
    });
    assert.match(next, /default = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
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
      modelSpec: "fireworks:accounts/fireworks/routers/glm-fast-latest",
      modelId: "accounts/fireworks/routers/glm-fast-latest",
      baseUrl: "https://api.fireworks.ai/inference",
      authMode: "literal",
    });

    assert.equal((next.match(/^\[models\]$/gm) || []).length, 1);
    assert.match(next, /default = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
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
      "fireworks:accounts/fireworks/models/glm-5p1",
    );
    assert.match(next, /default = "fireworks:accounts\/fireworks\/models\/glm-5p1"/);
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

  it("updateDeepagentsModel is noop when dcode wrote a multiline provider models array", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-model-"));
    const configPath = path.join(dir, "config.toml");
    const config = [
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
    await writeFile(configPath, config, "utf8");

    const result = await updateDeepagentsModel({
      configPath,
      modelId: "nemotron-3-ultra-nvfp4",
    });

    assert.equal(result.unchanged, true);
    assert.equal(await readFile(configPath, "utf8"), config);
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

  it("updateDeepagentsModel is noop when selecting the current model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-model-"));
    const configPath = path.join(dir, "config.toml");
    const config = [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'models = ["accounts/fireworks/routers/glm-fast-latest"]',
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n");
    await writeFile(configPath, config, "utf8");

    const result = await updateDeepagentsModel({ configPath, modelId: "glm-fast-latest" });

    assert.equal(result.unchanged, true);
    assert.equal(await readFile(configPath, "utf8"), config);
  });

  it("updateDeepagentsModel adds provider models line when re-selecting current model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-model-"));
    const configPath = path.join(dir, "config.toml");
    const config = [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      'recent = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n");
    await writeFile(configPath, config, "utf8");

    const result = await updateDeepagentsModel({ configPath, modelId: "glm-fast-latest" });

    assert.notEqual(result.unchanged, true);
    const updated = await readFile(configPath, "utf8");
    assert.match(updated, /default = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
    assert.match(updated, /recent = "fireworks:accounts\/fireworks\/routers\/glm-fast-latest"/);
    assert.match(updated, /models = \["accounts\/fireworks\/routers\/glm-fast-latest"\]/);
    assert.match(updated, /api_key_env = "FIREWORKS_API_KEY"/);
    assert.equal((updated.match(/^\[models\]$/gm) || []).length, 1);
    assert.equal(fireconnectManaged(parseToml(updated)), true);
  });

  it("updateDeepagentsModel preserves env auth when provider models line is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-deepagents-model-"));
    const configPath = path.join(dir, "config.toml");
    await writeFile(configPath, [
      "[models]",
      'default = "fireworks:accounts/fireworks/routers/glm-fast-latest"',
      "",
      "[models.providers.fireworks]",
      'base_url = "https://api.fireworks.ai/inference"',
      "enabled = true",
      'api_key_env = "FIREWORKS_API_KEY"',
      "",
    ].join("\n"), "utf8");

    await updateDeepagentsModel({ configPath, modelId: "glm-5p1" });

    const updated = await readFile(configPath, "utf8");
    assert.match(updated, /api_key_env = "FIREWORKS_API_KEY"/);
    assert.match(updated, /default = "fireworks:accounts\/fireworks\/models\/glm-5p1"/);
    assert.match(updated, /models = \["accounts\/fireworks\/models\/glm-5p1"\]/);
  });
});

describe("deepagents-core managed detection", () => {
  it("detects fireconnect-managed config", () => {
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
  });
});

describe("resolveDeepagentsOnAuth", () => {
  it("uses env-reference with effectiveKey from the resolver", () => {
    const auth = resolveDeepagentsOnAuth({
      apiKey: "FIREWORKS_API_KEY",
      effectiveKey: "fw_resolved_key",
    });
    assert.equal(auth.mode, "env-reference");
    assert.equal(auth.routingApiKey, "FIREWORKS_API_KEY");
    assert.equal(auth.effectiveApiKey, "fw_resolved_key");
  });

  it("falls back to env when effectiveKey is omitted", () => {
    const auth = resolveDeepagentsOnAuth({
      apiKey: "FIREWORKS_API_KEY",
      envApiKey: "fw_env_key",
    });
    assert.equal(auth.mode, "env-reference");
    assert.equal(auth.effectiveApiKey, "fw_env_key");
  });
});
