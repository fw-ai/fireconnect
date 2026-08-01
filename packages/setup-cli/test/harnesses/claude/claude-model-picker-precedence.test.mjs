import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  hasLegacyAnthropicMainEnv,
  mappingFromSettings,
  migrateLegacyAnthropicMainEnv,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import { CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING } from "../../../lib/harnesses/claude/index.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import { assertClaudeMainModel, runFireconnect, withTempHome } from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_claude_matrix_key_000000000000";
const KIMI_MODEL = "kimi-fast-latest";

describe("Claude main model storage", () => {
  it("honors /model picker choice because main no longer lives in env", async () => {
    await withTempHome("claude-model-picker-", async (home) => {
      const settingsPath = userSettingsPath(home);
      const env = {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      };

      await runFireconnect(
        ["claude", "on", "--api-key", FIREWORKS_KEY, "--anthropic-api-key", "sk-ant-test"],
        env,
      );

      let settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.model = `${KIMI_MODEL}[1m]`;
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));

      settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(mappingFromSettings(settings).main, "kimi-fast-latest");
      assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
    });
  });

  it("--model sets the durable main default and re-on preserves it", async () => {
    await withTempHome("claude-model-flag-", async (home) => {
      const settingsPath = userSettingsPath(home);
      const env = {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      };

      const enabled = await runFireconnect(
        ["claude", "on", "--model", "kimi-fast-latest", "--api-key", FIREWORKS_KEY, "--anthropic-api-key", "sk-ant-test"],
        env,
      );
      assert.equal(enabled.code, 0, enabled.stderr);
      assertClaudeMainModel(JSON.parse(await readFile(settingsPath, "utf8")), KIMI_MODEL);

      const reon = await runFireconnect(["claude", "on"], env);
      assert.equal(reon.code, 0, reon.stderr);
      assertClaudeMainModel(JSON.parse(await readFile(settingsPath, "utf8")), KIMI_MODEL);
    });
  });

});

describe("mappingFromSettings", () => {
  it("reads legacy ANTHROPIC_MODEL when top-level model is absent", () => {
    const mapping = mappingFromSettings({
      env: { ANTHROPIC_MODEL: "glm-fast-latest[1m]" },
    });
    assert.equal(mapping.main, "glm-fast-latest");
  });

  it("prefers top-level model over legacy ANTHROPIC_MODEL", () => {
    const mapping = mappingFromSettings({
      model: "kimi-fast-latest[1m]",
      env: { ANTHROPIC_MODEL: "glm-fast-latest[1m]" },
    });
    assert.equal(mapping.main, "kimi-fast-latest");
  });

  it("strips Claude Code context suffixes from all slots", () => {
    const mapping = mappingFromSettings({
      model: "firerouter[1m]",
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-fast-latest[1m]",
        CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
      },
    });
    assert.equal(mapping.main, "firerouter");
    assert.equal(mapping.opus, "glm-fast-latest");
    assert.equal(mapping.subagent, "deepseek-v4-flash");
  });

  it("detects legacy main env on Fireworks-routed settings", () => {
    assert.equal(hasLegacyAnthropicMainEnv({
      model: "kimi-fast-latest[1m]",
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_MODEL: "firerouter[1m]",
      },
    }), true);
  });

  it("migrateLegacyAnthropicMainEnv strips legacy keys without touching other env", () => {
    const { settings, changed } = migrateLegacyAnthropicMainEnv({
      model: "kimi-fast-latest[1m]",
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_MODEL: "firerouter[1m]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-fast-latest[1m]",
        USER_ENV: "keep-me",
      },
    });
    assert.equal(changed, true);
    assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-fast-latest[1m]");
    assert.equal(settings.env.USER_ENV, "keep-me");
    assert.equal(settings.model, "kimi-fast-latest[1m]");
  });

  it("status warns when legacy ANTHROPIC_MODEL is still present", async () => {
    await withTempHome("claude-legacy-status-", async (home) => {
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({
        model: "kimi-fast-latest[1m]",
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_MODEL: "firerouter[1m]",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_claude_matrix_key_000000000000",
        },
      }, null, 2));

      const status = await runFireconnect(["claude", "status"], {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      });
      assert.equal(status.code, 0, status.stderr);
      assert.match(status.stdout, new RegExp(CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  });
});
