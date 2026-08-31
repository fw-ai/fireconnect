import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import { userSettingsPath } from "../../../lib/harnesses/claude/core.mjs";
import { migrateClaudeToolSearchOnUpgrade } from "../../../lib/harnesses/claude/upgrade-migrations.mjs";
import { withTempHome } from "../../helpers.mjs";

async function seedSettings(home, settings, { enabled = true } = {}) {
  await writeGlobalConfig(home, {
    harnesses: { claude: { enabled, provider: "fireworks" } },
  });
  const settingsPath = userSettingsPath(home);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const raw = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(settingsPath, raw, { mode: 0o600 });
  return { settingsPath, raw };
}

describe("migrateClaudeToolSearchOnUpgrade", () => {
  it("adds ENABLE_TOOL_SEARCH to managed settings, preserving everything else", async () => {
    await withTempHome("claude-tool-search-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
          MY_CUSTOM_VAR: "keep-me",
        },
        permissions: { deny: ["WebSearch"] },
      });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.ENABLE_TOOL_SEARCH, "true");
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, "X-Fireworks-Api-Key: fw_test_key_12345");
      assert.deepEqual(settings.permissions.deny, ["WebSearch"]);
      // The rewrite must not widen the mode: the file holds the Fireworks key.
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("leaves a value the user already set alone", async () => {
    await withTempHome("claude-tool-search-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ENABLE_TOOL_SEARCH: "false",
        },
      });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops on settings FireConnect does not route to Fireworks", async () => {
    await withTempHome("claude-tool-search-native-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops when there is no settings file", async () => {
    await withTempHome("claude-tool-search-missing-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
    });
  });

  it("leaves settings alone when the harness is off", async () => {
    await withTempHome("claude-tool-search-off-", async (home) => {
      const { raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, { enabled: false });

      assert.equal(await migrateClaudeToolSearchOnUpgrade(home), false);
      assert.equal(await readFile(userSettingsPath(home), "utf8"), raw);
    });
  });
});
