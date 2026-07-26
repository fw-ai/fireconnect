import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OPENCODE_CONFIG_RELATIVE_PATH } from "../../../lib/harnesses/opencode/core.mjs";
import { runCli, runCliJson, withTempHome } from "../../helpers.mjs";

async function writeConfig(home, config) {
  const configPath = path.join(home, OPENCODE_CONFIG_RELATIVE_PATH);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

describe("opencode firerouter status", () => {
  it("reports legacy canonical Fireworks routing with a short model", async () => {
    await withTempHome("opencode-fr-status-", async (home) => {
      await writeConfig(home, {
        provider: {
          "fireworks-ai": {
            options: {
              apiKey: "fw_test_key_1234567890",
              headers: { "x-anthropic-api-key": "sk-ant-byok-123" },
            },
            models: { "accounts/fireworks/routers/firerouter": {} },
          },
        },
        model: "fireworks-ai/accounts/fireworks/routers/firerouter",
      });

      const { json, code, stderr } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" } },
      );
      assert.equal(code, 0, stderr);
      assert.equal(json.provider, "fireworks");
      assert.equal(json.hasAuthToken, true);
      assert.equal(json.current.main, "firerouter");

      const human = await runCli(
        ["opencode", "status"],
        { home, env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" } },
      );
      assert.equal(human.code, 0, human.stderr);
      assert.match(human.stdout, /OpenCode/);
      assert.match(human.stdout, /Connection: .*on/);
      assert.match(human.stdout, /Provider: .*Fireworks/);
      assert.match(human.stdout, /Model: firerouter/);
      assert.match(human.stdout, /Auth: stored in config/);
      assert.match(human.stdout, /Key source: literal apiKey in opencode\.json/);
    });
  });

  it("reports short Fireworks routing as the fireworks provider", async () => {
    await withTempHome("opencode-fw-status-", async (home) => {
      await writeConfig(home, {
        provider: {
          "fireworks-ai": {
            options: { apiKey: "fw_test_key_1234567890" },
            models: { "glm-5p2": {} },
          },
        },
        model: "fireworks-ai/glm-5p2",
      });

      const { json, code, stderr } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(code, 0, stderr);
      assert.equal(json.provider, "fireworks");
      assert.equal(json.current.main, "glm-5p2");
    });
  });
});
