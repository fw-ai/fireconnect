import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aesDecrypt,
  aesEncrypt,
  decryptSecret,
  encryptSecret,
} from "../lib/vscode-safestorage.mjs";

/* -------------------------------------------------------------------------- */
/* OSCrypt cipher wiring (macOS v10 / Linux v10/v11). Deterministic — uses a   */
/* fixed password, so it proves the PBKDF2 + AES-128-CBC + IV + version-prefix */
/* layering is correct and reversible without touching the OS keychain.        */
/* -------------------------------------------------------------------------- */

describe("vscode-safestorage OSCrypt cipher", () => {
  it("round-trips a value through aesEncrypt/aesDecrypt", () => {
    const pw = "peanuts"; // Chromium's Linux basic-backend password
    const blob = aesEncrypt("fw_secret_value_123", pw, "v10");
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v10");
    assert.equal(aesDecrypt(blob, pw), "fw_secret_value_123");
  });

  it("ciphertext is salted/padded, not the plaintext", () => {
    const blob = aesEncrypt("hello", "peanuts", "v11");
    assert.equal(blob.subarray(0, 3).toString("latin1"), "v11");
    assert.ok(!blob.subarray(3).toString("latin1").includes("hello"));
    // AES-CBC with PKCS7 always pads to a full 16-byte block.
    assert.equal((blob.length - 3) % 16, 0);
  });

  it("a wrong password fails to decrypt (does not silently return junk equal to input)", () => {
    const blob = aesEncrypt("topsecret", "peanuts", "v10");
    let decrypted;
    try {
      decrypted = aesDecrypt(blob, "wrongpassword");
    } catch {
      decrypted = undefined; // padding error — acceptable
    }
    assert.notEqual(decrypted, "topsecret");
  });
});

/* -------------------------------------------------------------------------- */
/* Plaintext test seam (FIRECONNECT_VSCODE_SECRET_PLAINTEXT) used by the        */
/* harness integration tests.                                                  */
/* -------------------------------------------------------------------------- */

describe("vscode-safestorage plaintext seam", () => {
  it("encrypt/decrypt are the identity when the seam is set", () => {
    const prev = process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT;
    process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT = "1";
    try {
      assert.equal(encryptSecret("fw_abc"), "fw_abc");
      assert.equal(decryptSecret("fw_abc"), "fw_abc");
    } finally {
      if (prev === undefined) {
        delete process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT;
      } else {
        process.env.FIRECONNECT_VSCODE_SECRET_PLAINTEXT = prev;
      }
    }
  });

  it("decryptSecret returns '' for empty/garbage input", () => {
    assert.equal(decryptSecret(""), "");
    assert.equal(decryptSecret("not-json-and-not-plaintext-mode"), "");
  });
});
