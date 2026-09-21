import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import {
  providerBackupPath,
  resolveDataDir,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import {
  migrateClaudeAutoModeServerOnUpgrade,
  migrateClaudeExploreInheritCapOnUpgrade,
  migrateClaudeModelPickerOnUpgrade,
  migrateClaudeNativeWebSearchOnUpgrade,
  migrateClaudeToolSearchOnUpgrade,
} from "../../../lib/harnesses/claude/upgrade-migrations.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import {
  cacheServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../../helpers.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  claudeJsonPath,
} from "../../../lib/system/websearch-state.mjs";
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

describe("migrateClaudeAutoModeServerOnUpgrade", () => {
  it("pins the local classifier on managed settings, preserving everything else", async () => {
    await withTempHome("claude-auto-mode-server-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
          MY_CUSTOM_VAR: "keep-me",
        },
      });

      assert.equal(await migrateClaudeAutoModeServerOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, "X-Fireworks-Api-Key: fw_test_key_12345");
      // The rewrite must not widen the mode: the file holds the Fireworks key.
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("leaves a value the user already set alone", async () => {
    await withTempHome("claude-auto-mode-server-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_AUTO_MODE_SERVER: "1",
        },
      });

      assert.equal(await migrateClaudeAutoModeServerOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops on settings FireConnect does not route to Fireworks", async () => {
    await withTempHome("claude-auto-mode-server-native-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      });

      assert.equal(await migrateClaudeAutoModeServerOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("leaves settings alone when the harness is off", async () => {
    await withTempHome("claude-auto-mode-server-off-", async (home) => {
      const { raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, { enabled: false });

      assert.equal(await migrateClaudeAutoModeServerOnUpgrade(home), false);
      assert.equal(await readFile(userSettingsPath(home), "utf8"), raw);
    });
  });
});

describe("migrateClaudeExploreInheritCapOnUpgrade", () => {
  it("lets Explore inherit the session model on managed settings", async () => {
    await withTempHome("claude-explore-inherit-cap-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          MY_CUSTOM_VAR: "keep-me",
        },
      });

      assert.equal(await migrateClaudeExploreInheritCapOnUpgrade(home), true);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP, "1");
      assert.equal(settings.env.MY_CUSTOM_VAR, "keep-me");
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("leaves a value the user already set alone", async () => {
    await withTempHome("claude-explore-inherit-cap-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: {
          ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
          CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: "0",
        },
      });

      assert.equal(await migrateClaudeExploreInheritCapOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("no-ops when the harness is off or unrouted", async () => {
    await withTempHome("claude-explore-inherit-cap-off-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, { enabled: false });

      assert.equal(await migrateClaudeExploreInheritCapOnUpgrade(home), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });
});

describe("migrateClaudeNativeWebSearchOnUpgrade", () => {
  it("removes the retired MCP and FireConnect's legacy WebSearch denial", async () => {
    await withTempHome("claude-native-websearch-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
        permissions: { deny: ["Bash(rm:*)", "WebSearch", "WebFetch"] },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        configPath: settingsPath,
        snapshot: {
          existed: true,
          raw: JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
        },
      }));
      await writeFile(claudeJsonPath(home), JSON.stringify({
        mcpServers: {
          "user-server": { command: "echo" },
          [WEBSEARCH_MCP_SERVER_NAME]: { type: "http", url: "https://mcp.fireworks.ai/work/mcp" },
        },
      }));

      assert.equal(await migrateClaudeNativeWebSearchOnUpgrade(home), true);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(settings.permissions.deny, ["Bash(rm:*)"]);
      const claudeJson = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
      assert.deepEqual(claudeJson.mcpServers, { "user-server": { command: "echo" } });
    });
  });

  it("preserves a WebSearch denial from the user's original snapshot", async () => {
    await withTempHome("claude-native-websearch-user-deny-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
        permissions: { deny: ["WebSearch", "WebFetch"] },
      });
      const backupPath = providerBackupPath(resolveDataDir({ home }));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        configPath: settingsPath,
        snapshot: {
          existed: true,
          raw: JSON.stringify({ permissions: { deny: ["WebSearch", "WebFetch"] } }),
        },
      }));

      assert.equal(await migrateClaudeNativeWebSearchOnUpgrade(home), false);
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(settings.permissions.deny, ["WebSearch", "WebFetch"]);
    });
  });
});

describe("migrateClaudeModelPickerOnUpgrade", () => {
  const CATALOG_ROWS = [
    mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p3",
      displayName: "GLM 5.3",
      aliases: ["accounts/fireworks/routers/glm-latest"],
    }),
    mockServerlessModel({
      name: "accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3",
      aliases: ["accounts/fireworks/routers/kimi-latest"],
    }),
  ];

  async function seedCatalogFor(home) {
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(CATALOG_ROWS));
    } finally {
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
    }
  }

  // The catalog cache (and any env-HOME reader) resolves process.env.HOME
  // implicitly; the in-process migration needs the temp home there, matching
  // what a spawned CLI child gets via its env.
  async function withHome(home, fn) {
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      return await fn();
    } finally {
      process.env.HOME = prevHome;
      setServerlessCatalogSnapshot(null);
    }
  }

  const FIREWORKS_ENV = {
    ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
    ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key_12345",
  };

  function managedPicker(options) {
    return { fireconnectManaged: true, replaceBuiltInOptions: false, options };
  }

  it("refreshes stale descriptions and preserves extra rows", async () => {
    await withTempHome("claude-picker-refresh-", async (home) => {
      const { settingsPath } = await seedSettings(home, {
        env: FIREWORKS_ENV,
        modelPicker: managedPicker([
          { model: "auto[1m]", label: "Auto", description: "STALE DESCRIPTION" },
          { model: "glm-latest[1m]", label: "GLM (OLD)", description: "old" },
          { model: "deepseek-v3[1m]", label: "Custom", description: "added via --model" },
        ]),
      });
      await seedCatalogFor(home);

      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), true);

      const options = JSON.parse(await readFile(settingsPath, "utf8"))
        .modelPicker.options;
      const byModel = Object.fromEntries(options.map((row) => [row.model, row]));
      assert.notEqual(byModel["auto[1m]"].description, "STALE DESCRIPTION");
      assert.notEqual(byModel["glm-latest[1m]"].description, "old");
      // A --model extra the catalog doesn't list survives the refresh.
      assert.equal(byModel["deepseek-v3[1m]"].description, "added via --model");
      // New catalog rows appear.
      assert.ok(byModel["kimi-latest[1m]"]);
      assert.ok(byModel["firerouter[1m]"] || options.some((row) => row.model.startsWith("firerouter")));
      // The rewrite must not widen the mode: the file holds the Fireworks key.
      assert.equal((await stat(settingsPath)).mode & 0o077, 0);
    });
  });

  it("is a no-op when the options are already current", async () => {
    await withTempHome("claude-picker-current-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: FIREWORKS_ENV,
        modelPicker: managedPicker([]),
      });
      await seedCatalogFor(home);
      // First run writes the current catalog; a second run must be a no-op.
      await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home));
      const afterFirst = await readFile(settingsPath, "utf8");
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(settingsPath, "utf8"), afterFirst);
      assert.notEqual(afterFirst, raw);
    });
  });

  it("leaves a user-authored (unmanaged) picker exactly as-is", async () => {
    await withTempHome("claude-picker-user-", async (home) => {
      const { settingsPath, raw } = await seedSettings(home, {
        env: FIREWORKS_ENV,
        modelPicker: {
          replaceBuiltInOptions: false,
          options: [{ model: "auto[1m]", label: "My Auto", description: "mine" }],
        },
      });
      await seedCatalogFor(home);
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);
    });
  });

  it("does nothing when the harness is off or not Fireworks-routed", async () => {
    await withTempHome("claude-picker-off-", async (home) => {
      const { settingsPath, raw } = await seedSettings(
        home,
        { env: FIREWORKS_ENV, modelPicker: managedPicker([{ model: "auto[1m]", label: "Auto", description: "x" }]) },
        { enabled: false },
      );
      await seedCatalogFor(home);
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(settingsPath, "utf8"), raw);

      const native = await seedSettings(home, {
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        modelPicker: managedPicker([{ model: "auto[1m]", label: "Auto", description: "x" }]),
      });
      assert.equal(await withHome(home, () => migrateClaudeModelPickerOnUpgrade(home)), false);
      assert.equal(await readFile(native.settingsPath, "utf8"), native.raw);
    });
  });
});
