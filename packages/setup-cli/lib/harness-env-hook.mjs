import {
  syncShellEnvHookForHarnessOff,
  syncShellEnvHookForHarnessOn,
} from "./shell-env-hook.mjs";
import { verifyKeyExportWorks, printKeySelfCheckWarning } from "./key-selfcheck.mjs";

/**
 * @param {string} home
 * @param {{ harnessId?: string, expectedKey?: string }} [options]
 */
export async function finishEnvHarnessOn(home, options = {}) {
  const shellConfig = await syncShellEnvHookForHarnessOn(home);
  if (shellConfig) {
    console.log(`Installed shell env hook in ${shellConfig}.`);
    console.log(`Open a new terminal or run: source ${shellConfig}`);
  }

  // Best-effort: confirm the shell hook will actually be able to load the key
  // in a fresh shell (where FIREWORKS_API_KEY is not yet set). Non-fatal.
  // Skipped in test context to avoid subprocess overhead/flakiness in CI; the
  // self-check is exercised directly in test/secret-backend.test.mjs.
  const harnessId = options.harnessId ?? "this harness";
  const isTestContext = process.env.NODE_ENV === "test" || process.env.FIRECONNECT_TEST === "1";
  if (!isTestContext) {
    try {
      const result = await verifyKeyExportWorks(home, { expectedKey: options.expectedKey });
      if (!result.ok) {
        printKeySelfCheckWarning(harnessId, result.reason ?? "unknown reason");
      }
    } catch (error) {
      printKeySelfCheckWarning(harnessId, error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * @param {string} home
 */
export async function finishEnvHarnessOff(home) {
  await syncShellEnvHookForHarnessOff(home);
}
