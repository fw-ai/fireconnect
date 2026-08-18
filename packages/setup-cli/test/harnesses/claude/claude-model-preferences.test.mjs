import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  readGlobalConfig,
  setHarnessState,
} from "../../../lib/config/global-config.mjs";
import {
  mappingFromSettings,
  providerStatePath,
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import {
  defaultClaudeModelMapping,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import { readJsonIfExists, writeJson } from "../../../lib/io/json.mjs";
import { FPK_KEY, runFireconnect } from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";

function cliEnv(home, apiKey = FIREWORKS_KEY) {
  return {
    HOME: home,
    FIREWORKS_API_KEY: apiKey,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
}

async function activeMapping(home) {
  const settings = await readJsonIfExists(userSettingsPath(home));
  return mappingFromSettings(settings);
}

async function hideManagedKeyMetadata(home) {
  const settingsPath = userSettingsPath(home);
  const settings = await readJsonIfExists(settingsPath);
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  delete settings.env.ANTHROPIC_API_KEY;
  settings.env.ANTHROPIC_CUSTOM_HEADERS = settings.env.ANTHROPIC_CUSTOM_HEADERS
    .split("\n")
    .filter((line) => !/^X-Fireworks-Api-Key:/i.test(line))
    .join("\n");
  await writeJson(settingsPath, settings);

  const statePath = providerStatePath(path.join(home, ".fireconnect/claude"));
  const state = await readJsonIfExists(statePath);
  delete state.keyType;
  await writeJson(statePath, state);
}

describe("Claude model preferences", () => {
  it("merges defaults → stored → live → flags and survives off/on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-prefs-"));
    const env = cliEnv(home);
    const initial = {
      main: "glm-latest",
      opus: "glm-fast-latest",
      sonnet: "kimi-latest",
      haiku: "deepseek-v4-pro",
      fable: "kimi-fast-latest",
      subagent: "deepseek-v4-flash",
    };
    await writeJson(userSettingsPath(home), {
      env: { ANTHROPIC_API_KEY: "sk-ant-native-test" },
    });
    const first = await runFireconnect([
      "claude", "on",
      "--model", initial.main,
      "--opus", initial.opus,
      "--sonnet", initial.sonnet,
      "--haiku", initial.haiku,
      "--fable", initial.fable,
      "--subagent", initial.subagent,
    ], env);
    assert.equal(first.code, 0, first.stderr);

    // Make stored preferences stale. The active managed settings must win for
    // untouched slots, while the new CLI flag must still win for opus.
    const storedConfig = await readGlobalConfig(home);
    const staleProfiles = withSavedClaudeModelMapping(
      storedConfig.harnesses.claude.profiles,
      "fireworks",
      {
      ...initial,
      sonnet: "glm-fast-latest",
      haiku: "glm-fast-latest",
      },
    );
    await setHarnessState(home, "claude", { profiles: staleProfiles });
    const reon = await runFireconnect(
      ["claude", "on", "--opus", "kimi-fast-latest"],
      env,
    );
    assert.equal(reon.code, 0, reon.stderr);
    // Persisted state is migrated on re-on, so the stored deepseek-v4-flash
    // subagent comes back as its -latest router alias. Only explicit per-run
    // flags escape the migration, and this re-on passes just --opus.
    const expected = {
      ...initial,
      opus: "kimi-fast-latest",
      subagent: "deepseek-flash-latest",
    };
    assert.deepEqual(await activeMapping(home), expected);
    let config = await readGlobalConfig(home);
    assert.deepEqual(
      savedClaudeModelMapping(config.harnesses.claude.profiles, "fireworks"),
      expected,
    );

    const off = await runFireconnect(["claude", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    const firepass = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      cliEnv(home, FPK_KEY),
    );
    assert.equal(firepass.code, 0, firepass.stderr);
    const firepassMapping = Object.fromEntries(
      Object.keys(expected).map((slot) => [slot, "kimi-fast-latest"]),
    );
    assert.deepEqual(await activeMapping(home), firepassMapping);

    assert.equal((await runFireconnect(["claude", "off"], cliEnv(home, FPK_KEY))).code, 0);
    const onAgain = await runFireconnect(["claude", "on", "--non-interactive"], env);
    assert.equal(onAgain.code, 0, onAgain.stderr);
    assert.match(onAgain.stdout, /Manage models/);
    assert.match(onAgain.stdout, /fireconnect claude (?:on )?--interactive/);
    assert.deepEqual(await activeMapping(home), expected);
    const settings = await readJsonIfExists(userSettingsPath(home));
    assert.equal(settings.model, "glm-latest[1m]");
    assert.equal(settings.env.ANTHROPIC_MODEL, undefined);

    config = await readGlobalConfig(home);
    assert.deepEqual(
      savedClaudeModelMapping(config.harnesses.claude.profiles, "firepass"),
      firepassMapping,
    );
  });

  it("rejects a stored FireRouter profile when native auth disappears", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-prefs-"));
    const settingsPath = userSettingsPath(home);
    const env = cliEnv(home);
    await writeJson(settingsPath, {
      env: { ANTHROPIC_API_KEY: "sk-ant-native-test" },
    });
    const enabled = await runFireconnect(
      ["claude", "on", "--opus", "firerouter"],
      env,
    );
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.equal((await runFireconnect(["claude", "off"], env)).code, 0);

    await writeJson(settingsPath, { theme: "dark" });
    const before = await readJsonIfExists(settingsPath);
    const rejected = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      env,
    );
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /FireRouter requires Claude sign-in/);
    assert.deepEqual(await readJsonIfExists(settingsPath), before);
  });

  it("preserves live customizations when the managed key is temporarily unreadable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-live-prefs-"));
    const settingsPath = userSettingsPath(home);
    const env = cliEnv(home);
    const first = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      env,
    );
    assert.equal(first.code, 0, first.stderr);

    const settings = await readJsonIfExists(settingsPath);
    settings.model = "glm-latest[1m]";
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    settings.env.ANTHROPIC_CUSTOM_HEADERS = settings.env.ANTHROPIC_CUSTOM_HEADERS
      .split("\n")
      .filter((line) => !/^X-Fireworks-Api-Key:/i.test(line))
      .join("\n");
    await writeJson(settingsPath, settings);

    const state = await readJsonIfExists(
      providerStatePath(path.join(home, ".fireconnect/claude")),
    );
    assert.equal(state.keyType, "fireworks");
    const reon = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      env,
    );
    assert.equal(reon.code, 0, reon.stderr);
    assert.equal((await activeMapping(home)).main, "glm-latest");
  });

  it("scopes unreadable Fire Pass mappings without leaking them into fireworks", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-fpk-live-"));
    const firepassEnv = cliEnv(home, FPK_KEY);
    const customized = await runFireconnect(
      [
        "claude", "on", "--non-interactive",
        "--model", "glm-latest",
        "--opus", "kimi-fast-latest",
      ],
      firepassEnv,
    );
    assert.equal(customized.code, 0, customized.stderr);

    await hideManagedKeyMetadata(home);
    const firepassReon = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      firepassEnv,
    );
    assert.equal(firepassReon.code, 0, firepassReon.stderr);
    assert.equal((await activeMapping(home)).main, "glm-latest");

    await hideManagedKeyMetadata(home);
    const fireworksSwitch = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      cliEnv(home),
    );
    assert.equal(fireworksSwitch.code, 0, fireworksSwitch.stderr);
    assert.deepEqual(await activeMapping(home), defaultClaudeModelMapping("fireworks"));
  });
});
