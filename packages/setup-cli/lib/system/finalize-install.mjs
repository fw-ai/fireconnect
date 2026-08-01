import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { rebakeEnabledHarnessKeysOnUpgrade } from "../keys/sync.mjs";
import { reprobeKeyStorage } from "../keys/secret-store.mjs";
import { ensureCliDependencies, resolveSetupCliDir } from "./ensure-cli-deps.mjs";

/**
 * Shared post-bootstrap repair for `install.sh` and `fireconnect upgrade`.
 *
 * Bootstrap stays separate (bash clone vs git reset). Everything state-sensitive
 * after the CLI bits are on disk goes through this path:
 *   1. ensure runtime npm deps
 *   2. re-probe secret storage / migrate plaintext → secure
 *   3. rebake enabled harness keys + websearch MCP Bearer + shell hook reconcile
 *
 * Never throws for rebake/shell failures (best-effort). Dep install and
 * key-storage probe may throw only if callers choose to surface them — this
 * wrapper keeps probe/rebake non-fatal for install.sh.
 *
 * @param {{
 *   home?: string,
 *   installDir?: string,
 *   setupDir?: string,
 *   log?: (...args: unknown[]) => void,
 *   ensureDeps?: typeof ensureCliDependencies,
 *   reprobe?: typeof reprobeKeyStorage,
 *   rebake?: typeof rebakeEnabledHarnessKeysOnUpgrade,
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
  rebake = rebakeEnabledHarnessKeysOnUpgrade,
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
      const rebakeNotes = await rebake(home);
      for (const note of rebakeNotes) {
        log(note);
        notes.push(note);
      }
    } catch {
      // Best-effort rebake.
    }
  }

  return { notes, migrated, setupDir: resolvedSetup };
}
