import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../../lib/config/global-config.mjs";
import { opencodeConfigPath } from "../../lib/harnesses/opencode/core.mjs";
import { piAuthPath } from "../../lib/harnesses/pi/core.mjs";
import { reconcileHarnessConfigOnUpgrade } from "../../lib/keys/sync.mjs";
import { seedKeychainConfig, withTempHome } from "../helpers.mjs";

const KEY = "fw_upgrade_rebake_key_000000000000";

describe("reconcileHarnessConfigOnUpgrade", () => {
  it("rebakes legacy env-ref harness configs and repairs global env-ref", async () => {
    await withTempHome("upgrade-rebake-", async (home) => {
      process.env.SHELL = "/bin/zsh";
      await seedKeychainConfig(home, KEY);
      await writeGlobalConfig(home, {
        apiKey: FIREWORKS_API_KEY_ENV_REF,
        harnesses: {
          opencode: { enabled: true, provider: "fireworks" },
          pi: { enabled: true, provider: "fireworks" },
        },
      });
      await mkdir(path.dirname(opencodeConfigPath(home, "")), { recursive: true });
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await writeFile(
        opencodeConfigPath(home, ""),
        `${JSON.stringify({
          model: "fireworks-ai/accounts/fireworks/models/glm-4p6",
          provider: {
            "fireworks-ai": {
              options: { apiKey: FIREWORKS_API_KEY_ENV_REF },
              models: {},
            },
          },
        }, null, 2)}\n`,
      );
      await writeFile(
        piAuthPath(home),
        `${JSON.stringify({
          fireworks: { type: "api_key", key: "$FIREWORKS_API_KEY", managedBy: "fireconnect" },
        }, null, 2)}\n`,
      );
      await writeFile(
        path.join(home, ".zshrc"),
        [
          "# >>> fireconnect >>>",
          'export FIREWORKS_API_KEY="$(fireconnect key export 2>/dev/null)"',
          "# <<< fireconnect <<<",
          "",
        ].join("\n"),
      );

      const notes = await reconcileHarnessConfigOnUpgrade(home);
      assert.equal(notes.filter((n) => /OpenCode|Pi/.test(n)).length, 2, notes.join("\n"));

      const config = await readGlobalConfig(home);
      assert.equal(config.apiKey, FIREWORKS_API_KEY_KEYCHAIN_REF);

      const opencode = JSON.parse(await readFile(opencodeConfigPath(home, ""), "utf8"));
      assert.equal(opencode.provider["fireworks-ai"].options.apiKey, KEY);

      const auth = JSON.parse(await readFile(piAuthPath(home), "utf8"));
      assert.equal(auth.fireworks.key, KEY);

      assert.doesNotMatch(await readFile(path.join(home, ".zshrc"), "utf8"), /export FIREWORKS_API_KEY=/);
    });
  });

  it("no-ops when no stored key is available", async () => {
    await withTempHome("upgrade-rebake-empty-", async (home) => {
      await writeGlobalConfig(home, {
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      assert.deepEqual(await reconcileHarnessConfigOnUpgrade(home), []);
    });
  });

  it("does not throw when shell hook reconcile fails", async () => {
    await withTempHome("upgrade-rebake-shell-fail-", async (home) => {
      process.env.SHELL = "/bin/zsh";
      await seedKeychainConfig(home, KEY);
      await writeGlobalConfig(home, {
        harnesses: { pi: { enabled: true, provider: "fireworks" } },
      });
      await mkdir(path.join(home, ".pi/agent"), { recursive: true });
      await writeFile(
        piAuthPath(home),
        `${JSON.stringify({
          fireworks: { type: "api_key", key: "$FIREWORKS_API_KEY", managedBy: "fireconnect" },
        }, null, 2)}\n`,
      );
      // Block shell hook writes — rebake must still complete without throwing.
      await mkdir(path.join(home, ".zshrc"), { recursive: true });

      await assert.doesNotReject(() => reconcileHarnessConfigOnUpgrade(home));
      assert.equal(JSON.parse(await readFile(piAuthPath(home), "utf8")).fireworks.key, KEY);
    });
  });
});
