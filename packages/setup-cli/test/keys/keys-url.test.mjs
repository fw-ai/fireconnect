import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import {
  FIREWORKS_KEYS_URL,
  NEXUS_KEYS_URL,
  keysUrlFor,
  keysUrlForHome,
  verifyFailureLine,
} from "../../lib/keys/api-key.mjs";

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "nexus-keys-url-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("API-keys link by account kind", () => {
  it("sends Nexus accounts to the Nexus site and everyone else to the Platform", () => {
    assert.equal(NEXUS_KEYS_URL, "https://nexus.fireworks.ai/settings/api-keys");
    assert.equal(keysUrlFor(true), NEXUS_KEYS_URL);
    assert.equal(keysUrlFor(false), FIREWORKS_KEYS_URL);
    assert.equal(keysUrlFor(undefined), FIREWORKS_KEYS_URL);
  });

  it("follows the account kind saved in config, Platform when unset or unreadable", async () => {
    await withTempHome(async (home) => {
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
      await writeGlobalConfig(home, { nexusAccount: true });
      assert.equal((await readGlobalConfig(home)).nexusAccount, true);
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      // Other writes keep it.
      await writeGlobalConfig(home, { ssoAccountId: "example-account" });
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      await writeGlobalConfig(home, { nexusAccount: false });
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
      // Only a literal true counts.
      const configPath = path.join(home, ".nexus", "config.json");
      await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, "utf8")), nexusAccount: "yes" }));
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
      await writeFile(configPath, "{not json");
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
    });
  });

  it("puts the chosen link in the rejected-key line", () => {
    const rejected = { ok: false, reason: "rejected" };
    assert.match(verifyFailureLine(rejected), /app\.fireworks\.ai\/settings\/users\/api-keys/);
    assert.match(verifyFailureLine(rejected, { keysUrl: NEXUS_KEYS_URL }), /nexus\.fireworks\.ai\/settings\/api-keys/);
  });
});
