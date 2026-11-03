import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { codexCatalogPath } from "../../lib/harnesses/codex/core.mjs";
import { isCodexOpenaiModelSlug } from "../../lib/harnesses/codex/catalog.mjs";
import { OPENCODE_FIREWORKS_PROVIDER_ID, opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { copilotProvidersPath } from "../../lib/harnesses/copilot-cli/config.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

// Two accounts the mock gateway serves different catalogs to: the "Pro" key
// runs under a plan limited to `auto`, the "Enterprise" key gets v2's list.
const PRO_KEY = "fw_cataloged_v1_pro_account0000000";
const ENTERPRISE_KEY = "fw_cataloged_v2_enterprise0000000";
const NO_ENV = { FIREWORKS_API_KEY: "" };
const PRO = { NEXUS_TEST_PLAN_TIER: "PRO" };
// Nothing listens here: a gateway that can't be reached.
const OFFLINE = { NEXUS_GATEWAY_URL: "http://127.0.0.1:9" };

const LISTS = {
  claude: {
    dir: ".claude",
    read: async (home) => JSON.parse(await readFile(userSettingsPath(home), "utf8")).modelPicker.options
      .map((row) => row.model.replace(/\[1m\]$/, "")),
  },
  codex: {
    dir: ".codex",
    read: async (home) => JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models
      .map((row) => row.slug)
      .filter((slug) => !isCodexOpenaiModelSlug(slug)),
  },
  opencode: {
    dir: ".config/opencode",
    read: async (home) => Object.keys(
      JSON.parse(await readFile(opencodeConfigPath(home), "utf8")).provider[OPENCODE_FIREWORKS_PROVIDER_ID].models,
    ),
  },
  "copilot-cli": {
    dir: ".copilot",
    read: async (home) => JSON.parse(await readFile(copilotProvidersPath({ home }), "utf8")).models
      .map((row) => row.id),
  },
};
const HARNESS_IDS = Object.keys(LISTS);

async function run(home, args, env = {}) {
  const result = await runFireconnect(args, { HOME: home, ...NO_ENV, ...env });
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  return result;
}

const readAll = async (home) => Object.fromEntries(await Promise.all(
  HARNESS_IDS.map(async (id) => [id, await LISTS[id].read(home)]),
));

/** Every harness on, under the Pro account. */
async function onWithProAccount(home) {
  await run(home, ["login", "--api-key", PRO_KEY], PRO);
  for (const id of HARNESS_IDS) {
    await mkdir(path.join(home, LISTS[id].dir), { recursive: true });
    await run(home, [id, "on"], PRO);
    assert.deepEqual(await LISTS[id].read(home), ["auto"], `${id}: a Pro plan's list holds only auto`);
  }
}

describe("model lists after an account switch", () => {
  it("the next `on` lists the new account's models, with or without --model", async () => {
    await withTempHome("acct-switch-lists-", async (home) => {
      await onWithProAccount(home);
      await run(home, ["login", "--api-key", ENTERPRISE_KEY]);

      for (const id of HARNESS_IDS) {
        // What the desktop app runs after an account switch.
        await run(home, [id, "on", "--model", "auto"]);
        const withModel = await LISTS[id].read(home);
        assert.ok(withModel.length > 1, `${id}: the Enterprise account's models are listed: ${withModel}`);
        assert.ok(withModel.includes("auto"), `${id}: auto stays`);

        await run(home, [id, "on"]);
        assert.deepEqual(await LISTS[id].read(home), withModel, `${id}: --model and a plain on agree`);
      }
    });
  });

  it("`on` serves the list from the catalog cache login refreshed", async () => {
    await withTempHome("acct-switch-cache-", async (home) => {
      await onWithProAccount(home);
      await run(home, ["login", "--api-key", ENTERPRISE_KEY]);

      for (const id of HARNESS_IDS) {
        await run(home, [id, "on"], OFFLINE);
        const slugs = await LISTS[id].read(home);
        assert.ok(slugs.length > 1, `${id}: listed from the cache with no gateway: ${slugs}`);
      }
    });
  });

  it("a plan change on the same key reaches `on` after `model list --refresh`", async () => {
    await withTempHome("plan-change-lists-", async (home) => {
      // Same key throughout: only the plan changes, so the cache still matches.
      await run(home, ["login", "--api-key", ENTERPRISE_KEY], PRO);
      for (const id of HARNESS_IDS) {
        await mkdir(path.join(home, LISTS[id].dir), { recursive: true });
        await run(home, [id, "on"], PRO);
        assert.deepEqual(await LISTS[id].read(home), ["auto"], `${id}: a Pro plan's list holds only auto`);
      }

      // The cache still matches the key: `on` alone keeps the old plan's list.
      await run(home, ["opencode", "on", "--model", "auto"]);
      assert.deepEqual(await LISTS.opencode.read(home), ["auto"], "opencode: on serves the cached plan");

      await run(home, ["model", "list", "--refresh"]);
      for (const id of HARNESS_IDS) {
        await run(home, [id, "on", "--model", "auto"]);
        const upgraded = await LISTS[id].read(home);
        assert.ok(upgraded.length > 1, `${id}: the upgraded plan's models are listed: ${upgraded}`);

        // Offline, the refreshed cache keeps the list.
        await run(home, [id, "on"], OFFLINE);
        assert.deepEqual(await LISTS[id].read(home), upgraded, `${id}: offline keeps the list`);
      }
    });
  });

  it("a login that can't fetch the catalog leaves lists alone until one can", async () => {
    await withTempHome("acct-switch-offline-", async (home) => {
      await onWithProAccount(home);
      const before = await readAll(home);

      // Not "cataloged": the mock gateway 404s this key's listing, like an outage.
      await run(home, ["login", "--api-key", "fw_switched_account_offline000000"]);
      for (const id of HARNESS_IDS) {
        await run(home, [id, "on"]);
      }

      assert.deepEqual(await readAll(home), before, "the previous lists are kept, nothing crashes");
    });
  });
});
