import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexCatalogPath, codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { OPENCODE_FIREWORKS_PROVIDER_ID, opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { deletePersistedCatalogCache } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

const V1_KEY = "fw_cataloged_v1_adversarial000000";
const V2_KEY = "fw_cataloged_v2_adversarial000000";
const NO_ENV = { FIREWORKS_API_KEY: "" };
const SELECTED = "kimi-latest";
const DELISTED_SELECTED = "deepseek-v4-flash";

function clearCatalogCacheForHome(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    deletePersistedCatalogCache();
  } finally {
    process.env.HOME = prevHome;
  }
}

async function runOnSequence(home, harness, { model = "", apiKey = V1_KEY } = {}) {
  const base = [harness, "on", "--api-key", apiKey];
  const withModel = model ? [...base, "--model", model] : base;
  const steps = [
    await runFireconnect(base, { HOME: home, ...NO_ENV }),
    await runFireconnect(withModel, { HOME: home, ...NO_ENV }),
    await runFireconnect(withModel, { HOME: home, ...NO_ENV }),
  ];
  for (const step of steps) {
    assert.equal(step.code, 0, step.stderr);
  }
  return steps;
}

describe("catalog rerun adversarial scenarios", () => {
  it("codex plain on prunes missing rows and adds newly served ones", async () => {
    await withTempHome("adv-codex-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await runOnSequence(home, "codex", { model: SELECTED });

      const catalogPath = codexCatalogPath(home);
      const beforeV2 = JSON.parse(await readFile(catalogPath, "utf8"));
      beforeV2.models.push({
        slug: "retired-user-model",
        display_name: "Retired",
        context_window: 1000,
        max_context_window: 1000,
      });
      await writeFile(catalogPath, `${JSON.stringify(beforeV2, null, 2)}\n`);

      clearCatalogCacheForHome(home);
      const v2 = await runFireconnect(
        ["codex", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const slugs = JSON.parse(await readFile(catalogPath, "utf8")).models.map((row) => row.slug);
      assert.ok(slugs.includes("glm-latest"), "new v2 model is added");
      assert.ok(slugs.includes("kimi-latest"), "v2 catalog keeps kimi-latest");
      assert.ok(!slugs.includes("retired-user-model"), "user row missing from serverless is dropped");
      assert.ok(!slugs.includes("deepseek-v4-flash"), "delisted model removed when not selected");
      assert.equal(slugs.length, new Set(slugs).size, "no duplicate rows");
    });
  });

  it("codex preserves a FireRouter path and catalog ref on re-on without --model", async () => {
    await withTempHome("adv-codex-firerouter-path-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const plain = await runFireconnect(
        ["codex", "on", "--api-key", V1_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(plain.code, 0, plain.stderr);
      const select = await runFireconnect(
        ["codex", "on", "--api-key", V1_KEY, "--model", "firerouter/test-model"],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(select.code, 0, select.stderr);
      const rerun = await runFireconnect(
        ["codex", "on", "--api-key", V1_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(rerun.code, 0, rerun.stderr);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /model = "firerouter\/test-model"/);
      assert.match(config, /model_catalog_json/);
      const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
      assert.ok(slugs.includes("firerouter/test-model"));
    });
  });

  it("codex drops a delisted catalog row even when its model stays selected", async () => {
    await withTempHome("adv-codex-selected-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const first = await runFireconnect(
        ["codex", "on", "--api-key", V1_KEY, "--model", DELISTED_SELECTED],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(first.code, 0, first.stderr);

      clearCatalogCacheForHome(home);
      // Preserve the configured model while refreshing its catalog row.
      const v2 = await runFireconnect(
        ["codex", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
      assert.ok(!slugs.includes(DELISTED_SELECTED), "delisted model removed from catalog");
      assert.ok(slugs.includes("glm-latest"), "new v2 model is added");
      assert.match(await readFile(codexConfigPath(home), "utf8"), /model = "deepseek-v4-flash"/);
    });
  });

  it("opencode plain on prunes missing rows and adds newly served ones", async () => {
    await withTempHome("adv-opencode-", async (home) => {
      await mkdir(path.join(home, ".config/opencode"), { recursive: true });
      await runOnSequence(home, "opencode", { model: SELECTED });

      const configPath = opencodeConfigPath(home);
      const stale = JSON.parse(await readFile(configPath, "utf8"));
      stale.provider[OPENCODE_FIREWORKS_PROVIDER_ID].models["retired-user-model"] = {
        name: "Retired",
        limit: { context: 1000, output: 1000 },
      };
      await writeFile(configPath, `${JSON.stringify(stale, null, 2)}\n`);

      clearCatalogCacheForHome(home);
      const v2 = await runFireconnect(
        ["opencode", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const models = JSON.parse(await readFile(configPath, "utf8"))
        .provider[OPENCODE_FIREWORKS_PROVIDER_ID].models;
      const keys = Object.keys(models);
      assert.ok(keys.includes("glm-latest"), "new v2 model is added");
      assert.ok(keys.includes("kimi-latest"), "v2 catalog keeps kimi-latest");
      assert.equal(models["retired-user-model"], undefined, "stale provider row dropped");
      assert.equal(models["deepseek-v4-flash"], undefined, "delisted catalog model not re-registered");
      assert.equal(models["accounts/fireworks/models/deepseek-v4-flash"], undefined, "no duplicate full-id key");
    });
  });

  it("pi plain on prunes missing rows and adds newly served ones", async () => {
    await withTempHome("adv-pi-", async (home) => {
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await runOnSequence(home, "pi", { model: SELECTED });

      const modelsPath = piModelsPath(home);
      clearCatalogCacheForHome(home);
      const v2 = await runFireconnect(
        ["pi", "on", "--api-key", V2_KEY],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(v2.code, 0, v2.stderr);

      const fireworks = JSON.parse(await readFile(modelsPath, "utf8")).providers.fireworks;
      const ids = fireworks.models.map((row) => row.id);
      assert.ok(ids.some((id) => id.endsWith("/glm-latest")), "new v2 router is added");
      assert.ok(ids.some((id) => id.endsWith("/kimi-latest")), "v2 catalog keeps kimi-latest router");
      assert.ok(
        ids.some((id) => id.endsWith(`/routers/${SELECTED}`)),
        "active router model stays registered",
      );
      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultModel, `accounts/fireworks/routers/${SELECTED}`);
    });
  });
});
