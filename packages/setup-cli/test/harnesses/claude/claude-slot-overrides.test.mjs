import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";

import {
  userSettingsPath,
} from "../../../lib/harnesses/claude/core.mjs";
import {
  claudeSlotOverridesFromCtx,
  hasClaudeSlotOverrides,
  shouldImplyFirerouterPickerRow,
} from "../../../lib/harnesses/claude/connect.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import {
  FPK_KEY,
  mockServerlessModel,
  mockServerlessModelRows,
  runFireconnect,
  assertClaudeNativeTierSlots,
} from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_test_key_12345";

const CATALOG_ROWS = [
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
    name: "accounts/fireworks/models/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    aliases: ["accounts/fireworks/routers/deepseek-flash-latest"],
  }),
  mockServerlessModel({
    name: "accounts/fireworks/models/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    aliases: ["accounts/fireworks/routers/deepseek-pro-latest"],
  }),
];

/** Persist the catalog to `home`'s scoped cache so a spawned CLI child reads it. */
function seedCatalogFor(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(CATALOG_ROWS));
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

describe("Claude tier-slot overrides", () => {
  it("parses per-slot flags and detects their presence", () => {
    assert.deepEqual(claudeSlotOverridesFromCtx({}), {});
    assert.deepEqual(
      claudeSlotOverridesFromCtx({ sonnet: "deepseek-flash-latest", subagent: "glm-latest" }),
      { sonnet: "deepseek-flash-latest", subagent: "glm-latest" },
    );
    // `native` normalizes to the unpinned sentinel so it clears a saved pin.
    assert.deepEqual(
      claudeSlotOverridesFromCtx({ opus: "native" }),
      { opus: "claude-default" },
    );
    // Empty flags are not overrides; --model never is.
    assert.deepEqual(claudeSlotOverridesFromCtx({ opus: "", main: "glm-latest" }), {});
    assert.equal(hasClaudeSlotOverrides({}), false);
    assert.equal(hasClaudeSlotOverrides({ haiku: "glm-latest" }), true);
    assert.equal(hasClaudeSlotOverrides({ main: "glm-latest" }), false);
  });

  it("implies a firerouter row only with no --model and no slot pins", () => {
    assert.equal(
      shouldImplyFirerouterPickerRow({ routingPreference: 3, main: "" }),
      true,
    );
    assert.equal(
      shouldImplyFirerouterPickerRow({ routingPreference: 3, main: "", sonnet: "glm-latest" }),
      false,
    );
    assert.equal(
      shouldImplyFirerouterPickerRow({ routingPreference: 3, main: "glm-latest" }),
      false,
    );
    assert.equal(
      shouldImplyFirerouterPickerRow({ routingPreference: null, main: "" }),
      false,
    );
    // `native` is end-state identical to no flag: it must not block the synth.
    assert.equal(
      shouldImplyFirerouterPickerRow({ routingPreference: 3, main: "", sonnet: "native" }),
      true,
    );
    assert.equal(
      shouldImplyFirerouterPickerRow({
        routingPreference: 3,
        main: "",
        sonnet: "native",
        subagent: "native",
      }),
      true,
    );
  });

  it("pins --sonnet/--subagent while other tiers stay native", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--sonnet", "deepseek-flash-latest",
        "--subagent", "deepseek-flash-latest",
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);

    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, /deepseek-flash-latest/);
    assert.match(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, /deepseek-flash-latest/);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    // The gateway default still leads; the picker still lands.
    assert.equal(settings.model, "firerouter[1m]");
    assert.equal(settings.modelPicker?.fireconnectManaged, true);
    assert.match(result.stdout, /Tier slot sonnet/);
    assert.match(result.stdout, /Tier slot subagent/);
  });

  it("supports the bare `fireconnect claude --sonnet <id>` form", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-bare-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "--sonnet", "deepseek-flash-latest", "--api-key", FIREWORKS_KEY],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, /deepseek-flash-latest/);
  });

  it("combines --model picker rows with slot pins", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-model-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "glm-latest",
        "--haiku", "deepseek-flash-latest",
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, /deepseek-flash-latest/);
    const picker = settings.modelPicker?.options?.map((row) => row.model) ?? [];
    assert.ok(picker.includes("glm-latest[1m]"), picker.join(", "));
  });

  it("plain re-on preserves pins and `native` unpins one slot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-keep-"));
    seedCatalogFor(home);
    const env = cliEnv(home);
    const first = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--sonnet", "deepseek-flash-latest",
        "--haiku", "glm-latest",
      ],
      env,
    );
    assert.equal(first.code, 0, first.stderr);

    const reon = await runFireconnect(["claude", "on"], env);
    assert.equal(reon.code, 0, reon.stderr);
    let settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, /deepseek-flash-latest/);
    assert.match(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, /glm-latest/);

    const unpin = await runFireconnect(["claude", "on", "--haiku", "native"], env);
    assert.equal(unpin.code, 0, unpin.stderr);
    settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, /deepseek-flash-latest/);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  });

  it("slot pins survive off/on byte-for-byte restore of the original", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-off-"));
    seedCatalogFor(home);
    const settingsPath = userSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = `{\n  "env": {\n    "ANTHROPIC_API_KEY": "sk-ant-original"\n  }\n}\n`;
    await writeFile(settingsPath, original);

    const on = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--subagent", "deepseek-flash-latest"],
      cliEnv(home),
    );
    assert.equal(on.code, 0, on.stderr);
    const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.match(enabled.env.CLAUDE_CODE_SUBAGENT_MODEL, /deepseek-flash-latest/);

    const off = await runFireconnect(["claude", "off"], cliEnv(home));
    assert.equal(off.code, 0, off.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });

  it("rejects the internal sentinel spelling with `native` guidance", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-sentinel-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--sonnet", "claude-default"],
      cliEnv(home),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--sonnet.*native/);
  });

  it("rejects unknown slot ids via catalog validation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-badid-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--sonnet", "foo/bar"],
      cliEnv(home),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not available on Fireworks/);
  });

  it("accepts a slot set to firerouter with a routing preference", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-router-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--opus", "firerouter",
        "--routing-preference", "balanced",
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "firerouter[1m]");
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-routing-preference: 3/i);
  });

  it("rejects --routing-preference when pinned slots ignore the mix", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-router-reject-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--sonnet", "deepseek-flash-latest",
        "--routing-preference", "balanced",
      ],
      cliEnv(home),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--routing-preference requires a Claude slot set to firerouter/);
  });

  it("attaches the OpenAI key for a GPT compound pinned to a tier slot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-gpt-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--opus", "firerouter/gpt-5p6",
        "--openai-api-key", "sk-proj-slot-gpt-12345",
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, /firerouter\/gpt-5p6/);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-openai-api-key: sk-proj-slot-gpt-12345/);
  });

  it("keeps the OpenAI key off a non-GPT compound pinned to a tier slot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-nongpt-"));
    seedCatalogFor(home);
    // A non-router /model default, so the tier pin alone decides (a bare
    // firerouter default would rightly carry the key on its own).
    const result = await runFireconnect(
      [
        "claude", "on",
        "--api-key", FIREWORKS_KEY,
        "--model", "glm-latest",
        "--opus", "firerouter/opus",
        "--openai-api-key", "sk-proj-slot-opus-12345",
      ],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-openai-api-key/i);
  });

  it("attaches the OpenAI key when plain on lands on the implicit firerouter default", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-default-router-openai-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--openai-api-key", "sk-proj-default-router-12345"],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.model, "firerouter[1m]");
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-openai-api-key: sk-proj-default-router-12345/);
  });

  it("keeps the OpenAI key off when re-on keeps a saved non-router pick", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-saved-pick-openai-"));
    seedCatalogFor(home);
    const first = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--model", "glm-latest"],
      cliEnv(home),
    );
    assert.equal(first.code, 0, first.stderr);
    const again = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--openai-api-key", "sk-proj-saved-pick-12345"],
      cliEnv(home),
    );
    assert.equal(again.code, 0, again.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.equal(settings.model, "glm-latest[1m]");
    assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-openai-api-key/i);
  });

  it("applies a Fire Pass router pin instead of dropping the flag", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-fpk-pin-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FPK_KEY, "--sonnet", "glm-latest"],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(await readFile(userSettingsPath(home), "utf8"));
    assert.match(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, /glm-latest/);
    assert.match(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, /kimi-fast-latest/);
  });

  it("rejects `native` on Fire Pass instead of silently ignoring it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-fpk-native-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FPK_KEY, "--sonnet", "native"],
      cliEnv(home),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Claude default slots require a Fireworks API key/);
  });

  for (const route of ["firerouter/gpt-5p6", "firerouter/opus"]) {
    it(`rejects a ${route} compound tier pin on Fire Pass`, async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-fpk-compound-"));
      seedCatalogFor(home);
      const result = await runFireconnect(
        ["claude", "on", "--api-key", FPK_KEY, "--opus", route],
        cliEnv(home),
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /not available for Fire Pass/i);
    });
  }

  it("rejects a firerouter tier pin on Fire Pass", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-fpk-router-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FPK_KEY, "--opus", "firerouter"],
      cliEnv(home),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Fire Pass/i);
  });

  it("leaves every tier native when no slot flags are passed", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-slots-native-"));
    seedCatalogFor(home);
    const result = await runFireconnect(
      ["claude", "on", "--api-key", FIREWORKS_KEY, "--model", "glm-latest"],
      cliEnv(home),
    );
    assert.equal(result.code, 0, result.stderr);
    assertClaudeNativeTierSlots(JSON.parse(await readFile(userSettingsPath(home), "utf8")));
  });
});
