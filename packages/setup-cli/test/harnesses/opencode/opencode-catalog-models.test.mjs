import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enableOpencodeFireworks,
  opencodeNeedsProviderModelOverride,
} from "../../../lib/harnesses/opencode/core.mjs";

describe("opencode catalog model handling", () => {
  it("identifies router overrides vs models.dev catalog entries", () => {
    for (const alias of [
      "glm-fast-latest",
      "glm-latest",
      "kimi-fast-latest",
      "kimi-latest",
      "minimax-latest",
      "qwen-plus-latest",
    ]) {
      assert.equal(opencodeNeedsProviderModelOverride(alias), true, alias);
      assert.equal(
        opencodeNeedsProviderModelOverride(`accounts/fireworks/routers/${alias}`),
        true,
        alias,
      );
    }
    assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/models/deepseek-v4-flash"), false);
    assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/routers/glm-5p2-fast"), false);
    assert.equal(opencodeNeedsProviderModelOverride("accounts/fireworks/routers/kimi-k2p7-code-fast"), false);
    assert.equal(opencodeNeedsProviderModelOverride("firerouter"), true);
  });

  it("writes provider model overrides only for routers, not catalog models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-models-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });

    const catalogModelIds = [
      "accounts/fireworks/routers/glm-fast-latest",
      "accounts/fireworks/routers/glm-latest",
      "accounts/fireworks/routers/kimi-fast-latest",
      "accounts/fireworks/routers/minimax-latest",
      "accounts/fireworks/routers/qwen-plus-latest",
      "accounts/fireworks/models/deepseek-v4-flash",
      "accounts/fireworks/routers/glm-5p2-fast",
    ];

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      modelId: "deepseek-v4-flash",
      catalogModelIds,
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.model, "fireworks-ai/accounts/fireworks/models/deepseek-v4-flash");
    const models = config.provider["fireworks-ai"].models;
    assert.equal(models["deepseek-v4-flash"], undefined);
    assert.equal(models["glm-5p2-fast"], undefined);
    assert.ok(models["glm-fast-latest"]);
    assert.ok(models["glm-latest"]);
    assert.ok(models["kimi-fast-latest"]);
    assert.ok(models["minimax-latest"]);
    assert.ok(models["qwen-plus-latest"]);
  });

  it("rebuilds router overrides offline instead of copying stale provider.models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-offline-"));
    const configPath = path.join(home, "opencode.json");
    const dataDir = path.join(home, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      model: "fireworks-ai/kimi-latest",
      provider: {
        "fireworks-ai": {
          options: { apiKey: "fw_test_key_12345" },
          models: {
            "kimi-latest": { name: "kimi-latest" },
            "glm-fast-latest": { name: "glm-fast-latest" },
          },
        },
      },
    })}\n`);

    await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      effectiveApiKey: "fw_test_key_12345",
      modelId: "kimi-latest",
      catalogModelIds: [],
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const models = config.provider["fireworks-ai"].models;
    assert.deepEqual(models["kimi-latest"].modalities, { input: ["text", "image"] });
    assert.equal(models["glm-fast-latest"].modalities, undefined);
  });
});
