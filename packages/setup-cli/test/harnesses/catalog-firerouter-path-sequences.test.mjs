import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { codexCatalogPath, codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { OPENCODE_FIREWORKS_PROVIDER_ID, opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { USER_SETTINGS_RELATIVE_PATH } from "../../lib/harnesses/claude/core.mjs";
import { isFireconnectProvider } from "../../lib/harnesses/vscode/core.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

const API_KEY = "fw_cataloged_v1_adversarial000000";
const ANTHROPIC_KEY = "sk-ant-catalog-firerouter-astra-0000";
const FIREROUTER_TEST_PATH = "firerouter/test-model";
const NO_ENV = { FIREWORKS_API_KEY: "" };

/** Run plain on, select a FireRouter path, then rerun without a model. */
async function runFirerouterPathSequence(home, harness, modelArgs = ["--model", FIREROUTER_TEST_PATH]) {
  for (const args of [
    [harness, "on", "--api-key", API_KEY],
    [harness, "on", "--api-key", API_KEY, ...modelArgs],
    [harness, "on", "--api-key", API_KEY],
  ]) {
    const result = await runFireconnect(args, { HOME: home, ...NO_ENV });
    assert.equal(result.code, 0, result.stderr);
  }
}

describe("FireRouter path catalog sequences across harnesses", () => {
  it("codex: switching to bare firerouter keeps the path catalog row", async () => {
    await withTempHome("seq-codex-bare-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      await runFirerouterPathSequence(home, "codex");
      const bare = await runFireconnect(
        [
          "codex", "on", "--api-key", API_KEY,
          "--model", "firerouter", "--anthropic-api-key", ANTHROPIC_KEY,
        ],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(bare.code, 0, bare.stderr);

      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /model = "firerouter"/);
      const slugs = JSON.parse(await readFile(codexCatalogPath(home), "utf8"))
        .models
        .map((row) => row.slug);
      assert.ok(slugs.includes(FIREROUTER_TEST_PATH), "prior compound row not dropped");
      assert.ok(slugs.includes("firerouter"));
    });
  });

  it("opencode: selecting a FireRouter path keeps its override", async () => {
    await withTempHome("seq-opencode-", async (home) => {
      await mkdir(path.join(home, ".config/opencode"), { recursive: true });
      await runFirerouterPathSequence(home, "opencode");

      const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
      assert.equal(config.model, `fireworks-ai/${FIREROUTER_TEST_PATH}`);
      const models = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.models ?? {};
      assert.ok(models[FIREROUTER_TEST_PATH]);
      assert.ok(models["kimi-latest"]);
    });
  });

  it("pi: selecting a FireRouter path keeps its model entry", async () => {
    await withTempHome("seq-pi-", async (home) => {
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await runFirerouterPathSequence(home, "pi");

      const settings = JSON.parse(await readFile(piSettingsPath(home), "utf8"));
      assert.equal(settings.defaultModel, FIREROUTER_TEST_PATH);

      const ids = JSON.parse(await readFile(piModelsPath(home), "utf8"))
        .providers
        .fireworks
        .models
        .map((row) => row.id);
      assert.ok(ids.includes(FIREROUTER_TEST_PATH));
    });
  });

  it("claude: selecting a FireRouter path adds it to the picker without slot pins", async () => {
    await withTempHome("seq-claude-", async (home) => {
      assert.equal(
        (await runFireconnect(
          ["claude", "on", "--api-key", API_KEY],
          { HOME: home, ...NO_ENV },
        )).code,
        0,
      );
      const withPath = await runFireconnect(
        ["claude", "on", "--api-key", API_KEY, "--model", FIREROUTER_TEST_PATH],
        { HOME: home, ...NO_ENV },
      );
      assert.equal(withPath.code, 0, withPath.stderr);

      const settings = JSON.parse(await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"));
      assert.equal(settings.model, "firerouter[1m]");
      assert.equal(settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
      assert.equal(settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
      const pickerModels = settings.modelPicker?.options?.map((row) => row.model) ?? [];
      assert.ok(pickerModels.includes(`${FIREROUTER_TEST_PATH}[1m]`));
    });
  });

  it("vscode: selecting a FireRouter path registers it in the catalog", async () => {
    await withTempHome("seq-vscode-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await writeFile(vscodePath, "[]\n");

      for (const args of [
        ["vscode", "on", "--api-key", API_KEY, "--vscode-path", vscodePath, "--force"],
        ["vscode", "on", "--api-key", API_KEY, "--model", FIREROUTER_TEST_PATH, "--vscode-path", vscodePath, "--force"],
        ["vscode", "on", "--api-key", API_KEY, "--vscode-path", vscodePath, "--force"],
      ]) {
        const result = await runFireconnect(args, { HOME: home, ...NO_ENV });
        assert.equal(result.code, 0, result.stderr);
      }

      const provider = JSON.parse(await readFile(vscodePath, "utf8")).find(isFireconnectProvider);
      assert.ok(provider, "fireconnect provider registered");
      const ids = provider.models.map((row) => row.id);
      assert.ok(ids.includes(FIREROUTER_TEST_PATH));
      assert.ok(ids.includes("kimi-latest"));
      const compound = provider.models.find((row) => row.id === FIREROUTER_TEST_PATH);
      assert.equal(compound.vision, true);
    });
  });

});
