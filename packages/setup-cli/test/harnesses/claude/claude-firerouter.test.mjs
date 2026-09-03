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
import { readJsonIfExists, writeJson } from "../../../lib/io/json.mjs";
import { FIRECONNECT_REFERER, runFireconnect, assertClaudeMainModel } from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";
const ANTHROPIC_KEY = "sk-ant-test-12345";
const FIREROUTER_MODEL = "firerouter[1m]";
const OPUS_DEFAULT_MODEL = "glm-latest[1m]";

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
    // FireRouter on Opus moves GLM to Sonnet.
    assert.equal(
      settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      "glm-latest[1m]",
    );
    assert.equal(
      settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      "deepseek-flash-latest[1m]",
    );
    assert.equal(
      settings.env.CLAUDE_CODE_SUBAGENT_MODEL,
      "deepseek-flash-latest[1m]",
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
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, OPUS_DEFAULT_MODEL);

    const reon = await runFireconnect(["claude", "on"], cliEnv(modelHome));
    assert.equal(reon.code, 0, reon.stderr);
    settings = JSON.parse(await readFile(userSettingsPath(modelHome), "utf8"));
    assertClaudeMainModel(settings, FIREROUTER_MODEL);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, OPUS_DEFAULT_MODEL);
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
