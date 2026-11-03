import assert from "node:assert/strict";
import { it } from "node:test";
import { withTempHome } from "../helpers.mjs";
import { readGlobalConfig } from "../../lib/config/global-config.mjs";
import { persistApiKeyToKeychain, keysUrlForHome, NEXUS_KEYS_URL, FIREWORKS_KEYS_URL } from "../../lib/keys/api-key.mjs";
import { readMintedKeyState, writeMintedKeyState } from "../../lib/keys/mint-api-key.mjs";
import { storeApiKey } from "../../lib/auth/login/output.mjs";

it("credential replacement never inherits kind; idempotent config repair retains kind and minted state", async () => {
  await withTempHome("account-metadata-", async (home) => {
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const key = "fw_metadata_test_00000000000000000";
      await storeApiKey(home, key, "nexus");
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      await writeMintedKeyState(home, { keyId: "minted-1", userName: "accounts/test/users/test", displayName: "test" });
      await persistApiKeyToKeychain(home, key);
      assert.equal((await readGlobalConfig(home)).nexusAccount, true);
      assert.equal((await readMintedKeyState(home)).keyId, "minted-1");
      // Explicit same-key metadata updates, unlike incidental config repair.
      await storeApiKey(home, key, "platform");
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
      assert.equal((await readMintedKeyState(home)).keyId, "minted-1");
      await storeApiKey(home, key, "nexus");
      await persistApiKeyToKeychain(home, "fw_metadata_replacement_000000000000");
      assert.equal((await readGlobalConfig(home)).nexusAccount, false);
      assert.equal(await readMintedKeyState(home), null);
      await storeApiKey(home, key, "nexus");
      await storeApiKey(home, key); // omitted login metadata is explicitly unknown
      assert.equal((await readGlobalConfig(home)).nexusAccount, false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
