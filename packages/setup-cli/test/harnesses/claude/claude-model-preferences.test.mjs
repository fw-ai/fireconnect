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
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  FPK_KEY,
  mockServerlessModel,
  mockServerlessModelRows,
  runFireconnect,
  assertClaudeNativeTierSlots,
  assertClaudeRegisterablePicker,
} from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";

/** Persist the alias catalog a spawned CLI child validates and resolves slots through. */
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
      ...mockServerlessModelRows({
        name: "accounts/fireworks/models/glm-5p2",
        aliases: ["accounts/fireworks/routers/glm-fast-latest"],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/kimi-k3",
        displayName: "Kimi K3",
        input_modalities: ["text", "image"],
        aliases: ["accounts/fireworks/routers/kimi-latest", "accounts/fireworks/routers/kimi-fast-latest"],
      }),
      mockServerlessModel({
        name: "accounts/fireworks/models/deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
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
  it("merges stored profiles, keeps native tiers, and survives off/on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-model-prefs-"));
    seedCatalogFor(home);
    const env = cliEnv(home);
    await writeJson(userSettingsPath(home), {
      env: { ANTHROPIC_API_KEY: "sk-ant-native-test" },
    });
    const first = await runFireconnect([
      "claude", "on",
      "--model", "glm-latest",
    ], env);
    assert.equal(first.code, 0, first.stderr);

    const settingsAfterFirst = await readJsonIfExists(userSettingsPath(home));
    assert.equal(settingsAfterFirst.model, "firerouter[1m]");
    assertClaudeNativeTierSlots(settingsAfterFirst);
    assertClaudeRegisterablePicker(settingsAfterFirst, { includes: ["glm-latest[1m]"] });

    const storedConfig = await readGlobalConfig(home);
    const staleProfiles = withSavedClaudeModelMapping(
      storedConfig.harnesses.claude.profiles,
      "fireworks",
      {
        ...defaultClaudeModelMapping("fireworks"),
        main: "kimi-fast-latest",
      },
    );
    await setHarnessState(home, "claude", { profiles: staleProfiles });
    const reon = await runFireconnect(
      ["claude", "on", "--model", "kimi-fast-latest"],
      env,
    );
    assert.equal(reon.code, 0, reon.stderr);
    const settingsAfterReon = await readJsonIfExists(userSettingsPath(home));
    assert.equal(settingsAfterReon.model, "firerouter[1m]");
    assertClaudeRegisterablePicker(settingsAfterReon, { includes: ["kimi-fast-latest[1m]"] });
    assert.deepEqual(
      savedClaudeModelMapping((await readGlobalConfig(home)).harnesses.claude.profiles, "fireworks"),
      defaultClaudeModelMapping("fireworks"),
    );

    const off = await runFireconnect(["claude", "off"], env);
    assert.equal(off.code, 0, off.stderr);
    const firepass = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      cliEnv(home, FPK_KEY),
    );
    assert.equal(firepass.code, 0, firepass.stderr);
    const firepassMapping = defaultClaudeModelMapping("firepass");
    assert.deepEqual(await activeMapping(home), firepassMapping);

    assert.equal((await runFireconnect(["claude", "off"], cliEnv(home, FPK_KEY))).code, 0);
    const onAgain = await runFireconnect(["claude", "on", "--non-interactive"], env);
    assert.equal(onAgain.code, 0, onAgain.stderr);
    assert.match(onAgain.stdout, /Manage models/);
    assert.match(onAgain.stdout, /fireconnect claude --model <id>/);
    // Live main reflects the pinned FireRouter default; the saved profile
    // mapping stays native (checked above).
    assert.deepEqual(await activeMapping(home), {
      ...defaultClaudeModelMapping("fireworks"),
      main: "firerouter",
    });
    const settings = await readJsonIfExists(userSettingsPath(home));
    assert.equal(settings.model, "firerouter[1m]");
    assert.equal(settings.env.ANTHROPIC_MODEL, undefined);

    const config = await readGlobalConfig(home);
    assert.deepEqual(
      savedClaudeModelMapping(config.harnesses.claude.profiles, "firepass"),
      firepassMapping,
    );
  });

  it("keeps a stored FireRouter profile when native auth is undetectable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-router-prefs-"));
    const settingsPath = userSettingsPath(home);
    const env = cliEnv(home);
    await writeJson(settingsPath, {
      env: { ANTHROPIC_API_KEY: "sk-ant-native-test" },
    });
    const enabled = await runFireconnect(
      ["claude", "on", "--model", "firerouter"],
      env,
    );
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.equal((await runFireconnect(["claude", "off"], env)).code, 0);

    await writeJson(settingsPath, { theme: "dark" });
    const restored = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      env,
    );
    assert.equal(restored.code, 0, restored.stderr);
    const settings = await readJsonIfExists(settingsPath);
    assertClaudeNativeTierSlots(settings);
    assertClaudeRegisterablePicker(settings, { includes: ["firerouter[1m]"] });
  });

  it("reconnects with native tiers when the managed key is temporarily unreadable", async () => {
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
    const after = await readJsonIfExists(settingsPath);
    assert.equal(after.model, "firerouter[1m]");
    assertClaudeNativeTierSlots(after);
  });

  it("scopes Fire Pass mappings without leaking them into fireworks", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-fpk-live-"));
    const firepassEnv = cliEnv(home, FPK_KEY);
    const customized = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      firepassEnv,
    );
    assert.equal(customized.code, 0, customized.stderr);
    assert.equal((await activeMapping(home)).opus, "kimi-fast-latest");

    const fireworksSwitch = await runFireconnect(
      ["claude", "on", "--non-interactive"],
      cliEnv(home),
    );
    assert.equal(fireworksSwitch.code, 0, fireworksSwitch.stderr);
    assert.deepEqual(await activeMapping(home), {
      ...defaultClaudeModelMapping("fireworks"),
      main: "firerouter",
    });
  });
});
