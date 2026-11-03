import { isEnabledFireworksHarness, readGlobalConfig } from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import { withCodexConstantFields } from "./catalog.mjs";
import {
  codexCatalogPath,
  codexConfigPath,
  fireconnectManagedVariant,
  snapshotReferencesFireworksCatalog,
} from "./core.mjs";
import { parseToml } from "./toml.mjs";
import { repairDuplicateCodexHttpHeadersRaw, stripStaleCodexWebSearchDisabledRaw } from "./toml-patch.mjs";

/**
 * Re-stamp the current constant catalog fields, `supports_search_tool`
 * included, onto the Nexus-managed Codex catalog of an enabled
 * Fireworks-routed config.
 * @param {string} home
 * @returns {Promise<boolean>} true when the catalog was updated
 */
export async function migrateCodexCatalogConstantsOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const { harnesses } = await readGlobalConfig(home);
  if (!isEnabledFireworksHarness(harnesses, HARNESS.CODEX)) {
    return false;
  }
  const snapshot = await readRawIfExists(codexConfigPath(home));
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return false;
  }
  if (fireconnectManagedVariant(parseToml(snapshot.raw)) !== "fireworks"
    || !snapshotReferencesFireworksCatalog(snapshot.raw)) {
    return false;
  }
  const catalogPath = codexCatalogPath(home);
  const catalog = await readJsonIfExists(catalogPath);
  if (!Array.isArray(catalog?.models)) {
    return false;
  }
  const models = withCodexConstantFields(catalog.models);
  if (JSON.stringify(models) === JSON.stringify(catalog.models)) {
    return false;
  }
  await writeJson(catalogPath, { ...catalog, models }, { mode: 0o600 });
  return true;
}

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

/**
 * Write back a config.toml an earlier key rotation left with two
 * `http_headers` definitions, which keeps Codex from starting. Not gated on
 * Codex being enabled: the duplicate sits in the Nexus-owned provider table,
 * and Codex can't load the file either way. Throws when the repair still
 * doesn't parse, leaving the file unchanged.
 * @param {string} home
 * @returns {Promise<boolean>} true when the file was repaired
 */
export async function repairCodexDuplicateHttpHeadersOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const configPath = codexConfigPath(home);
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed) {
    return false;
  }
  const repaired = repairDuplicateCodexHttpHeadersRaw(snapshot.raw);
  if (repaired === snapshot.raw) {
    return false;
  }
  parseToml(repaired);
  await writeFileAtomic(configPath, repaired, { mode: 0o600 });
  return true;
}
