import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { reconcileHarnessConfigOnUpgrade } from "../keys/sync.mjs";
import { reprobeKeyStorage } from "../keys/secret-store.mjs";
import { resolveFireworksApiKeyValue } from "../keys/api-key.mjs";
import { loadServerlessCatalog } from "../fireworks/models.mjs";
import { ensureCliDependencies, resolveSetupCliDir } from "./ensure-cli-deps.mjs";
import { runHarnessForwardMigrations } from "./forward-migrations.mjs";

/**
 * Best-effort serverless catalog refresh so upgrade/reinstall leave a fresh
 * snapshot behind — otherwise the new models/aliases a release advertises
 * only appear after the user's next online `on`. Silent in both directions:
 * offline installs keep serving their last-known snapshot, and keyless
 * installs (nothing to fetch with) skip entirely.
 * @param {string} home
 * @returns {Promise<boolean>} true when the cache was refreshed
 */
export async function refreshServerlessCatalog(home) {
  const apiKey = await resolveFireworksApiKeyValue({ home });
  if (!apiKey.trim()) {
    return false;
  }
  try {
    await loadServerlessCatalog({ apiKey: apiKey.trim(), refresh: true });
    return true;
  } catch {
    // Offline or dead key — keep serving the last-known snapshot.
    return false;
  }
}

/**
 * Shared post-bootstrap repair for `install.sh` and `fireconnect upgrade`.
 *
 * Bootstrap stays separate (bash clone vs git reset). Everything state-sensitive
 * after the CLI bits are on disk goes through this path:
 *   1. ensure runtime npm deps
 *   2. re-probe secret storage / migrate plaintext → secure
 *   3. refresh the serverless catalog snapshot (best-effort, silent)
 *   4. run key-independent harness migrations, then rebake keys / shell hook
 *
 * Never throws for reconcile/shell failures (best-effort). Dep install and
 * key-storage probe may throw only if callers choose to surface them — this
 * wrapper keeps probe/reconcile non-fatal for install.sh.
 *
 * @param {{
 *   home?: string,
 *   installDir?: string,
 *   setupDir?: string,
 *   log?: (...args: unknown[]) => void,
 *   ensureDeps?: typeof ensureCliDependencies,
 *   reprobe?: typeof reprobeKeyStorage,
 *   refreshCatalog?: typeof refreshServerlessCatalog,
 *   migrate?: typeof runHarnessForwardMigrations,
 *   reconcile?: typeof reconcileHarnessConfigOnUpgrade,
 * }} [options]
 * @returns {Promise<{ notes: string[], migrated: boolean, setupDir: string }>}
 */
export async function finalizeInstallOrUpgrade({
  home = process.env.HOME ?? "",
  installDir = home ? path.join(home, ".fireconnect/cli") : "",
  setupDir = "",
  log = console.log,
  ensureDeps = ensureCliDependencies,
  reprobe = reprobeKeyStorage,
  refreshCatalog = refreshServerlessCatalog,
  migrate = runHarnessForwardMigrations,
  reconcile = reconcileHarnessConfigOnUpgrade,
} = {}) {
  const notes = [];
  const durableSetup = installDir
    ? path.join(installDir, "packages/setup-cli")
    : "";
  const resolvedSetup = setupDir
    || (durableSetup && existsSync(path.join(durableSetup, "package.json"))
      ? durableSetup
      : resolveSetupCliDir());

  if (existsSync(path.join(resolvedSetup, "package.json"))) {
    ensureDeps(resolvedSetup);
  }

  let migrated = false;
  if (home) {
    try {
      const result = await reprobe(home);
      migrated = Boolean(result.migrated);
      if (migrated) {
        log("Moved Fireworks API key from plaintext fallback to secure storage.");
      } else if (result.backend?.backend === "plaintext") {
        log(
          "API key is still in the plaintext fallback (~/.fireconnect/.api-key); "
            + "secure storage is still unavailable on this host.",
        );
      }
    } catch {
      // Best-effort: install/upgrade must not abort after the CLI is already on disk.
    }

    try {
      await refreshCatalog(home);
    } catch {
      // Best-effort: an offline upgrade keeps serving the last-known snapshot.
    }

    try {
      for (const note of await migrate(home)) {
        log(note);
        notes.push(note);
      }
    } catch {
      // Best-effort forward migrations.
    }

    try {
      const reconcileNotes = await reconcile(home);
      for (const note of reconcileNotes) {
        log(note);
        notes.push(note);
      }
    } catch {
      // Best-effort reconcile.
    }
  }

  return { notes, migrated, setupDir: resolvedSetup };
}
