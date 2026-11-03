import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { writeMintedKeyState } from "../../lib/keys/mint-api-key.mjs";
import { runCli, runCliJson, seedKeychainConfig, withTempHome } from "../helpers.mjs";

const VALID_KEY = "fw_usage_data_test_key_000000000000";
const REJECTED_KEY = "fw_usage_data_rejected_key_0000000";
const EMAIL = "usage-data-person@example.com";
const ACCOUNT = "acct-usage-data-secret";
const USER = "user-usage-data-secret";
const USER_NAME = `accounts/${ACCOUNT}/users/${USER}`;
const SETTINGS_PATH = `/v1/${USER_NAME}/settings`;

/**
 * Fake gateway: GET /verifyApiKey, ListUsers by email, and GetUserSettings.
 * `mode` switches the settings endpoint between a server that knows
 * `share_nexus_analytics`, one that predates it (field never returned), and one
 * that rejects it outright.
 */
function startMockGateway() {
  const state = {
    /** @type {boolean|undefined} */
    shareNexusAnalytics: undefined,
    mode: "supported",
    /** @type {{ method: string, url: string, body: string }[]} */
    requests: [],
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      state.requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (key !== VALID_KEY) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (url.pathname === "/verifyApiKey") {
        res.writeHead(200, {
          "x-fireworks-account-id": ACCOUNT,
          "x-fireworks-developer-email": EMAIL,
        });
        res.end();
        return;
      }
      if (url.pathname === `/v1/accounts/${ACCOUNT}/users`) {
        const users = url.searchParams.get("filter") === `email="${EMAIL}"` ? [{ name: USER_NAME, email: EMAIL }] : [];
        json(200, { users });
        return;
      }
      if (url.pathname === SETTINGS_PATH && req.method === "GET") {
        if (state.mode === "rejects-field") {
          // The error names the whole resource, so the CLI must not echo it.
          json(400, { code: 3, message: `unknown field "share_nexus_analytics" in ${USER_NAME}/settings` });
          return;
        }
        json(200, {
          name: `${USER_NAME}/settings`,
          disableTraceContentCollection: false,
          ...(state.mode === "supported" && state.shareNexusAnalytics !== undefined
            ? { shareNexusAnalytics: state.shareNexusAnalytics }
            : {}),
        });
        return;
      }
      json(404, { code: 5, message: `${url.pathname} not found` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** No key, email or account/user ID may appear anywhere in the output. */
function assertNoIdentityLeak(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of [VALID_KEY, REJECTED_KEY, EMAIL, ACCOUNT, USER]) {
    assert.ok(!output.includes(secret), `output leaked ${secret}: ${output}`);
  }
}

describe("nexus usage-data", () => {
  let gateway;
  let env;

  before(async () => {
    gateway = await startMockGateway();
    env = { NEXUS_GATEWAY_URL: gateway.url, FIREWORKS_API_KEY: VALID_KEY };
  });

  beforeEach(() => {
    gateway.state.shareNexusAnalytics = undefined;
    gateway.state.mode = "supported";
    gateway.state.requests = [];
  });

  after(() => {
    gateway.server.close();
  });

  it("reports null when the user has never answered", async () => {
    await withTempHome("usage-data-unset-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCliJson(["usage-data", "--json"], { home, env });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.deepEqual(result.json, { ok: true, shareNexusAnalytics: null });
      assertNoIdentityLeak(result);
    });
  });

  it("reports the stored answer and prints one line without --json", async () => {
    await withTempHome("usage-data-answered-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      gateway.state.shareNexusAnalytics = true;
      const on = await runCliJson(["usage-data", "--json"], { home, env });
      assert.equal(on.code, 0, `stderr: ${on.stderr}`);
      assert.deepEqual(on.json, { ok: true, shareNexusAnalytics: true });
      const lookups = gateway.state.requests.map((r) => new URL(r.url, "http://localhost"));
      assert.deepEqual(lookups.map((u) => u.pathname), ["/verifyApiKey", `/v1/accounts/${ACCOUNT}/users`, SETTINGS_PATH]);
      assert.equal(lookups[1].searchParams.get("filter"), `email="${EMAIL}"`);
      assert.ok(gateway.state.requests.every((r) => r.method === "GET"), "usage-data must only read");

      gateway.state.shareNexusAnalytics = false;
      const off = await runCliJson(["usage-data", "--json"], { home, env });
      assert.deepEqual(off.json, { ok: true, shareNexusAnalytics: false });

      const human = await runCli(["usage-data"], { home, env });
      assert.equal(human.code, 0);
      assert.equal(human.stdout.trim(), "Sharing anonymous usage data: off");
      for (const result of [on, off, human]) {
        assertNoIdentityLeak(result);
      }
    });
  });

  it("reports null while the server doesn't know the field yet", async () => {
    await withTempHome("usage-data-old-server-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      gateway.state.shareNexusAnalytics = true;
      gateway.state.mode = "predates-field";
      const result = await runCliJson(["usage-data", "--json"], { home, env });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.deepEqual(result.json, { ok: true, shareNexusAnalytics: null });
    });
  });

  it("uses the user recorded by browser sign-in for the stored key", async () => {
    await withTempHome("usage-data-minted-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      await writeMintedKeyState(home, { keyId: "key-1", userName: USER_NAME, displayName: "nexus-test" });
      const result = await runCliJson(["usage-data", "--json"], {
        home,
        env: { NEXUS_GATEWAY_URL: gateway.url },
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.deepEqual(result.json, { ok: true, shareNexusAnalytics: null });
      assert.deepEqual(gateway.state.requests.map((r) => new URL(r.url, "http://localhost").pathname), [SETTINGS_PATH]);
    });
  });

  it("reports not-signed-in with no key", async () => {
    await withTempHome("usage-data-no-key-", async (home) => {
      const result = await runCliJson(["usage-data", "--json"], {
        home,
        env: { NEXUS_GATEWAY_URL: gateway.url },
      });
      assert.equal(result.code, 1);
      assert.equal(result.json.ok, false);
      assert.equal(result.json.code, "not-signed-in");
      assert.equal(typeof result.json.message, "string");
      assert.equal(gateway.state.requests.length, 0);
    });
  });

  it("reports unsupported when the server rejects the field", async () => {
    await withTempHome("usage-data-unsupported-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      gateway.state.mode = "rejects-field";
      const result = await runCliJson(["usage-data", "--json"], { home, env });
      assert.equal(result.code, 1);
      assert.equal(result.json.ok, false);
      assert.equal(result.json.code, "unsupported");
      assertNoIdentityLeak(result);
    });
  });

  it("reports forbidden for a rejected key", async () => {
    await withTempHome("usage-data-rejected-", async (home) => {
      await seedKeychainConfig(home, REJECTED_KEY);
      const result = await runCliJson(["usage-data", "--json"], {
        home,
        env: { NEXUS_GATEWAY_URL: gateway.url },
      });
      assert.equal(result.code, 1);
      assert.equal(result.json.code, "forbidden");
      assertNoIdentityLeak(result);
    });
  });

  it("reports network when Fireworks can't be reached", async () => {
    // A port that was just listening and is now closed refuses connections.
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((resolve) => closed.close(resolve));

    await withTempHome("usage-data-offline-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const json = await runCliJson(["usage-data", "--json"], {
        home,
        env: { NEXUS_GATEWAY_URL: deadUrl },
      });
      assert.equal(json.code, 1);
      assert.equal(json.json.ok, false);
      assert.equal(json.json.code, "network");
      assertNoIdentityLeak(json);

      const human = await runCli(["usage-data"], {
        home,
        env: { NEXUS_GATEWAY_URL: deadUrl },
      });
      assert.equal(human.code, 1);
      assert.equal(human.stdout, "");
      assert.match(human.stderr, /Couldn't reach Fireworks/);
    });
  });

  it("is read-only and hidden", async () => {
    await withTempHome("usage-data-hidden-", async (home) => {
      const write = await runCli(["usage-data", "on"], { home, env });
      assert.equal(write.code, 1);
      assert.match(write.stderr, /does not accept positional arguments/);
      assert.equal(gateway.state.requests.length, 0);

      for (const args of [["help"], ["--help"], ["help", "all"]]) {
        const help = await runCli(args, { home, env });
        assert.doesNotMatch(help.stdout, /usage-data/);
      }
      const typo = await runCli(["usage-dat"], { home, env });
      assert.doesNotMatch(typo.stderr, /usage-data/);
    });
  });
});
