import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import { codexConfigPath, fireconnectManagedVariant } from "./core.mjs";
import { parseToml } from "./toml.mjs";
import { stripStaleCodexWebSearchDisabledRaw } from "./toml-patch.mjs";

/**
 * Remove the web_search = "disabled" override written by FireConnect 0.9.6
 * from an enabled Fireworks-routed Codex config. Other web_search values are
 * user-owned and remain unchanged.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was updated
 */
export async function migrateCodexWebSearchOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CODEX)) {
    return false;
  }
  const configPath = codexConfigPath(home);
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  if (fireconnectManagedVariant(parseToml(snapshot.raw)) !== "fireworks") {
    return false;
  }
  const migrated = stripStaleCodexWebSearchDisabledRaw(snapshot.raw);
  if (migrated === snapshot.raw) {
    return false;
  }
  await writeFileAtomic(configPath, migrated, { mode: 0o600 });
  return true;
}
