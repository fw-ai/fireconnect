import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CODEX_CATALOG_TOML_REF,
  disableCodexFireworks,
  enableCodexFireworks,
} from "../../lib/harnesses/codex/core.mjs";
import { defaultMainModel } from "../../lib/fireworks/model-id.mjs";
import { withTempHome } from "../helpers.mjs";

async function setup(home, defaultConfig) {
  const catalogPath = path.join(home, ".codex", "fireworks-model-catalog.json");
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, "{\"models\":[]}\n");
  await writeFile(path.join(home, ".codex", "config.toml"), defaultConfig);
  const otherConfig = path.join(home, "other-codex", "config.toml");
  await mkdir(path.dirname(otherConfig), { recursive: true });
  await writeFile(otherConfig, "model = \"gpt-5\"\n");
  return { catalogPath, otherConfig };
}

describe("codex off --config-path and the shared catalog", () => {
  it("keeps the catalog the default config still points at", async () => {
    await withTempHome("codex-shared-catalog-", async (home) => {
      const { catalogPath, otherConfig } = await setup(home, `model_catalog_json = "${CODEX_CATALOG_TOML_REF}"\n`);
      const result = await disableCodexFireworks({
        configPath: otherConfig,
        dataDir: path.join(home, ".nexus", "codex"),
        catalogPath,
      });
      assert.equal(result, "noop");
      assert.equal(existsSync(catalogPath), true, "the default config's catalog survives");
    });
  });

  it("still removes a catalog nothing references", async () => {
    await withTempHome("codex-unshared-catalog-", async (home) => {
      const { catalogPath, otherConfig } = await setup(home, "model = \"gpt-5\"\n");
      await disableCodexFireworks({ configPath: otherConfig, dataDir: path.join(home, ".nexus", "codex"), catalogPath });
      assert.equal(existsSync(catalogPath), false);
    });
  });

  it("keeps the default config's catalog when disabling an alternate config", async () => {
    await withTempHome("codex-shared-catalog-sequence-", async (home) => {
      const { catalogPath, otherConfig } = await setup(home, "model = \"gpt-5\"\n");
      const defaultConfig = path.join(home, ".codex", "config.toml");
      const catalog = { models: [{ slug: defaultMainModel(), display_name: "Default model" }] };
      const enable = (configPath, dataDir) => enableCodexFireworks({
        configPath,
        dataDir,
        apiKey: "fw_test_key_000000000000000000000000",
        catalogPath,
        catalog,
        catalogAvailable: true,
      });

      await enable(otherConfig, path.join(home, ".nexus", "codex-alternate"));
      await enable(defaultConfig, path.join(home, ".nexus", "codex"));
      const catalogWhileDefaultEnabled = await readFile(catalogPath);

      await disableCodexFireworks({
        configPath: otherConfig,
        dataDir: path.join(home, ".nexus", "codex-alternate"),
        catalogPath,
      });

      assert.deepEqual(await readFile(catalogPath), catalogWhileDefaultEnabled);
      assert.ok((await readFile(defaultConfig, "utf8")).includes(CODEX_CATALOG_TOML_REF));
    });
  });
});
