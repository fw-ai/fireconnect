import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  userSettingsPath,
  providerBackupPath,
  resolveDataDir,
  fireworksModelPickerName,
  fireworksModelDisplayFields,
  fireworksFableOptionFields,
  syncFireworksModelDisplay,
  stripCustomModelOptionEnv,
} from "../../../lib/harnesses/claude/core.mjs";
import { resolveClaudeAuthState } from "../../../lib/harnesses/claude/index.mjs";
import { readGlobalConfig } from "../../../lib/config/global-config.mjs";
import { FIRECONNECT_REFERER, runFireconnect, writeClaudeSettings, assertClaudeMainModel } from "../../helpers.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";

describe("claude harness integration", () => {
  it("uses active custom-header auth ahead of stale env and helper state", () => {
    const auth = resolveClaudeAuthState({
      apiKeyHelper: "/usr/local/bin/user-helper",
      env: {
        ANTHROPIC_API_KEY: "fpk_stale_firepass_key",
        ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_active_header_key",
      },
    }, {
      authMode: "apiKeyHelper",
    });
    assert.deepEqual(auth, {
      authMode: "customHeader",
      keyConfigured: true,
      token: "fw_active_header_key",
    });
  });

  it("on/off round-trip restores settings", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.env.ANTHROPIC_BASE_URL, "https://api.fireworks.ai/inference");
    // Gateway auth remains in X-Fireworks-Api-Key while Claude's native key is
    // preserved in its native env field.
    assert.equal(enabled.apiKeyHelper, undefined);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_test_key_12345/);
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /User-Agent:/);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Title: Claude Code/);
    assert.ok(
      enabled.env.ANTHROPIC_CUSTOM_HEADERS.includes(`HTTP-Referer: ${FIRECONNECT_REFERER}`),
      enabled.env.ANTHROPIC_CUSTOM_HEADERS,
    );
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-FireRouter-Harness|Fireworks-Use-Case/);
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assertClaudeMainModel(enabled, "firerouter[1m]");
    assert.equal(enabled.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-fast-latest[1m]");
    assert.equal(enabled.env.DISABLE_TELEMETRY, "1");
    assert.equal(enabled.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(
      (await stat(settingsPath)).mode & 0o077,
      0,
      "settings.json must be owner-only while it contains the Fireworks key",
    );

    // The backup is a raw byte-for-byte snapshot of the original settings file
    // (like the other harnesses), so it must be owner-only (0600) — it holds the
    // user's pre-existing ANTHROPIC_API_KEY. (Masking with 0o077 distinguishes
    // 0600 from the 0644 default.)
    const backupPath = providerBackupPath(resolveDataDir({ home }));
    const backupStat = await stat(backupPath);
    assert.equal(backupStat.mode & 0o077, 0o000, "provider-backup.json should be owner-only (0600)");
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    assert.equal(backup.snapshot.existed, true);
    assert.equal(backup.configPath, settingsPath);
    assert.equal(JSON.parse(backup.snapshot.raw).env.ANTHROPIC_API_KEY, "sk-ant-original");

    const offResult = await runFireconnect(["claude", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(restored.apiKeyHelper, undefined);
    assert.equal(Object.hasOwn(restored.env, "DISABLE_TELEMETRY"), false);

    const config = await readGlobalConfig(home);
    assert.equal(config.harnesses.claude.enabled, false);
  });

  it("preserves native ANTHROPIC_AUTH_TOKEN and a user-owned apiKeyHelper", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-native-helper-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      apiKeyHelper: "/usr/local/bin/user-anthropic-key-helper",
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-ant-native-auth-token",
      },
    }));

    const result = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(result.code, 0, result.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, "/usr/local/bin/user-anthropic-key-helper");
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-native-auth-token");
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assertClaudeMainModel(enabled, "firerouter[1m]");
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
  });

  it("treats a non-managed user apiKeyHelper as native auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-helper-auth-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      apiKeyHelper: "/usr/local/bin/user-anthropic-key-helper",
    }));

    const result = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(result.code, 0, result.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, "/usr/local/bin/user-anthropic-key-helper");
    assertClaudeMainModel(enabled, "firerouter[1m]");
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("--anthropic-api-key alone becomes native auth and selects the fresh FireRouter default", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-anthropic-flag-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", "fw_test_key_12345",
        "--anthropic-api-key", "sk-ant-native-flag",
      ],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(result.code, 0, result.stderr);

    const enabled = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(enabled.env.ANTHROPIC_API_KEY, "sk-ant-native-flag");
    assertClaudeMainModel(enabled, "firerouter[1m]");
    assert.doesNotMatch(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
  });

  it("missing Fireworks auth stops before settings changes with login and custom SSO guidance", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-missing-fireworks-"));
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(settingsPath, original);

    const result = await runFireconnect(
      ["claude", "on", "--anthropic-api-key", "sk-ant-must-not-persist"],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /fireconnect login/);
    assert.match(result.stderr, /fireconnect login --account <account-id>/);
    assert.equal(await readFile(settingsPath, "utf8"), original);
    assert.equal((await readGlobalConfig(home)).anthropicApiKey, "");
    await assert.rejects(
      readFile(providerBackupPath(resolveDataDir({ home })), "utf8"),
      { code: "ENOENT" },
    );
  });

  it("on denies the gateway-incompatible WebSearch/WebFetch tools, keeping user deny rules", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-deny-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] } }),
    );

    for (const args of [
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      [
        "claude", "on",
        "--opus", "firerouter",
        "--api-key", "fw_test_key_12345",
        "--anthropic-api-key", "sk-ant-tools-test",
      ],
    ]) {
      const on = await runFireconnect(args, {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      });
      assert.equal(on.code, 0, on.stderr);
      const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(
        enabled.permissions.deny,
        ["Bash(rm:*)", "WebSearch", "WebFetch"],
        `deny merged after ${args.join(" ")}`,
      );
      // The user's own allow rule is untouched.
      assert.deepEqual(enabled.permissions.allow, ["Bash(ls:*)"]);

      const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(off.code, 0, off.stderr);
      const restored = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepEqual(restored.permissions.deny, ["Bash(rm:*)"], `deny restored after ${args.join(" ")}`);
    }
  });

  it("on/off restores the settings file byte-for-byte (formatting, order, unrelated keys)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-byte4byte-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = userSettingsPath(home);
    // Idiosyncratic formatting (4-space indent, trailing newline) + user-only
    // keys FireConnect doesn't manage. A surgical/key-level backup would reformat
    // this; a raw snapshot restores it exactly.
    const original = `{
    "permissions": { "allow": ["Bash(ls:*)"] },
    "env": {
        "ANTHROPIC_API_KEY": "sk-ant-user-original",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "1",
        "MY_CUSTOM_VAR": "keep-me"
    },
    "model": "opus"
}
`;
    await writeFile(settingsPath, original);

    for (const args of [["claude", "on", "--api-key", "fw_test_key_12345"], ["claude", "on", "--opus", "firerouter", "--api-key", "fw_test_key_12345"]]) {
      const on = await runFireconnect(args, { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(on.code, 0, on.stderr);
      const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(enabled.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
      const off = await runFireconnect(["claude", "off"], { HOME: home, FIREWORKS_API_KEY: "" });
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await readFile(settingsPath, "utf8"), original, `byte-for-byte after ${args.join(" ")}`);
    }
  });

  it("on --api-key persists to keychain for key export", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-keychain-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const apiKey = "fw_test_key_12345";

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", apiKey],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const { readGlobalConfig } = await import("../../../lib/config/global-config.mjs");
    const config = await readGlobalConfig(home);
    assert.equal(config.apiKey, "{keychain:fireworks-api-key}");

    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.code, 0, exportResult.stderr);
    assert.equal(exportResult.stdout.trim(), apiKey);
  });

  it("on persists harness-local Fireworks key to the keychain and uses the custom header", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-harness-local-"));
    const harnessKey = "fw_claude_harness_only_key123";
    await writeClaudeSettings(home, harnessKey);
    const settingsPath = userSettingsPath(home);

    const onResult = await runFireconnect(["claude", "on"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    assert.equal(onResult.code, 0, onResult.stderr);

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabled.apiKeyHelper, undefined);
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_claude_harness_only_key123/);
    assert.equal(enabled.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN, harnessKey);

    const exportResult = await runFireconnect(["key", "export"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
    });
    assert.equal(exportResult.code, 0, exportResult.stderr);
    assert.equal(exportResult.stdout.trim(), harnessKey);
  });

  it("on does not clobber a newer stored key with a stale baked key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-clobber-"));
    const newKey = "fw_new_login_key_000000000000000000";
    const staleKey = "fw_old_baked_key_000000000000000000";
    const settingsPath = userSettingsPath(home);

    // Store + bake the current key (like a `login` followed by `claude on`).
    const first = await runFireconnect(["claude", "on", "--api-key", newKey], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(first.code, 0, first.stderr);

    // Simulate a stale key still baked into settings by an earlier `on`.
    const stale = JSON.parse(await readFile(settingsPath, "utf8"));
    stale.env.ANTHROPIC_CUSTOM_HEADERS = `X-Fireworks-Api-Key: ${staleKey}`;
    await writeFile(settingsPath, JSON.stringify(stale));

    // Re-enable with no flag: the stored key must win and never be overwritten
    // by the stale baked header.
    const second = await runFireconnect(["claude", "on"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(second.code, 0, second.stderr);

    const exportResult = await runFireconnect(["key", "export"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(exportResult.stdout.trim(), newKey, "stored key must survive re-enable");

    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.match(enabled.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Fireworks-Api-Key: ${newKey}`));
  });

  it("on pre-approves a stray ANTHROPIC_API_KEY so Claude Code doesn't prompt", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-approve-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const strayKey = "sk-ant-api03-STRAYstrayKEY1234567890";

    const onResult = await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: strayKey },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    // Claude Code identifies an approved key by key.trim().slice(-20).
    const claudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    assert.ok(
      claudeJson.customApiKeyResponses.approved.includes(strayKey.slice(-20)),
      "the stray key's last-20 identifier should be pre-approved",
    );
  });

  it("off without on leaves user settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-off-noop-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    const originalSettings = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "sk-ant-original",
      },
    });
    await writeFile(settingsPath, originalSettings);

    const offResult = await runFireconnect(["claude", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const after = await readFile(settingsPath, "utf8");
    assert.equal(after, originalSettings);
  });

  it("second off after on/off round-trip leaves settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-double-off-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_API_KEY: "sk-ant-original",
        },
      }),
    );

    await runFireconnect(
      ["claude", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    await runFireconnect(["claude", "off"], { HOME: home });

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.env.ANTHROPIC_API_KEY, "sk-ant-original");

    await runFireconnect(["claude", "off"], { HOME: home });

    const afterSecondOff = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(afterSecondOff.env.ANTHROPIC_API_KEY, "sk-ant-original");
    assert.equal(afterSecondOff.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  });

  it("prints one compact warning for text-only models", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-vision-warn-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "glm-fast-latest",
      ],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Text-only: deepseek-v4-flash, glm-fast-latest · Avoid images; recover with \/rewind\./,
    );
    assert.doesNotMatch(result.stdout, /Claude Code cannot mark models as text-only/);
  });

  it("status labels model slots with vision capability", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-vision-status-"));
    const onResult = await runFireconnect(
      [
        "claude", "on",
        "--api-key", "fw_test_key_12345",
        "--model", "glm-fast-latest",
        "--sonnet", "kimi-latest",
      ],
      {
        HOME: home,
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    );
    assert.equal(onResult.code, 0, onResult.stderr);

    const statusResult = await runFireconnect(["claude", "status"], { HOME: home });
    assert.equal(statusResult.code, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /main\s+->\s+glm-fast-latest.*text-only/);
    assert.match(statusResult.stdout, /sonnet\s+->\s+kimi-latest.*vision/);
  });
});

describe("fireworksModelPickerName", () => {
  it("uses catalog labels instead of raw slugs for subscription picker names", () => {
    assert.equal(fireworksModelPickerName("glm-fast-latest"), "GLM 5.2 Fast (Latest)");
    assert.equal(fireworksModelPickerName("kimi-fast-latest"), "Kimi K2.7 Code Fast (Latest)");
    assert.equal(fireworksModelPickerName("deepseek-v4-flash"), "DeepSeek V4 Flash");
    assert.equal(fireworksModelPickerName("firerouter"), "FireRouter");
  });

  it("strips ' via Fireworks' from cached catalog pricing labels", () => {
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map([
        ["accounts/fireworks/routers/glm-fast-latest", {
          slug: "glm-fast-latest",
          label: "GLM 5.2 Fast via Fireworks",
          input: 2.1,
          cachedInput: 0.21,
          output: 6.6,
          tier: "fast",
          source: "https://fireworks.ai/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(fireworksModelPickerName("glm-fast-latest"), "GLM 5.2 Fast (Latest)");
      const fields = fireworksModelDisplayFields("glm-fast-latest", "ANTHROPIC_DEFAULT_FABLE_MODEL");
      assert.equal(fields.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "GLM 5.2 Fast (Latest)");
      assert.doesNotMatch(fields.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION, / via Fireworks/);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("uses live catalog base model names ahead of stale static alias specs", () => {
    setServerlessCatalogSnapshot({
      entries: [{
        id: "accounts/fireworks/models/kimi-k2p8-code",
        shortId: "kimi-k2p8-code",
        displayName: "Kimi K2.8 Code",
        kind: "serverless",
      }],
      pricingById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", {
          slug: "kimi-fast-latest",
          label: "Kimi Fast Latest via Fireworks",
          input: 1.9,
          cachedInput: 0.38,
          output: 8,
          tier: "fast",
          source: "https://fireworks.ai/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map([
        ["accounts/fireworks/routers/kimi-fast-latest", "accounts/fireworks/models/kimi-k2p8-code"],
      ]),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    try {
      assert.equal(fireworksModelPickerName("kimi-fast-latest"), "Kimi K2.8 Code Fast (Latest)");
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });

  it("writes pretty display fields for every alias slot", () => {
    const mapping = {
      main: "firerouter",
      opus: "glm-fast-latest",
      sonnet: "glm-fast-latest",
      haiku: "deepseek-v4-flash",
      fable: "kimi-fast-latest",
      subagent: "deepseek-v4-flash",
    };
    const env = syncFireworksModelDisplay({}, mapping);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GLM 5.2 Fast (Latest)");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "GLM 5.2 Fast (Latest)");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "DeepSeek V4 Flash");
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "Kimi K2.7 Code Fast (Latest)");
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
    assert.match(env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION, /GLM 5\.2 Fast/);
  });

  it("writes pretty fable picker names into env fields", () => {
    const fields = fireworksFableOptionFields("glm-fast-latest");
    assert.equal(fields.ANTHROPIC_DEFAULT_FABLE_MODEL, "glm-fast-latest[1m]");
    assert.equal(fields.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "GLM 5.2 Fast (Latest)");
    assert.match(fields.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION, /GLM 5\.2 Fast/);
  });

  it("strips ANTHROPIC_CUSTOM_MODEL_OPTION from subscription picker env", () => {
    const env = stripCustomModelOptionEnv({
      ANTHROPIC_CUSTOM_MODEL_OPTION: "firerouter[1m]",
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "FireRouter",
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "GLM 5.2 Fast",
    });
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GLM 5.2 Fast");
  });

  it("builds per-slot display fields from env prefix", () => {
    const opus = fireworksModelDisplayFields("glm-fast-latest", "ANTHROPIC_DEFAULT_OPUS_MODEL");
    assert.equal(opus.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GLM 5.2 Fast (Latest)");
    assert.match(opus.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION, /GLM 5\.2 Fast/);
  });
});
