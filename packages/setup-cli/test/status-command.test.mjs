import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runCli, seedKeychainConfig, withTempHome } from "./helpers.mjs";

const VALID_KEY = "fw_status_test_key_0000000000000000";
const REJECTED_KEY = "fw_status_rejected_key_0000000000";
const EMAIL = "dev@example.com";
const ACCOUNT = "acct-test";

/** Mock of the gateway's GET /verifyApiKey: identity headers on 200, 401 otherwise. */
function startMockGateway() {
  const server = createServer((req, res) => {
    if (req.url !== "/verifyApiKey") {
      res.writeHead(404);
      res.end();
      return;
    }
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (key === VALID_KEY) {
      res.writeHead(200, {
        "x-fireworks-account-id": ACCOUNT,
        "x-fireworks-developer-email": EMAIL,
      });
    } else {
      res.writeHead(401);
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe("fireconnect status", () => {
  let gateway;
  let gatewayEnv;

  before(async () => {
    gateway = await startMockGateway();
    gatewayEnv = { FIRECONNECT_GATEWAY_URL: gateway.url };
  });

  after(() => {
    gateway.server.close();
  });

  it("reports not signed in with no key (exit 1) and still shows storage", async () => {
    await withTempHome("status-none-", async (home) => {
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Not signed in/);
      assert.match(result.stdout, /fireconnect login/);
      // The storage report renders regardless of auth state.
      assert.match(result.stdout, /Config ref:/);
      assert.match(result.stdout, /Per harness/);
    });
  });

  it("reports identity for a valid env key (exit 0)", async () => {
    await withTempHome("status-env-", async (home) => {
      const result = await runCli(["status"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));
    });
  });

  it("reports identity for a valid stored key (exit 0)", async () => {
    await withTempHome("status-stored-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));
      assert.match(result.stdout, /Key stored: yes/);
    });
  });

  it("flags a rejected stored key and points at --force (exit 1)", async () => {
    await withTempHome("status-stored-rejected-", async (home) => {
      await seedKeychainConfig(home, REJECTED_KEY);
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /rejected/);
      assert.match(result.stdout, /login --force/);
    });
  });

  it("flags a rejected FIREWORKS_API_KEY without pointing at --force (exit 1)", async () => {
    await withTempHome("status-env-rejected-", async (home) => {
      const result = await runCli(["status"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: REJECTED_KEY },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /rejected/i);
      assert.match(result.stdout, /FIREWORKS_API_KEY/);
      assert.doesNotMatch(result.stdout, /--force/);
    });
  });

  it("stays exit 0 when a key is present but the gateway is unreachable", async () => {
    await withTempHome("status-unreachable-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["status"], {
        home,
        env: { FIRECONNECT_GATEWAY_URL: "http://127.0.0.1:1" },
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /couldn't be reached/i);
    });
  });

  it("--json emits an auth block plus the storage summary", async () => {
    await withTempHome("status-json-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["status", "--json"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.auth.signedIn, true);
      assert.equal(summary.auth.email, EMAIL);
      assert.equal(summary.keychainPresent, true);
      assert.ok(Array.isArray(summary.perHarness));
    });
  });

  it("help lists status and has a status topic", async () => {
    await withTempHome("status-help-", async (home) => {
      const help = await runCli(["help"], { home });
      assert.match(help.stdout, /status\s+Show sign-in state/);
      const topic = await runCli(["help", "status"], { home });
      assert.match(topic.stdout, /--json/);
    });
  });
});
