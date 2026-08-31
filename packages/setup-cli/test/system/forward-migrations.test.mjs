import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { runHarnessForwardMigrations } from "../../lib/system/forward-migrations.mjs";
import { withTempHome } from "../helpers.mjs";

describe("runHarnessForwardMigrations", () => {
  it("backfills ENABLE_TOOL_SEARCH for an enabled Claude and reports a note", async () => {
    await withTempHome("forward-migrate-claude-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({
          env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
        }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /ENABLE_TOOL_SEARCH/.test(n)).length, 1, notes.join("\n"));
      assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).env.ENABLE_TOOL_SEARCH, "true");
    });
  });

  it("does not touch Claude settings when the harness is off", async () => {
    await withTempHome("forward-migrate-claude-off-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: false, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      const original = `${JSON.stringify({
        env: { ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL },
      }, null, 2)}\n`;
      await writeFile(settingsPath, original, { mode: 0o600 });

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /ENABLE_TOOL_SEARCH/.test(n)).length, 0, notes.join("\n"));
      assert.equal(await readFile(settingsPath, "utf8"), original);
    });
  });

  it("reports a failed migration without skipping finalize", async () => {
    await withTempHome("forward-migrate-failure-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, "{invalid json");

      const notes = await runHarnessForwardMigrations(home);
      assert.ok(
        notes.includes("Couldn't enable MCP tool search for Claude Code — re-run fireconnect claude on."),
        notes.join("\n"),
      );
    });
  });
});
