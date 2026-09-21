import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../lib/io/json.mjs";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { codexCatalogPath, codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { runHarnessForwardMigrations } from "../../lib/system/forward-migrations.mjs";
import { warmTestCatalogSnapshot, withTempHome } from "../helpers.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";

describe("runHarnessForwardMigrations", () => {
  before(() => {
    warmTestCatalogSnapshot();
  });

  after(() => {
    setServerlessCatalogSnapshot(null);
  });

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

  it("backfills CLAUDE_CODE_AUTO_MODE_SERVER=0 for an enabled Claude and reports a note", async () => {
    await withTempHome("forward-migrate-claude-ams-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
            ENABLE_TOOL_SEARCH: "true",
          },
        }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /CLAUDE_CODE_AUTO_MODE_SERVER/.test(n)).length, 1, notes.join("\n"));
      assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).env.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
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

  it("removes the stale Codex web_search override for an enabled harness", async () => {
    await withTempHome("forward-migrate-codex-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { codex: { enabled: true, provider: "fireworks" } },
      });
      const configPath = codexConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, [
        'model_provider = "fireworks-ai"',
        'model = "glm-5p1"',
        'web_search = "disabled"',
        "",
        "[model_providers.fireworks-ai]",
        'base_url = "https://api.fireworks.ai/inference/v1"',
        'experimental_bearer_token = "fw_test_key"',
        "",
      ].join("\n"), { mode: 0o600 });

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /Codex web search/.test(n)).length, 1, notes.join("\n"));
      assert.doesNotMatch(await readFile(configPath, "utf8"), /^web_search\s*=/m);
    });
  });

  it("preserves a user-set Codex web_search value", async () => {
    await withTempHome("forward-migrate-codex-user-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { codex: { enabled: true, provider: "fireworks" } },
      });
      const configPath = codexConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      const original = [
        'model_provider = "fireworks-ai"',
        'model = "glm-5p1"',
        'web_search = "live"',
        "",
        "[model_providers.fireworks-ai]",
        'base_url = "https://api.fireworks.ai/inference/v1"',
        'experimental_bearer_token = "fw_test_key"',
      ].join("\n");
      await writeFile(configPath, original, { mode: 0o600 });

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /Codex web search/.test(n)).length, 0, notes.join("\n"));
      const migrated = await readFile(configPath, "utf8");
      assert.match(migrated, /^web_search = "live"$/m);
      // No catalog file exists, so the auto backfill leaves the config alone
      // (a fresh offline `on` writes no catalog either).
      assert.doesNotMatch(migrated, /model_catalog_json/);
    });
  });

  it("adds auto only to an existing referenced Codex catalog", async () => {
    await withTempHome("forward-migrate-codex-auto-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { codex: { enabled: true, provider: "fireworks" } },
      });
      const configPath = codexConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      const managed = (ref) => [
        'model_provider = "fireworks-ai"',
        'model = "glm-5p1"',
        ...(ref ? ['model_catalog_json = "~/.codex/fireworks-model-catalog.json"'] : []),
        "",
        "[model_providers.fireworks-ai]",
        'base_url = "https://api.fireworks.ai/inference/v1"',
        'experimental_bearer_token = "fw_test_key"',
      ].join("\n");
      const catalogPath = codexCatalogPath(home);

      // Referenced catalog without auto: auto row prepended, ref untouched.
      await writeFile(configPath, managed(true), { mode: 0o600 });
      await writeJson(catalogPath, { models: [{ slug: "glm-5p1" }] });
      const noted = await runHarnessForwardMigrations(home);
      assert.equal(noted.filter((n) => /auto model to Codex/.test(n)).length, 1, noted.join("\n"));
      assert.deepEqual(
        (await readJsonIfExists(catalogPath)).models.map((row) => row.slug),
        ["auto", "glm-5p1"],
      );

      // No catalog file at all: nothing created, config untouched.
      await rm(catalogPath, { force: true });
      const before = await readFile(configPath, "utf8");
      const silent = await runHarnessForwardMigrations(home);
      assert.equal(silent.filter((n) => /auto model to Codex/.test(n)).length, 0, silent.join("\n"));
      assert.equal(await readFile(configPath, "utf8"), before);
      assert.equal(existsSync(catalogPath), false);
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

  it("reports a corrupt managed config instead of silently skipping it", async () => {
    await withTempHome("forward-migrate-corrupt-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, "{invalid json");

      const notes = await runHarnessForwardMigrations(home);
      assert.ok(
        notes.includes("Couldn't add the auto model to OpenCode — re-run fireconnect opencode on."),
        notes.join("\n"),
      );
    });
  });

  it("adds auto to OpenCode and Pi catalogs with one note each", async () => {
    await withTempHome("forward-migrate-auto-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: {
          opencode: { enabled: true, provider: "fireworks" },
          pi: { enabled: true, provider: "fireworks", profiles: { managedModelIds: [] } },
        },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({
          model: "fireworks-ai/glm-latest",
          provider: {
            "fireworks-ai": {
              options: { apiKey: "fw_test_key_12345" },
              models: { "glm-latest": { name: "GLM Latest" } },
            },
          },
        })}\n`,
      );
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await writeFile(
        piSettingsPath(home),
        `${JSON.stringify({
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/routers/glm-latest",
          enabledModels: ["fireworks/accounts/fireworks/routers/*"],
        })}\n`,
      );
      await writeFile(
        path.join(home, ".pi/agent", "auth.json"),
        `${JSON.stringify({ fireworks: { type: "api_key", key: "fw_test_key_12345", managedBy: "fireconnect" } })}\n`,
      );
      await writeFile(
        piModelsPath(home),
        `${JSON.stringify({ providers: { fireworks: { models: [{ id: "accounts/fireworks/routers/glm-latest" }] } } })}\n`,
      );

      const notes = await runHarnessForwardMigrations(home);
      assert.deepEqual(
        notes.filter((n) => /auto model to/.test(n)),
        ["Added the auto model to OpenCode and Pi — restart them to pick it up."],
        notes.join("\n"),
      );
      const opencode = JSON.parse(await readFile(configPath, "utf8"));
      assert.ok(opencode.provider["fireworks-ai"].models.auto);
      const piModels = JSON.parse(await readFile(piModelsPath(home), "utf8"));
      assert.ok(piModels.providers.fireworks.models.some((m) => m.id === "auto"));
    });
  });

  it("leaves managed configs alone when their harnesses are off", async () => {
    await withTempHome("forward-migrate-auto-off-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: {
          opencode: { enabled: false, provider: "fireworks" },
          pi: { enabled: false, provider: "fireworks", profiles: { managedModelIds: [] } },
        },
      });
      const configPath = opencodeConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      const original = `${JSON.stringify({
        model: "fireworks-ai/glm-latest",
        provider: {
          "fireworks-ai": {
            options: { apiKey: "fw_test_key_12345" },
            models: { "glm-latest": { name: "GLM Latest" } },
          },
        },
      })}\n`;
      await writeFile(configPath, original);
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      const settingsPath = piSettingsPath(home);
      const originalSettings = `${JSON.stringify({
        defaultProvider: "fireworks",
        defaultModel: "accounts/fireworks/routers/glm-latest",
        enabledModels: ["fireworks/accounts/fireworks/routers/*"],
      })}\n`;
      await writeFile(settingsPath, originalSettings);

      const notes = await runHarnessForwardMigrations(home);
      assert.equal(notes.filter((n) => /auto model to/.test(n)).length, 0, notes.join("\n"));
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    });
  });
});
