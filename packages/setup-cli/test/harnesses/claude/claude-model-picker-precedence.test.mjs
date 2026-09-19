import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  hasLegacyAnthropicMainEnv,
  mappingFromSettings,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import { CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING } from "../../../lib/harnesses/claude/index.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel, runFireconnect, withTempHome } from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_claude_matrix_key_000000000000";

/** Persist the alias catalog a spawned CLI child resolves kimi-fast-latest through. */
function seedCatalogFor(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        input_modalities: ["text", "image"],
        aliases: ["accounts/fireworks/routers/kimi-fast-latest"],
      }),
    ]));
  } finally {
    process.env.HOME = prevHome;
    setServerlessCatalogSnapshot(null);
  }
}
const KIMI_MODEL = "kimi-fast-latest";
const KIMI_MODEL_STORED = `${KIMI_MODEL}[1m]`;

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

  it("--model adds to the picker and pins the FireRouter default", async () => {
    await withTempHome("claude-model-flag-", async (home) => {
      seedCatalogFor(home);
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
      let settings = JSON.parse(await readFile(settingsPath, "utf8"));
      // --model never pins main, but nothing servable was selected → FireRouter default.
      assert.equal(settings.model, "firerouter[1m]");
      assert.ok(
        settings.modelPicker?.options?.some((row) => row.model === KIMI_MODEL_STORED),
        settings.modelPicker?.options?.map((row) => row.model).join(", "),
      );

      const reon = await runFireconnect(["claude", "on"], env);
      assert.equal(reon.code, 0, reon.stderr);
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.model, "firerouter[1m]");
      assert.ok(settings.modelPicker?.options?.some((row) => row.model === KIMI_MODEL_STORED));
    });
  });

  it("re-on keeps a /model Enter default that the picker serves", async () => {
    // Regression: Claude Code saves the /model Enter selection as the top-level
    // `model` (the default for new sessions). A re-`on` used to delete it
    // unconditionally, silently dropping new sessions back to Opus.
    await withTempHome("claude-model-keep-", async (home) => {
      seedCatalogFor(home);
      const settingsPath = userSettingsPath(home);
      const env = {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      };

      const enabled = await runFireconnect(
        ["claude", "on", "--api-key", FIREWORKS_KEY, "--anthropic-api-key", "sk-ant-test"],
        env,
      );
      assert.equal(enabled.code, 0, enabled.stderr);

      // Simulate the user's /model Enter: picker row saved as top-level model.
      let settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.model = KIMI_MODEL_STORED;
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));

      const reon = await runFireconnect(["claude", "on"], env);
      assert.equal(reon.code, 0, reon.stderr);
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.model, KIMI_MODEL_STORED, "user's saved default survives re-on");
    });
  });

  it("re-on still drops a stale pin the picker can't serve", async () => {
    await withTempHome("claude-model-drop-", async (home) => {
      seedCatalogFor(home);
      const settingsPath = userSettingsPath(home);
      const env = {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      };

      const enabled = await runFireconnect(
        ["claude", "on", "--api-key", FIREWORKS_KEY, "--anthropic-api-key", "sk-ant-test"],
        env,
      );
      assert.equal(enabled.code, 0, enabled.stderr);

      let settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.model = "deepseek-v3[1m]";
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));

      const reon = await runFireconnect(["claude", "on"], env);
      assert.equal(reon.code, 0, reon.stderr);
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.model, "firerouter[1m]", "unservable pin is replaced by the FireRouter default");
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

  // A bare `/model` picker alias (opus/sonnet/haiku/fable) is the user's own
  // picker choice — it resolves at request time through the alias's env slot,
  // which the slot rows report separately. It is NOT a FireConnect model pin,
  // so it must read as native (unpinned) main, never as a Fireworks model id
  // that `claude status` would surface as a bogus "main -> opus" override row.
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
    it(`treats bare /model alias ${alias} as unpinned native main`, () => {
      const mapping = mappingFromSettings({
        model: `${alias}[1m]`,
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: "firerouter[1m]",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash-latest[1m]",
        },
      });
      assert.equal(mapping.main, "claude-default");
      assert.equal(mapping.opus, "firerouter");
      assert.equal(mapping.haiku, "deepseek-flash-latest");
    });
  }

  it("still reads a concrete top-level model (not an alias) as main", () => {
    const mapping = mappingFromSettings({
      model: "kimi-fast-latest[1m]",
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "firerouter[1m]" },
    });
    assert.equal(mapping.main, "kimi-fast-latest");
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
