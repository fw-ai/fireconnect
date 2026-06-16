import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveFireworksApiKey } from "../lib/fireworks-models.mjs";
import {
  FW_CLAUDE_KEY,
  FW_OPENCODE_KEY,
  claudePaths,
  withTempHome,
  writeClaudeSettings,
  writeNativeAnthropicSettings,
  writeOpencodeConfig,
} from "./helpers.mjs";

describe("resolveFireworksApiKey", () => {
  test("without harness prefers Claude over OpenCode", async () => {
    await withTempHome("both-keys", async (home) => {
      const { settingsPath, dataDir } = claudePaths(home);
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const configPath = await writeOpencodeConfig(home, FW_OPENCODE_KEY);

      const resolved = await resolveFireworksApiKey({
        harness: "",
        settingsPath,
        dataDir,
        configPath,
      });
      assert.equal(resolved, FW_CLAUDE_KEY);
    });
  });

  test("without harness falls back to OpenCode", async () => {
    await withTempHome("oc-only", async (home) => {
      const { settingsPath, dataDir } = claudePaths(home);
      const configPath = await writeOpencodeConfig(home, FW_OPENCODE_KEY);

      const resolved = await resolveFireworksApiKey({
        harness: "",
        settingsPath,
        dataDir,
        configPath,
      });
      assert.equal(resolved, FW_OPENCODE_KEY);
    });
  });

  test("skips non-Fireworks-shaped Claude tokens", async () => {
    await withTempHome("skip-ant", async (home) => {
      const { settingsPath, dataDir } = claudePaths(home);
      await writeNativeAnthropicSettings(home);
      const configPath = await writeOpencodeConfig(home, FW_OPENCODE_KEY);

      const resolved = await resolveFireworksApiKey({
        harness: "",
        settingsPath,
        dataDir,
        configPath,
      });
      assert.equal(resolved, FW_OPENCODE_KEY);
    });
  });

  test("with harness opencode ignores Claude", async () => {
    await withTempHome("harness-oc", async (home) => {
      const { settingsPath, dataDir } = claudePaths(home);
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const configPath = await writeOpencodeConfig(home, FW_OPENCODE_KEY);

      const resolved = await resolveFireworksApiKey({
        harness: "opencode",
        settingsPath,
        dataDir,
        configPath,
      });
      assert.equal(resolved, FW_OPENCODE_KEY);
    });
  });
});
