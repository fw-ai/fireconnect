import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  providerBackupPath,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import { refreshFirerouterClaudeKey } from "../../../lib/harnesses/claude/firerouter.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../../lib/io/json.mjs";
import { FIRECONNECT_REFERER, runFireconnect, assertClaudeMainModel } from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";
const ANTHROPIC_KEY = "sk-ant-test-12345";
const FIREROUTER_MODEL = "firerouter[1m]";
const LEGACY_FIREROUTER_MODEL = "accounts/fireworks/routers/firerouter[1m]";
const DIRECT_MAIN_MODEL = "kimi-fast-latest[1m]";
const DIRECT_ALIAS_MODEL = "deepseek-pro-latest[1m]";
const KIMI_FABLE_MODEL = "kimi-fast-latest[1m]";
const LEGACY_FIREROUTER_BASE_URL = "https://router.fireworks.ai";
const LEGACY_DESKTOP_GUARD_COMMAND = "node /old/fireconnect-desktop-guard.mjs";
const USER_HOOK = {
  matcher: "startup",
  hooks: [{ type: "command", command: "echo user-hook" }],
};

function legacyRouterSettings() {
  return {
    model: LEGACY_FIREROUTER_MODEL,
    env: {
      ANTHROPIC_BASE_URL: LEGACY_FIREROUTER_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: ANTHROPIC_KEY,
      ANTHROPIC_CUSTOM_HEADERS: [
        `X-FireRouter-Fireworks-Key: ${FIREWORKS_KEY}`,
        "X-User-Header: keep-me",
      ].join("\n"),
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      USER_ENV: "keep-me",
    },
    hooks: {
      SessionStart: [
        USER_HOOK,
        {
          matcher: "startup",
          hooks: [{ type: "command", command: LEGACY_DESKTOP_GUARD_COMMAND }],
        },
      ],
    },
    permissions: {
      allow: ["Bash(ls:*)"],
      deny: ["Bash(rm:*)", "WebSearch", "WebFetch"],
    },
    unrelated: { keep: true },
  };
}

function assertLegacyRouterIntentPreserved(settings) {
  assertClaudeMainModel(settings, FIREROUTER_MODEL);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREROUTER_MODEL);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, FIREROUTER_MODEL);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FIREROUTER_MODEL);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, FIREROUTER_MODEL);
  assert.equal(
    settings.env.CLAUDE_CODE_SUBAGENT_MODEL,
    "firerouter",
  );
  assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
}

function cliEnv(home) {
  return {
    HOME: home,
    FIREWORKS_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
}

describe("Claude slot-level FireRouter", () => {
  it("--opus firerouter keeps the recommended primary and other defaults", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slot-router-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--opus", "firerouter",
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.model, undefined);
    assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREROUTER_MODEL);
    // Sonnet stays native, so its alias env key is never written.
    assert.equal(
      settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      undefined,
    );
    assert.equal(
      settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      "deepseek-flash-latest[1m]",
    );
    assert.equal(
      settings.env.CLAUDE_CODE_SUBAGENT_MODEL,
      "deepseek-flash-latest",
    );
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_test_key_12345/);
    assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
    assert.equal(settings.env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /X-Title: Claude Code/);
    assert.ok(
      settings.env.ANTHROPIC_CUSTOM_HEADERS.includes(`HTTP-Referer: ${FIRECONNECT_REFERER}`),
      settings.env.ANTHROPIC_CUSTOM_HEADERS,
    );
    assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
  });

  it("allows an explicit FireRouter slot without detecting native auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-auth-optional-"));
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(settingsPath, original);

    const result = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--opus", "firerouter"],
      cliEnv(home),
    );

    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "firerouter[1m]");
    // Claude Code owns login; FireConnect never injects a Fireworks auth token.
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.notDeepEqual(await readJsonIfExists(providerBackupPath(dataDir)), {});
  });

  it("explicit firerouter with --anthropic-api-key does not use Fireworks token auth fallback", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-byok-no-fallback-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--opus", "firerouter",
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.doesNotMatch(result.stdout, /FireRouter off/);
  });

  it("supports independent FireRouter slots", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-multi-router-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--opus", "firerouter",
        "--fable", "firerouter",
        "--sonnet", "glm-latest",
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.model, undefined);
    assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREROUTER_MODEL);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, FIREROUTER_MODEL);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-latest[1m]");
  });

  it("plain re-on preserves slot mappings and accepts router-only options", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slot-reon-"));
    const env = cliEnv(home);
    const first = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--opus", "firerouter",
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      env,
    );
    assert.equal(first.code, 0, first.stderr);

    const preference = await runFireconnect(
      ["claude", "on", "--routing-preference", "max-savings"],
      env,
    );
    assert.equal(preference.code, 0, preference.stderr);
    let settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.model, undefined);
    assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREROUTER_MODEL);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-routing-preference: 5/);

    const byok = await runFireconnect(
      ["claude", "on", "--anthropic-api-key", ANTHROPIC_KEY],
      env,
    );
    assert.equal(byok.code, 0, byok.stderr);
    settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.env.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
    assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
  });

  it("off restores the original settings byte-for-byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slot-off-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify({
      model: "sonnet",
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
    }, null, 2)}\n`;
    await writeFile(settingsPath, original);

    const on = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--opus", "firerouter"],
      cliEnv(home),
    );
    assert.equal(on.code, 0, on.stderr);
    const off = await runFireconnect(["claude", "off"], cliEnv(home));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });

  it("preserves a legacy full-router mapping as explicit slot choices", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-legacy-router-"));
    const settingsPath = userSettingsPath(home);
    await writeJson(settingsPath, {
      model: LEGACY_FIREROUTER_MODEL,
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_MODEL: LEGACY_FIREROUTER_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: LEGACY_FIREROUTER_MODEL,
        ANTHROPIC_DEFAULT_FABLE_MODEL: LEGACY_FIREROUTER_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "accounts/fireworks/routers/glm-latest[1m]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "accounts/fireworks/models/deepseek-v4-flash",
        CLAUDE_CODE_SUBAGENT_MODEL: "accounts/fireworks/models/deepseek-v4-flash",
        ANTHROPIC_API_KEY: "fireconnect",
        ANTHROPIC_AUTH_TOKEN: ANTHROPIC_KEY,
        ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${FIREWORKS_KEY}`,
      },
    });

    const reon = await runFireconnect(["claude", "on"], cliEnv(home));
    assert.equal(reon.code, 0, reon.stderr);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assertClaudeMainModel(settings, FIREROUTER_MODEL);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREROUTER_MODEL);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, FIREROUTER_MODEL);
  });

  it("upgrades a v0.8 router values backup through a clean v0.9 snapshot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-v08-backup-upgrade-"));
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".fireconnect/claude");
    const backupPath = providerBackupPath(dataDir);
    await writeJson(settingsPath, legacyRouterSettings());
    await writeJson(backupPath, {
      values: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_AUTH_TOKEN: "sk-ant-original",
        ANTHROPIC_CUSTOM_HEADERS: "X-User-Header: keep-me",
      },
      missing: [],
      topLevel: {
        values: { model: "sonnet" },
        missing: ["effortLevel", "apiKeyHelper"],
      },
    });

    const upgrade = await runFireconnect(["claude", "on"], cliEnv(home));
    assert.equal(upgrade.code, 0, upgrade.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assertLegacyRouterIntentPreserved(enabled);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_test_key_12345/);
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-original");
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-User-Header: keep-me/);
    assert.deepEqual(enabled.permissions, {
      allow: ["Bash(ls:*)"],
      deny: ["Bash(rm:*)", "WebSearch", "WebFetch"],
    });
    assert.deepEqual(enabled.unrelated, { keep: true });
    assert.deepEqual(enabled.hooks.SessionStart, [USER_HOOK]);
    assert.equal(
      enabled.hooks.SessionStart.filter(
        (entry) => entry.hooks[0].command.includes("fireconnect-desktop-guard.mjs"),
      ).length,
      0,
    );

    const upgradedBackup = await readJsonIfExists(backupPath);
    assert.equal(upgradedBackup.values, undefined);
    assert.equal(upgradedBackup.configPath, settingsPath);
    assert.equal(upgradedBackup.snapshot.existed, true);
    const baseline = JSON.parse(upgradedBackup.snapshot.raw);
    assert.deepEqual(baseline, {
      model: "sonnet",
      env: {
        USER_ENV: "keep-me",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_AUTH_TOKEN: "sk-ant-original",
        ANTHROPIC_CUSTOM_HEADERS: "X-User-Header: keep-me",
      },
      hooks: { SessionStart: [USER_HOOK] },
      permissions: {
        allow: ["Bash(ls:*)"],
        deny: ["Bash(rm:*)"],
      },
      unrelated: { keep: true },
    });

    const off = await runFireconnect(["claude", "off"], cliEnv(home));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), upgradedBackup.snapshot.raw);
  });

  it("upgrades a v0.8 direct values backup, preserving its mapping and migrating legacy deepseek-v4-flash slots", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-v08-direct-upgrade-"));
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".fireconnect/claude");
    const backupPath = providerBackupPath(dataDir);
    const legacyMapping = {
      main: "accounts/fireworks/routers/glm-latest[1m]",
      opus: "accounts/fireworks/routers/glm-latest[1m]",
      sonnet: "accounts/fireworks/models/glm-5p1",
      haiku: "accounts/fireworks/models/deepseek-v4-flash",
      fable: "accounts/fireworks/routers/glm-latest[1m]",
      subagent: "accounts/fireworks/models/deepseek-v4-flash",
    };
    const migratedMapping = {
      main: "glm-latest[1m]",
      opus: "glm-latest[1m]",
      sonnet: "glm-5p1",
      haiku: "deepseek-flash-latest[1m]",
      fable: "glm-latest[1m]",
      subagent: "deepseek-flash-latest",
    };
    await writeJson(settingsPath, {
      model: legacyMapping.main,
      apiKeyHelper: "/old/fireconnect key export --stored-only",
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_MODEL: legacyMapping.main,
        ANTHROPIC_DEFAULT_OPUS_MODEL: legacyMapping.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: legacyMapping.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: legacyMapping.haiku,
        ANTHROPIC_DEFAULT_FABLE_MODEL: legacyMapping.fable,
        CLAUDE_CODE_SUBAGENT_MODEL: legacyMapping.subagent,
        CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
        USER_ENV: "keep-me",
      },
      unrelated: { keep: true },
    });
    await writeJson(backupPath, {
      values: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
      missing: [],
      topLevel: {
        values: { model: "sonnet" },
        missing: ["effortLevel", "apiKeyHelper"],
      },
    });

    const upgrade = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY],
      cliEnv(home),
    );
    assert.equal(upgrade.code, 0, upgrade.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assertClaudeMainModel(enabled, migratedMapping.main);
    assert.equal(enabled.env.ANTHROPIC_DEFAULT_OPUS_MODEL, migratedMapping.opus);
    assert.equal(enabled.env.ANTHROPIC_DEFAULT_SONNET_MODEL, migratedMapping.sonnet);
    assert.equal(enabled.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, migratedMapping.haiku);
    assert.equal(enabled.env.ANTHROPIC_DEFAULT_FABLE_MODEL, migratedMapping.fable);
    assert.equal(enabled.env.CLAUDE_CODE_SUBAGENT_MODEL, migratedMapping.subagent);
    assert.equal(enabled.apiKeyHelper, undefined);

    const upgradedBackup = await readJsonIfExists(backupPath);
    assert.equal(upgradedBackup.values, undefined);
    const baseline = JSON.parse(upgradedBackup.snapshot.raw);
    assert.deepEqual(baseline, {
      model: "sonnet",
      env: {
        USER_ENV: "keep-me",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
      unrelated: { keep: true },
    });

    const off = await runFireconnect(["claude", "off"], cliEnv(home));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), upgradedBackup.snapshot.raw);
  });

  it("upgrades a backup-less v0.8 router from a stripped best-effort baseline", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-v08-no-backup-upgrade-"));
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".fireconnect/claude");
    const backupPath = providerBackupPath(dataDir);
    const legacy = legacyRouterSettings();
    legacy.model = "opus";
    await writeJson(settingsPath, legacy);

    const upgrade = await runFireconnect(
      ["claude", "on", "--api-key", "fw_new_upgrade_key_12345"],
      cliEnv(home),
    );
    assert.equal(upgrade.code, 0, upgrade.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assertLegacyRouterIntentPreserved(enabled);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_new_upgrade_key_12345/);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-User-Header: keep-me/);
    assert.deepEqual(enabled.permissions.deny, ["Bash(rm:*)", "WebSearch", "WebFetch"]);
    assert.deepEqual(enabled.unrelated, { keep: true });

    const upgradedBackup = await readJsonIfExists(backupPath);
    assert.equal(upgradedBackup.snapshot.existed, true);
    const baseline = JSON.parse(upgradedBackup.snapshot.raw);
    assert.deepEqual(baseline, {
      env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-User-Header: keep-me",
        USER_ENV: "keep-me",
      },
      hooks: { SessionStart: [USER_HOOK] },
      permissions: {
        allow: ["Bash(ls:*)"],
        deny: ["Bash(rm:*)"],
      },
      unrelated: { keep: true },
    });

    const off = await runFireconnect(["claude", "off"], cliEnv(home));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), upgradedBackup.snapshot.raw);
  });

  it("supports a FireRouter primary without changing other aliases", async () => {
    const modelHome = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-router-"));
    const model = await runFireconnect(
      [
        "claude", "on",
        "--model", "firerouter",
        "--api-key", FIREWORKS_KEY,
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      cliEnv(modelHome),
    );
    assert.equal(model.code, 0, model.stderr);
    let settings = JSON.parse(await readFile(userSettingsPath(modelHome), "utf8"));
    assertClaudeMainModel(settings, FIREROUTER_MODEL);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, DIRECT_ALIAS_MODEL);

    const reon = await runFireconnect(["claude", "on"], cliEnv(modelHome));
    assert.equal(reon.code, 0, reon.stderr);
    settings = JSON.parse(await readFile(userSettingsPath(modelHome), "utf8"));
    assertClaudeMainModel(settings, FIREROUTER_MODEL);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, DIRECT_ALIAS_MODEL);
  });

  it("rejects Fire Pass in primary or alias FireRouter slots", async () => {
    const firepassHome = await mkdtemp(path.join(os.tmpdir(), "fc-claude-fpk-slot-"));
    for (const modelArgs of [
      ["--model", "firerouter"],
      ["--opus", "firerouter"],
    ]) {
      const firepass = await runFireconnect(
        ["claude", "on", ...modelArgs, "--api-key", "fpk_test_firepass_key"],
        cliEnv(firepassHome),
      );
      assert.notEqual(firepass.code, 0);
      assert.match(firepass.stderr, /not available for Fire Pass/i);
    }
  });

  it("refreshes the baked Fireworks key for slot-level routing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slot-key-refresh-"));
    const settingsPath = userSettingsPath(home);
    await writeJson(settingsPath, {
      env: {
        ANTHROPIC_CUSTOM_HEADERS:
          "X-Fireworks-Api-Key: fw_old_key\nx-anthropic-api-key: sk-ant-keep",
      },
    });
    assert.equal(
      await refreshFirerouterClaudeKey({ settingsPath, fireworksKey: "fw_new_key" }),
      true,
    );
    const headers = (await readJsonIfExists(settingsPath)).env.ANTHROPIC_CUSTOM_HEADERS;
    assert.match(headers, /X-Fireworks-Api-Key: fw_new_key/);
    assert.match(headers, /x-anthropic-api-key: sk-ant-keep/);
  });

  it("preserves the original backup across repeat slot changes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slot-backup-"));
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"model":"sonnet"}\n';
    await writeFile(settingsPath, original);

    assert.equal(
      (await runFireconnect(
        [
          "claude", "on",
          "--api-key", FIREWORKS_KEY,
          "--opus", "firerouter",
          "--anthropic-api-key", ANTHROPIC_KEY,
        ],
        cliEnv(home),
      )).code,
      0,
    );
    assert.equal(
      (await runFireconnect(["claude", "on", "--fable", "firerouter"], cliEnv(home))).code,
      0,
    );
    const backup = await readJsonIfExists(providerBackupPath(dataDir));
    assert.equal(backup.snapshot.raw, original);
  });
});
