import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSecretFallbackHandlers } from "../../lib/keys/secret-fallbacks.mjs";

function makeDeps(overrides = {}) {
  return {
    resolveHome: (home) => home ?? "/tmp/home",
    withHomeScopedEnv: async (_home, fn) => fn(),
    persistKeyStorageCache: async () => {},
    clearKeyStorageCache: async () => {},
    deleteSecretFromSecureBackend: async () => {},
    primeSecureReadCache: () => {},
    clearLastReadError: () => {},
    secretService: "svc",
    secretAccount: "acct",
    ...overrides,
  };
}

describe("createSecretFallbackHandlers", () => {
  it("storeSecretWithFallbacks uses secure storage when it succeeds", async () => {
    const calls = [];
    const { storeSecretWithFallbacks } = createSecretFallbackHandlers(makeDeps());
    const outcome = await storeSecretWithFallbacks("fw_key", "/tmp/home", async () => {
      calls.push("secure");
    });
    assert.equal(outcome, "secure");
    assert.deepEqual(calls, ["secure"]);
  });
});
