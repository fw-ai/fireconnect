import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KEYRING_OP_TIMEOUT_MS, KeyringTimeoutError, withKeyringTimeout } from "../../lib/keys/keyring-timeout.mjs";

describe("withKeyringTimeout", () => {
  it("returns when the operation finishes in time", async () => {
    const value = await withKeyringTimeout(Promise.resolve("ok"), "test-op");
    assert.equal(value, "ok");
  });

  it("rejects with KeyringTimeoutError when the operation exceeds the timeout", async () => {
    const slow = new Promise(() => {});
    await assert.rejects(
      () => withKeyringTimeout(slow, "hanging-setPassword"),
      (error) => {
        assert.ok(error instanceof KeyringTimeoutError);
        assert.equal(error.name, "KeyringTimeoutError");
        assert.match(error.message, /timed out after \d+ms \(hanging-setPassword\)/);
        assert.ok(error.message.includes(String(KEYRING_OP_TIMEOUT_MS)));
        return true;
      },
    );
  });
});
