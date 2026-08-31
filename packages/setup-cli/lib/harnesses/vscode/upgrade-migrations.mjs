import {
  chatLanguageModelsPath,
  findFireconnectProvider,
  isVscodeRunning,
  readChatLanguageModels,
  writeChatLanguageModels,
} from "./core.mjs";

/**
 * Flip the fireconnect-owned provider's `apiType` from `"responses"` to
 * `"chat-completions"` — the upgrade migration for installs configured when
 * direct Fireworks routing used the Responses wire. No-ops (returns `false`)
 * when there is no fireconnect provider, when it is already chat-completions
 * (Azure included), or when VS Code is running (its exit rewrite would
 * discard the edit). The secret store is untouched — the `apiKey` reference
 * and the `state.vscdb` row stay as they are.
 *
 * `isRunning` is injectable so the guard is unit-testable without a real IDE.
 * @param {string} home
 * @param {{ vscodePath?: string, isRunning?: () => boolean }} [options]
 * @returns {Promise<boolean>} whether the file was rewritten
 */
export async function migrateVscodeResponsesApiType(home, {
  vscodePath = "",
  isRunning = isVscodeRunning,
} = {}) {
  const jsonPath = vscodePath || chatLanguageModelsPath({ home });
  const arr = await readChatLanguageModels(jsonPath);
  const provider = findFireconnectProvider(arr);
  if (!provider || provider.apiType !== "responses") {
    return false;
  }
  if (isRunning()) {
    return false;
  }
  await writeChatLanguageModels(
    jsonPath,
    arr.map((p) => (p === provider ? { ...p, apiType: "chat-completions" } : p)),
  );
  return true;
}
