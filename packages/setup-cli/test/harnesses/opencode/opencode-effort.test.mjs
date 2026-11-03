import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { isAutoModelId } from "../../../lib/fireworks/model-id.mjs";
import { ensureAutoCatalogEntry } from "../../../lib/harness/auto-catalog.mjs";
import {
  clearModelsDevFireworksRegistry,
  setModelsDevFireworksRegistry,
} from "../../../lib/fireworks/models-dev-registry.mjs";
import { setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { MODEL_REASONING } from "../../../lib/fireworks/reasoning.mjs";
import {
  buildOpencodeModelEntry,
  enableOpencodeFireworks,
  opencodeConfigPath,
  withAuthoredOpencodeReasoningEffort,
  withOpencodeReasoningEffort,
} from "../../../lib/harnesses/opencode/core.mjs";
import { migrateOpencodeReasoningEffortOnUpgrade } from "../../../lib/harnesses/opencode/upgrade-migrations.mjs";
import { withTempHome } from "../../helpers.mjs";

const USER_VARIANTS = {
  low: { disabled: true },
  medium: { reasoningEffort: null },
  high: { temperature: 0.2 },
  custom: { temperature: 0.3 },
};

/** Effort controls a user can set on the Auto row; each leaves the row as written. */
const USER_CONTROLS = {
  "custom variants": { variants: { deep: { reasoningEffort: "high" } } },
  "empty variants": { variants: {} },
  "a disabled variant": { variants: { medium: { disabled: true } } },
  "effort reasoning_options": { reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
  "toggle reasoning_options": { reasoning_options: [{ type: "toggle" }] },
  "empty reasoning_options": { reasoning_options: [] },
};

async function configAt(home, initial) {
  const configPath = opencodeConfigPath(home);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(initial));
  return { configPath, dataDir: path.join(home, ".nexus/opencode") };
}

async function readConfig(configPath) {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function enableHarness(home) {
  return writeGlobalConfig(home, { harnesses: { opencode: { enabled: true, provider: "fireworks" } } });
}

function autoRow(config) {
  return config.provider["fireworks-ai"].models.auto;
}

function refresh(paths, catalogModelIds = ["auto"]) {
  return enableOpencodeFireworks({ ...paths, apiKey: "fw_example_test_key", catalogModelIds, catalogAvailable: true });
}

describe("OpenCode Auto effort", () => {
  it("marks Auto as a reasoning model without a default effort or variants", () => {
    const auto = withOpencodeReasoningEffort("auto", buildOpencodeModelEntry("auto"));
    assert.deepEqual(auto, { ...buildOpencodeModelEntry("auto"), reasoning: true });
    assert.equal(auto.options?.reasoningEffort, undefined);
    assert.equal(buildOpencodeModelEntry("example-model").reasoning, undefined);
  });

  for (const native of [false, true]) {
    const format = native ? "native v2 mirror" : "v1";

    it(`writes reasoning: true in a fresh ${format} config`, async () => {
      await withTempHome("opencode-effort-fresh-", async (home) => {
        const paths = await configAt(home, native ? { providers: {} } : {});
        await enableOpencodeFireworks({ ...paths, apiKey: "fw_example_test_key", modelId: "auto", catalogModelIds: ["auto"] });
        const config = await readConfig(paths.configPath);
        assert.deepEqual(autoRow(config), { ...buildOpencodeModelEntry("auto"), reasoning: true });
        if (native) {
          const mirror = config.providers["fireworks-ai"].models.auto;
          assert.equal(mirror.variants, undefined);
          // The v2 row carries the flag as the object OpenCode 2.x builds
          // variants from; a bare boolean there makes the model unavailable.
          assert.deepEqual(mirror.capabilities?.reasoning, { supported: true, effort: ["low", "medium", "high"] });
        }
      });
    });

    for (const mode of ["explicit", "online", "offline"]) {
      const reOn = (paths) => enableOpencodeFireworks({
        ...paths,
        apiKey: "fw_example_test_key",
        ...(mode === "explicit" ? { modelId: "auto" } : {}),
        catalogModelIds: mode === "offline" ? [] : ["auto"],
        catalogAvailable: mode !== "offline",
      });

      it(`repairs an existing ${format} Auto row on ${mode} re-on`, async () => {
        await withTempHome("opencode-effort-reon-", async (home) => {
          const paths = await configAt(home, {
            ...(native ? { providers: {} } : {}),
            model: "fireworks-ai/auto",
            provider: {
              "fireworks-ai": { models: { auto: { name: "Auto" } } },
              example: { models: { unchanged: { name: "User model" } } },
            },
          });
          await reOn(paths);
          const config = await readConfig(paths.configPath);
          assert.equal(autoRow(config).reasoning, true);
          assert.deepEqual(config.provider.example, { models: { unchanged: { name: "User model" } } });
        });
      });

      it(`keeps the user's variants on an existing ${format} Auto row on ${mode} re-on, unflagged`, async () => {
        await withTempHome("opencode-effort-reon-variants-", async (home) => {
          const paths = await configAt(home, {
            ...(native ? { providers: {} } : {}),
            model: "fireworks-ai/auto",
            provider: { "fireworks-ai": { models: { auto: { name: "Auto", variants: USER_VARIANTS } } } },
          });
          await reOn(paths);
          const config = await readConfig(paths.configPath);
          assert.equal(Object.hasOwn(autoRow(config), "reasoning"), false);
          assert.deepEqual(autoRow(config).variants, USER_VARIANTS);
          if (native) {
            assert.deepEqual(
              config.providers["fireworks-ai"].models.auto.variants,
              Object.entries(USER_VARIANTS).map(([id, settings]) => ({ id, settings })),
            );
          }
        });
      });
    }

    it(`repairs existing ${format} Auto on update and is idempotent`, async () => {
      await withTempHome("opencode-effort-update-", async (home) => {
        await enableHarness(home);
        const paths = await configAt(home, {
          ...(native ? { providers: {} } : {}),
          model: "fireworks-ai/auto",
          provider: { "fireworks-ai": { models: { auto: { name: "Keep this name" } } } },
        });
        assert.equal(await ensureAutoCatalogEntry("opencode", home), false);
        assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), true);
        const config = await readConfig(paths.configPath);
        assert.deepEqual(autoRow(config), { name: "Keep this name", reasoning: true });
        assert.equal(config.model, "fireworks-ai/auto");
        const after = await readFile(paths.configPath, "utf8");
        assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
        assert.equal(await readFile(paths.configPath, "utf8"), after);
      });
    });
  }

  it("keeps reasoning: false and the user's variants through catalog refresh", async () => {
    await withTempHome("opencode-effort-custom-", async (home) => {
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: { "fireworks-ai": { models: { auto: { reasoning: false, variants: { low: { disabled: true } } } } } },
      });
      await refresh(paths);
      const auto = autoRow(await readConfig(paths.configPath));
      assert.equal(auto.reasoning, false);
      assert.deepEqual(auto.variants, { low: { disabled: true } });
    });
  });

  it("refreshes managed metadata while keeping the user's effort settings", async () => {
    await withTempHome("opencode-effort-metadata-", async (home) => {
      const variants = { high: { temperature: 0.2, reasoningEffort: "medium" }, custom: { temperature: 0.3 } };
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: {
          "fireworks-ai": {
            models: {
              auto: {
                id: "example-remap",
                name: "Stale name",
                cost: { input: 99, output: 99 },
                limit: { context: 1, output: 1 },
                options: { temperature: 0.4 },
                provider: { npm: "example-adapter" },
                variants,
              },
            },
          },
        },
      });
      await refresh(paths);
      const auto = autoRow(await readConfig(paths.configPath));
      for (const key of ["id", "cost", "options", "provider"]) {
        assert.equal(Object.hasOwn(auto, key), false, `managed refresh must discard stale ${key}`);
      }
      assert.deepEqual(auto, { ...buildOpencodeModelEntry("auto"), variants });
    });
  });

  for (const [label, control] of Object.entries(USER_CONTROLS)) {
    it(`keeps ${label} through catalog refresh without adding the flag`, async () => {
      await withTempHome("opencode-effort-control-refresh-", async (home) => {
        const paths = await configAt(home, {
          model: "fireworks-ai/auto",
          provider: { "fireworks-ai": { models: { auto: { name: "Stale name", ...control } } } },
        });
        await refresh(paths);
        assert.deepEqual(autoRow(await readConfig(paths.configPath)), { ...buildOpencodeModelEntry("auto"), ...control });
      });
    });
  }

  for (const [label, malformed] of [
    ["variants: null", { variants: null }],
    ["a non-boolean reasoning flag", { reasoning: "yes" }],
    ["a non-object variant", { variants: { low: "bad" } }],
    ["a non-boolean disabled flag", { variants: { low: { disabled: "yes" } } }],
    ["non-array reasoning_options", { reasoning_options: "bad" }],
    ["an effort option without values", { reasoning_options: [{ type: "effort" }] }],
    ["an unknown option type", { reasoning_options: [{ type: "example" }] }],
  ]) {
    it(`rebuilds a loadable Auto row on catalog refresh despite ${label}`, async () => {
      await withTempHome("opencode-effort-malformed-", async (home) => {
        const paths = await configAt(home, {
          model: "fireworks-ai/auto",
          provider: { "fireworks-ai": { models: { auto: { name: "Auto", ...malformed } } } },
        });
        await refresh(paths);
        assert.deepEqual(autoRow(await readConfig(paths.configPath)), { ...buildOpencodeModelEntry("auto"), reasoning: true });
      });
    });
  }

  it("keeps a valid effort setting when its sibling is malformed on catalog refresh", async () => {
    await withTempHome("opencode-effort-malformed-mixed-", async (home) => {
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: { "fireworks-ai": { models: { auto: { reasoning: false, variants: null } } } },
      });
      await refresh(paths);
      assert.deepEqual(autoRow(await readConfig(paths.configPath)), { ...buildOpencodeModelEntry("auto"), reasoning: false });
    });
  });

  it("rebuilds other auto mixes on catalog refresh, carrying loadable effort settings but adding no flag", async () => {
    await withTempHome("opencode-effort-mix-refresh-", async (home) => {
      const unserved = { name: "User mix", reasoning: true, variants: { custom: { temperature: 0.3 } } };
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: {
          "fireworks-ai": {
            models: {
              auto: { name: "Stale name" },
              "auto-example": { name: "Stale mix", reasoning: true, variants: { custom: { temperature: 0.3 } } },
              "auto-unserved": unserved,
            },
          },
        },
      });
      await refresh(paths, ["auto", "auto-example"]);
      const models = (await readConfig(paths.configPath)).provider["fireworks-ai"].models;
      assert.deepEqual(models.auto, { ...buildOpencodeModelEntry("auto"), reasoning: true });
      assert.deepEqual(models["auto-example"], {
        ...buildOpencodeModelEntry("auto-example"),
        reasoning: true,
        variants: { custom: { temperature: 0.3 } },
      });
      assert.deepEqual(models["auto-unserved"], unserved);
    });
  });

  it("repairs Auto on update without touching other auto mixes", async () => {
    await withTempHome("opencode-effort-mix-update-", async (home) => {
      await enableHarness(home);
      const mix = { name: "User mix", variants: { custom: { temperature: 0.3 } } };
      const remapped = { id: "auto-example", name: "User remap" };
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: { "fireworks-ai": { models: { auto: { name: "Auto" }, "auto-example": mix, "auto-alias": remapped } } },
      });
      assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), true);
      const models = (await readConfig(paths.configPath)).provider["fireworks-ai"].models;
      assert.deepEqual(models.auto, { name: "Auto", reasoning: true });
      assert.deepEqual(models["auto-example"], mix);
      assert.deepEqual(models["auto-alias"], remapped);
    });
  });

  for (const [label, control] of [
    ["reasoning: true", { reasoning: true, variants: USER_VARIANTS }],
    ["reasoning: false", { reasoning: false, variants: USER_VARIANTS }],
    ...Object.entries(USER_CONTROLS),
    ["malformed reasoning_options", { reasoning_options: "bad" }],
  ]) {
    it(`does not rewrite an Auto row on update that sets ${label}`, async () => {
      await withTempHome("opencode-effort-complete-", async (home) => {
        await enableHarness(home);
        const paths = await configAt(home, {
          model: "fireworks-ai/auto",
          provider: { "fireworks-ai": { models: { auto: control } } },
        });
        const before = await readFile(paths.configPath, "utf8");
        assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
        assert.equal(await ensureAutoCatalogEntry("opencode", home), false);
        assert.equal(await readFile(paths.configPath, "utf8"), before);
      });
    });
  }

  it("adds genuine Auto without changing an unrelated resource-path row", async () => {
    await withTempHome("opencode-effort-resource-key-", async (home) => {
      await enableHarness(home);
      const resource = { name: "User resource row", options: { temperature: 0.2 } };
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: { "fireworks-ai": { models: { "accounts/fireworks/models/auto": resource } } },
      });
      assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
      assert.equal(await ensureAutoCatalogEntry("opencode", home), true);
      const config = await readConfig(paths.configPath);
      assert.deepEqual(autoRow(config), { ...buildOpencodeModelEntry("auto"), reasoning: true });
      assert.deepEqual(config.provider["fireworks-ai"].models["accounts/fireworks/models/auto"], resource);
      assert.equal(config.model, "fireworks-ai/auto");
    });
  });

  for (const mode of ["explicit", "offline", "update"]) {
    it(`preserves remapped Auto during ${mode} repair`, async () => {
      await withTempHome("opencode-effort-remap-", async (home) => {
        await enableHarness(home);
        const original = { id: "example-remap", name: "User remap", options: { temperature: 0.2 } };
        const paths = await configAt(home, {
          model: "fireworks-ai/auto",
          provider: { "fireworks-ai": { models: { auto: original } } },
        });
        if (mode === "update") {
          assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
          assert.equal(await ensureAutoCatalogEntry("opencode", home), false);
        } else {
          await enableOpencodeFireworks({
            ...paths,
            apiKey: "fw_example_test_key",
            ...(mode === "explicit" ? { modelId: "auto" } : {}),
            catalogModelIds: [],
            catalogAvailable: false,
          });
        }
        assert.deepEqual(autoRow(await readConfig(paths.configPath)), original);
      });
    });
  }

  it("leaves an Auto row with the user's effort controls as written", () => {
    for (const control of [{ variants: USER_VARIANTS }, ...Object.values(USER_CONTROLS)]) {
      const original = { name: "Auto", ...control };
      const snapshot = structuredClone(original);
      assert.equal(withOpencodeReasoningEffort("auto", original), original);
      assert.deepEqual(original, snapshot);
    }
    const repaired = withOpencodeReasoningEffort("auto", { name: "Auto" });
    assert.deepEqual(repaired, { name: "Auto", reasoning: true });
    assert.equal(withOpencodeReasoningEffort("auto", repaired), repaired);
  });

  it("leaves remapped, unrelated, user-set and malformed rows untouched", () => {
    // The shared helpers accept every `auto-*` mix; the effort flag stays Auto's.
    assert.equal(isAutoModelId("auto-example"), true);
    for (const [id, entry] of [
      ["auto", { id: "example-model" }],
      ["auto", { id: "accounts/fireworks/models/auto" }],
      ["auto", { id: "auto-example" }],
      ["auto-example", {}],
      ["auto-example", { id: "auto" }],
      ["accounts/fireworks/models/auto", {}],
      ["example-account/auto", {}],
      ["auto-instant", {}],
      ["example-model", {}],
      ["auto", { reasoning: false }],
      ["auto", { reasoning: true }],
      ["auto", { reasoning: "false" }],
      ["auto", { reasoning: null }],
      ["auto", { variants: "bad" }],
      ["auto", { variants: null }],
      ["auto", { variants: [] }],
      ["auto", { variants: { low: "bad" } }],
      ["auto", { variants: { low: { disabled: "yes" } } }],
      ["auto", { reasoning_options: "bad" }],
      ["auto", { reasoning_options: [{ type: "effort" }] }],
      ["auto", { provider: { npm: "example-adapter" } }],
      ["auto", null],
    ]) {
      assert.equal(withOpencodeReasoningEffort(id, entry), entry);
    }
    assert.deepEqual(withOpencodeReasoningEffort("fireworks-ai/auto", {}), { reasoning: true });
  });

  it("resolves the SDK as OpenCode does: the row's provider.npm, then the provider's npm", () => {
    const entry = buildOpencodeModelEntry("auto");
    const alternate = { ...entry, provider: { npm: "example-adapter" } };
    const compatible = { ...entry, provider: { npm: "@ai-sdk/openai-compatible" } };
    assert.equal(withOpencodeReasoningEffort("auto", entry, "example-adapter"), entry);
    assert.equal(withOpencodeReasoningEffort("auto", alternate, "@ai-sdk/openai-compatible"), alternate);
    assert.deepEqual(withOpencodeReasoningEffort("auto", entry, "@ai-sdk/openai-compatible"), { ...entry, reasoning: true });
    assert.deepEqual(withOpencodeReasoningEffort("auto", compatible, "example-adapter"), { ...compatible, reasoning: true });
    // `aisdk:`-prefixed and version-suffixed spellings name the same SDK.
    for (const npm of ["aisdk:@ai-sdk/openai-compatible", "@ai-sdk/openai-compatible@1.2.3"]) {
      assert.deepEqual(
        withOpencodeReasoningEffort("auto", { name: "Auto", provider: { npm } }),
        { name: "Auto", provider: { npm }, reasoning: true },
        npm,
      );
    }
  });

  for (const mode of ["fresh", "explicit", "online", "offline"]) {
    it(`does not flag Auto that inherits another provider npm on ${mode} on`, async () => {
      await withTempHome("opencode-effort-provider-npm-", async (home) => {
        const paths = await configAt(home, {
          model: "fireworks-ai/auto",
          provider: { "fireworks-ai": { npm: "example-adapter", models: mode === "fresh" ? {} : { auto: { name: "Auto" } } } },
        });
        await enableOpencodeFireworks({
          ...paths,
          apiKey: "fw_example_test_key",
          ...(mode === "explicit" ? { modelId: "auto" } : {}),
          catalogModelIds: mode === "offline" ? [] : ["auto"],
          catalogAvailable: mode !== "offline",
        });
        const provider = (await readConfig(paths.configPath)).provider["fireworks-ai"];
        assert.equal(provider.npm, "example-adapter");
        assert.equal(Object.hasOwn(provider.models.auto, "reasoning"), false);
      });
    });
  }

  it("does not flag Auto that inherits another provider npm on update", async () => {
    await withTempHome("opencode-effort-provider-npm-update-", async (home) => {
      await enableHarness(home);
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: { "fireworks-ai": { npm: "example-adapter", models: { auto: { name: "Auto" } } } },
      });
      const before = await readFile(paths.configPath, "utf8");
      assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
      assert.equal(await readFile(paths.configPath, "utf8"), before);
    });
  });

  it("backfills Auto without the flag under another provider npm", async () => {
    await withTempHome("opencode-effort-provider-npm-backfill-", async (home) => {
      await enableHarness(home);
      const paths = await configAt(home, {
        model: "fireworks-ai/auto",
        provider: { "fireworks-ai": { npm: "example-adapter", models: {} } },
      });
      assert.equal(await ensureAutoCatalogEntry("opencode", home), true);
      assert.deepEqual(autoRow(await readConfig(paths.configPath)), buildOpencodeModelEntry("auto"));
    });
  });

  for (const mode of ["explicit", "offline", "update"]) {
    it(`flags Auto whose own provider.npm is openai-compatible under another provider npm on ${mode}`, async () => {
      await withTempHome("opencode-effort-row-npm-", async (home) => {
        await enableHarness(home);
        const auto = { name: "Auto", provider: { npm: "@ai-sdk/openai-compatible" } };
        const paths = await configAt(home, {
          model: "fireworks-ai/auto",
          provider: { "fireworks-ai": { npm: "example-adapter", models: { auto } } },
        });
        if (mode === "update") {
          assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), true);
        } else {
          await enableOpencodeFireworks({
            ...paths,
            apiKey: "fw_example_test_key",
            ...(mode === "explicit" ? { modelId: "auto" } : {}),
            catalogModelIds: [],
            catalogAvailable: false,
          });
        }
        assert.deepEqual(autoRow(await readConfig(paths.configPath)), { ...auto, reasoning: true });
      });
    });
  }

  it("keeps a listed model's user variants through catalog refresh without adding the flag", async () => {
    // Registry answers but does not list this model, so Nexus rewrites its row.
    setModelsDevFireworksRegistry(["accounts/fireworks/models/example-other"]);
    try {
      await withTempHome("opencode-effort-listed-refresh-", async (home) => {
        const variants = { high: { temperature: 0.2 } };
        const paths = await configAt(home, {
          model: "fireworks-ai/glm-5p3",
          provider: { "fireworks-ai": { models: { "glm-5p3": { name: "Stale name", variants } } } },
        });
        await refresh(paths, ["accounts/fireworks/models/glm-5p3"]);
        const row = (await readConfig(paths.configPath)).provider["fireworks-ai"].models["glm-5p3"];
        assert.deepEqual(row, { ...buildOpencodeModelEntry("glm-5p3"), variants });
      });
    } finally {
      clearModelsDevFireworksRegistry();
    }
  });

  it("keeps a non-table authored model's opt-out and variants through catalog refresh", async () => {
    // Registry answers but does not list this model, so Nexus rewrites its row.
    setModelsDevFireworksRegistry(["accounts/fireworks/models/example-other"]);
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map(),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map([["accounts/fireworks/models/example-new-model", 1_048_576]]),
      supportsToolsById: new Map(),
    });
    try {
      await withTempHome("opencode-effort-authored-refresh-", async (home) => {
        const variants = { high: { temperature: 0.2 } };
        const paths = await configAt(home, {
          model: "fireworks-ai/example-new-model",
          provider: { "fireworks-ai": { models: { "example-new-model": { name: "Stale name", reasoning: false, variants } } } },
        });
        await refresh(paths, ["accounts/fireworks/models/example-new-model"]);
        const row = (await readConfig(paths.configPath)).provider["fireworks-ai"].models["example-new-model"];
        assert.deepEqual(row, { ...buildOpencodeModelEntry("example-new-model"), reasoning: false, variants });
      });
    } finally {
      clearModelsDevFireworksRegistry();
      setServerlessCatalogSnapshot(null);
    }
  });

  it("flags reasoning-table model rows, not just Auto, on repair", () => {
    for (const id of ["glm-5p3", "accounts/fireworks/models/glm-5p3", "fireworks-ai/glm-5p3"]) {
      assert.deepEqual(withOpencodeReasoningEffort(id, { name: "Model" }), { name: "Model", reasoning: true }, id);
    }
    for (const [id, entry] of [
      // Not in the reasoning table and not authored/selected on this path.
      ["example-new-model", { name: "Model" }],
      // A row with its own id is a remap or user-authored copy.
      ["glm-5p3", { name: "Model", id: "accounts/fireworks/models/glm-5p3" }],
      ["glm-5p3", { name: "Model", variants: { high: { temperature: 0.2 } } }],
      ["glm-5p3", { name: "Model", provider: { npm: "example-adapter" } }],
    ]) {
      assert.equal(withOpencodeReasoningEffort(id, entry), entry, id);
    }
  });

  for (const mode of ["update", "offline re-enable"]) {
    it(`repairs an unselected fast model without a live router mapping during ${mode}`, async () => {
      const fixtureRef = "accounts/fireworks/models/example-fast";
      MODEL_REASONING[fixtureRef] = { levels: ["low", "medium", "high"].map((effort) => ({ effort })) };
      try {
        for (const id of ["example-fast", "fireworks-ai/example-fast", "fireworks/example-fast", fixtureRef]) {
          assert.deepEqual(withOpencodeReasoningEffort(id, { name: "Model" }), { name: "Model", reasoning: true }, id);
        }
        const foreignRef = "accounts/example-account/models/example-fast";
        const foreign = { name: "Other account" };
        assert.equal(withOpencodeReasoningEffort(foreignRef, foreign), foreign);
        await withTempHome("opencode-effort-fast-update-", async (home) => {
          setServerlessCatalogSnapshot(null);
          await enableHarness(home);
          const paths = await configAt(home, {
            model: "fireworks-ai/auto",
            provider: { "fireworks-ai": { models: {
              auto: { name: "Auto", reasoning: true },
              "example-fast": { name: "Fast model" },
            } } },
          });
          if (mode === "update") {
            assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), true);
          } else {
            await enableOpencodeFireworks({ ...paths, apiKey: "fw_example_test_key", catalogModelIds: [], catalogAvailable: false });
          }
          const models = (await readConfig(paths.configPath)).provider["fireworks-ai"].models;
          assert.deepEqual(models["example-fast"], { name: "Fast model", reasoning: true });
          assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
        });
      } finally {
        delete MODEL_REASONING[fixtureRef];
      }
    });
  }

  it("flags any authored catalog-missing row, including models the reasoning table does not list", () => {
    assert.deepEqual(
      withAuthoredOpencodeReasoningEffort("example-new-model", { name: "Model" }),
      { name: "Model", reasoning: true },
    );
    for (const [id, entry] of [
      ["auto-example", { name: "Mix" }],
      ["firerouter", { name: "Router" }],
      ["example-new-model", { name: "Model", id: "example-remap" }],
      ["example-new-model", { name: "Model", reasoning: false }],
    ]) {
      assert.equal(withAuthoredOpencodeReasoningEffort(id, entry), entry, id);
    }
  });

  it("leaves an Auto row with a malformed provider override as written", () => {
    for (const provider of ["bad", 123, [], null, { api: 123 }, { npm: "@ai-sdk/openai-compatible", api: 123 }]) {
      const entry = { name: "Auto", provider };
      assert.equal(withOpencodeReasoningEffort("auto", entry), entry, JSON.stringify(provider));
      assert.equal(withAuthoredOpencodeReasoningEffort("auto", entry), entry, JSON.stringify(provider));
    }
  });

  it("flags a catalog-missing model Nexus writes on fresh setup, listed or not", async () => {
    await withTempHome("opencode-effort-new-model-", async (home) => {
      setServerlessCatalogSnapshot({
        entries: [],
        pricingById: new Map(),
        inputModalitiesById: new Map(),
        routerBaseModelById: new Map(),
        contextLengthById: new Map([
          ["accounts/fireworks/models/example-new-model", 1_048_576],
          ["accounts/fireworks/models/example-second-model", 1_048_576],
        ]),
        supportsToolsById: new Map(),
      });
      try {
        const paths = await configAt(home, {});
        await enableOpencodeFireworks({
          ...paths,
          apiKey: "fw_example_test_key",
          modelId: "auto",
          catalogModelIds: ["auto", "accounts/fireworks/models/example-new-model", "accounts/fireworks/models/example-second-model"],
        });
        const models = (await readConfig(paths.configPath)).provider["fireworks-ai"].models;
        assert.equal(models["example-new-model"].reasoning, true);
        assert.equal(models["example-second-model"].reasoning, true);
        assert.equal(models.auto.reasoning, true);
      } finally {
        setServerlessCatalogSnapshot(null);
      }
    });
  });

  it("repairs listed and selected model rows on offline re-on", async () => {
    await withTempHome("opencode-effort-nonauto-repair-", async (home) => {
      await enableHarness(home);
      const paths = await configAt(home, {
        model: "fireworks-ai/example-new-model",
        provider: {
          "fireworks-ai": {
            models: {
              auto: { name: "Auto" },
              "glm-5p3": { name: "GLM 5.3" },
              "example-new-model": { name: "Selected" },
              "example-unselected": { name: "Unselected" },
              "kimi-k3": { name: "Kimi K3", variants: { high: { temperature: 0.2 } } },
            },
          },
        },
      });
      await enableOpencodeFireworks({ ...paths, apiKey: "fw_example_test_key", catalogModelIds: [], catalogAvailable: false });
      const models = (await readConfig(paths.configPath)).provider["fireworks-ai"].models;
      assert.equal(models.auto.reasoning, true);
      assert.equal(models["glm-5p3"].reasoning, true);
      assert.equal(models["example-new-model"].reasoning, true, "the selected model is Nexus-managed on this path");
      assert.equal(models["example-unselected"].reasoning, undefined);
      assert.deepEqual(models["kimi-k3"], { name: "Kimi K3", variants: { high: { temperature: 0.2 } } });
    });
  });

  it("repairs listed and selected model rows on update from a pre-fix config", async () => {
    await withTempHome("opencode-effort-nonauto-update-", async (home) => {
      await enableHarness(home);
      const paths = await configAt(home, {
        model: "fireworks-ai/example-new-model",
        provider: {
          "fireworks-ai": {
            models: {
              "glm-5p3": { name: "GLM 5.3" },
              "example-new-model": { name: "Selected" },
              "example-unselected": { name: "Unselected" },
            },
          },
        },
      });
      assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), true);
      const models = (await readConfig(paths.configPath)).provider["fireworks-ai"].models;
      assert.equal(models["glm-5p3"].reasoning, true);
      assert.equal(models["example-new-model"].reasoning, true);
      assert.equal(models["example-unselected"].reasoning, undefined);
      assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
    });
  });

  for (const fixture of [
    { name: "disabled harness", enabled: false, model: "fireworks-ai/auto", provider: { "fireworks-ai": { models: { auto: {} } } } },
    { name: "custom routing", model: "example/model", provider: { "fireworks-ai": { models: { auto: {} } } } },
    { name: "native-only provider", model: "fireworks-ai/auto", providers: { "fireworks-ai": { models: { auto: {} } } } },
  ]) {
    it(`does not claim ${fixture.name} during update`, async () => {
      await withTempHome("opencode-effort-gate-", async (home) => {
        const { name, enabled = true, ...config } = fixture;
        await writeGlobalConfig(home, { harnesses: { opencode: { enabled, provider: "fireworks" } } });
        const paths = await configAt(home, config);
        const before = await readFile(paths.configPath, "utf8");
        assert.equal(await migrateOpencodeReasoningEffortOnUpgrade(home), false);
        assert.equal(await ensureAutoCatalogEntry("opencode", home), false);
        assert.equal(await readFile(paths.configPath, "utf8"), before);
      });
    });
  }
});
