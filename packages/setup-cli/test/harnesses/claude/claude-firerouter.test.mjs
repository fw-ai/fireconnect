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
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  FIRECONNECT_REFERER,
  mockServerlessModel,
  runFireconnect,
  assertClaudeNativeTierSlots,
  assertClaudeRegisterablePicker,
} from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";
const ANTHROPIC_KEY = "sk-ant-test-12345";
const FIREROUTER_MODEL = "firerouter[1m]";

/** Persist the alias catalog a spawned CLI child resolves defaults through. */
function seedCatalogFor(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
      mockServerlessModel({
        name: "accounts/fireworks/models/glm-5p3",
        displayName: "GLM 5.3",
        aliases: ["accounts/fireworks/routers/glm-latest"],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
      }),
    ]));
  } finally {
    process.env.HOME = prevHome;
    setServerlessCatalogSnapshot(null);
  }
}

function cliEnv(home) {
  return {
    HOME: home,
    FIREWORKS_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
}

describe("Claude FireRouter via --model", () => {
  it("--model firerouter enables headers without tier slot pins or Anthropic BYOK", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-router-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    // Nothing servable was selected → the FireRouter mix is the pinned default.
    assert.equal(settings.model, FIREROUTER_MODEL);
    assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: [FIREROUTER_MODEL] });
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /X-Fireworks-Api-Key: fw_test_key_12345/);
    assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /X-Title: Claude Code/);
    assert.ok(
      settings.env.ANTHROPIC_CUSTOM_HEADERS.includes(`HTTP-Referer: ${FIRECONNECT_REFERER}`),
      settings.env.ANTHROPIC_CUSTOM_HEADERS,
    );
    assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
  });

  it("allows --model firerouter without detecting native auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-auth-optional-"));
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".fireconnect/claude");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(settingsPath, original);

    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      cliEnv(home),
    );

    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: [FIREROUTER_MODEL] });
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.notDeepEqual(await readJsonIfExists(providerBackupPath(dataDir)), {});
  });

  it("explicit firerouter with --anthropic-api-key does not use Fireworks token auth fallback", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-byok-no-fallback-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
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

  it("rejects per-tier slot flags alongside FireRouter", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slot-reject-"));
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
        "--sonnet", "glm-latest",
      ],
      cliEnv(home),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--opus\/|--sonnet\/|--haiku\//);
  });

  it("plain re-on preserves picker and accepts router-only options", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-reon-"));
    const env = cliEnv(home);
    const first = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      env,
    );
    assert.equal(first.code, 0, first.stderr);

    const preference = await runFireconnect(
      ["claude", "on", "--model", "firerouter", "--routing-preference", "max-savings"],
      env,
    );
    assert.equal(preference.code, 0, preference.stderr);
    let settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: [FIREROUTER_MODEL] });
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
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-off-"));
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
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--model", "firerouter"],
      cliEnv(home),
    );
    assert.equal(on.code, 0, on.stderr);
    const off = await runFireconnect(["claude", "off"], cliEnv(home));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });

  it("re-on keeps firerouter in the picker with the FireRouter default pinned", async () => {
    const modelHome = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-router-reon-"));
    seedCatalogFor(modelHome);
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
    assert.equal(settings.model, FIREROUTER_MODEL);
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: [FIREROUTER_MODEL] });

    const reon = await runFireconnect(["claude", "on"], cliEnv(modelHome));
    assert.equal(reon.code, 0, reon.stderr);
    settings = JSON.parse(await readFile(userSettingsPath(modelHome), "utf8"));
    // The pinned default is a servable picker row, so re-on keeps it.
    assert.equal(settings.model, FIREROUTER_MODEL);
    assertClaudeRegisterablePicker(settings, { includes: [FIREROUTER_MODEL] });
  });

  it("rejects Fire Pass with --model firerouter", async () => {
    const firepassHome = await mkdtemp(path.join(os.tmpdir(), "fc-claude-fpk-model-"));
    const firepass = await runFireconnect(
      ["claude", "on", "--model", "firerouter", "--api-key", "fpk_test_firepass_key"],
      cliEnv(firepassHome),
    );
    assert.notEqual(firepass.code, 0);
    assert.match(firepass.stderr, /not available for Fire Pass/i);
  });

  it("refreshes the baked Fireworks key for firerouter headers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-key-refresh-"));
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

  it("preserves the original backup across repeat connect", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-backup-"));
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
          "--model", "firerouter",
          "--anthropic-api-key", ANTHROPIC_KEY,
        ],
        cliEnv(home),
      )).code,
      0,
    );
    assert.equal(
      (await runFireconnect(["claude", "on"], cliEnv(home))).code,
      0,
    );
    const backup = await readJsonIfExists(providerBackupPath(dataDir));
    assert.equal(backup.snapshot.raw, original);
  });

  it("claude status surfaces the applied routing preference (text + json)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-status-routing-"));
    const on = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
        "--anthropic-api-key", ANTHROPIC_KEY,
        "--routing-preference", "max-intelligence",
      ],
      cliEnv(home),
    );
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /Routing: max-intelligence \(1\)/);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-routing-preference: 1/i);

    const status = await runFireconnect(["claude", "status"], cliEnv(home));
    assert.equal(status.code, 0, status.stderr);

    const jsonStatus = await runFireconnect(["claude", "status", "--json"], cliEnv(home));
    assert.equal(jsonStatus.code, 0, jsonStatus.stderr);
    const payload = JSON.parse(jsonStatus.stdout);
    assert.equal(payload.routingPreference, 1);
    assert.equal(payload.routingPreferenceLevel, undefined);
  });

  it("omits the routing display for firerouter compounds in --model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-compound-routing-"));
    const on = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter/kimi-k3",
      ],
      cliEnv(home),
    );
    assert.equal(on.code, 0, on.stderr);
    assert.doesNotMatch(on.stdout, /Routing:/);
    assert.doesNotMatch(on.stdout, /Change routing:/);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS ?? "", /x-routing-preference/i);

    const status = await runFireconnect(["claude", "status"], cliEnv(home));
    assert.equal(status.code, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /Routing:/);
  });

  it("claude status omits Routing when no preference is set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-status-no-routing-"));
    const on = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "firerouter",
        "--anthropic-api-key", ANTHROPIC_KEY,
      ],
      cliEnv(home),
    );
    assert.equal(on.code, 0, on.stderr);
    assert.doesNotMatch(on.stdout, /Routing:/);

    const status = await runFireconnect(["claude", "status"], cliEnv(home));
    assert.equal(status.code, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /Routing:/);

    const jsonStatus = await runFireconnect(["claude", "status", "--json"], cliEnv(home));
    assert.equal(jsonStatus.code, 0, jsonStatus.stderr);
    const payload = JSON.parse(jsonStatus.stdout);
    assert.equal(payload.routingPreference, null);
    assert.equal(payload.routingPreferenceLevel, undefined);
  });
});
