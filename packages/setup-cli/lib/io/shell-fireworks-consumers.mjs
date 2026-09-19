/**
 * Whether the shell hook should export FIREWORKS_API_KEY.
 *
 * Harness configs use baked literals; upgrade rebakes any legacy env-reference
 * files on disk. Kept as an extension point if a future consumer needs export.
 *
 * @param {string} home
 * @param {import("../config/global-config.mjs").HarnessConfigMap} _harnesses
 * @param {boolean} installShellHook
 */
export async function needsFireworksShellExport(home, _harnesses, installShellHook) {
  void home;
  void _harnesses;
  void installShellHook;
  return false;
}
