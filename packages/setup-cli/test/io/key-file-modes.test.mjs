import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { enablePiFireworks } from "../../lib/harnesses/pi/core.mjs";
import { enableCopilotCli } from "../../lib/harnesses/copilot-cli/config.mjs";
import { withTempHome } from "../helpers.mjs";

/**
 * Record the mode of every file at the moment it is renamed into place, so a
 * key file that is only chmod-ed after the rename (readable in between) is
 * caught, not just its final mode.
 */
async function recordRenameModes(fn) {
  const original = fs.promises.rename;
  const seen = new Map();
  fs.promises.rename = async (from, to) => {
    seen.set(path.basename(String(to)), (await stat(from)).mode & 0o777);
    return original(from, to);
  };
  syncBuiltinESMExports();
  const umask = process.umask(0o022);
  try {
    await fn();
  } finally {
    process.umask(umask);
    fs.promises.rename = original;
    syncBuiltinESMExports();
  }
  return seen;
}

describe("key-bearing harness files are owner-only from creation", { skip: process.platform === "win32" }, () => {
  it("Pi auth.json and its snapshot are created 0600 in an owner-only dir", async () => {
    await withTempHome("pi-modes", async (home) => {
      const agentDir = path.join(home, ".pi", "agent");
      const seen = await recordRenameModes(() => enablePiFireworks({
        settingsPath: path.join(agentDir, "settings.json"),
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
        dataDir: path.join(home, ".nexus", "pi"),
        home,
        apiKey: "fw_TEST_NOT_A_REAL_KEY",
        modelId: "glm-5p2",
      }));
      assert.equal(seen.get("auth.json"), 0o600);
      assert.equal((await stat(agentDir)).mode & 0o077, 0);
    });
  });

  it("Copilot CLI providers.json and its backup are created 0600", async () => {
    await withTempHome("copilot-modes", async (home) => {
      const providersPath = path.join(home, ".copilot", "providers.json");
      const seen = await recordRenameModes(() => enableCopilotCli({
        providersPath,
        dataDir: path.join(home, ".nexus", "copilot-cli"),
        apiKey: "fw_TEST_NOT_A_REAL_KEY",
        models: [],
      }));
      assert.equal(seen.get("providers.json"), 0o600);
      for (const [name, mode] of seen) assert.equal(mode, 0o600, name);
    });
  });
});
