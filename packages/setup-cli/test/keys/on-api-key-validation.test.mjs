import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runFireconnect, seedKeychainConfig, withTempHome, writeCodexConfig } from "../helpers.mjs";
import { USER_SETTINGS_RELATIVE_PATH } from "../../lib/harnesses/claude/core.mjs";

const VALID_KEY = "fw_on_validation_valid_0000000000";
const REJECTED_KEY = "fw_on_validation_rejected_0000000";

/** GET /verifyApiKey mock: 200 (+ identity) for VALID_KEY, 401 otherwise. */
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
        "x-fireworks-developer-email": "dev@example.com",
        "x-fireworks-account-id": "acct-test",
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

async function fileExists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

describe("credential entry via login --api-key", () => {
  it("rejects <harness> on --api-key and points at login", async () => {
    await withTempHome("on-validate-flag-gone-", async (home) => {
      for (const args of [
        ["claude", "on", "--api-key", VALID_KEY],
        ["claude", "--api-key", VALID_KEY],
      ]) {
        const result = await runFireconnect(args, {
          HOME: home,
          FIREWORKS_API_KEY: "",
          NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
        });
        assert.notEqual(result.code, 0, `${args.join(" ")} should fail`);
        assert.match(result.stderr, /isn't a .* on option/);
        assert.match(result.stderr, /nexus login/);
      }
      assert.equal(await fileExists(path.join(home, ".nexus", ".secret-memory")), false);
      assert.equal(await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)), false);
    });
  });

  it("stores the login --api-key flag key even when FIREWORKS_API_KEY is set", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-env-conflict-", async (home) => {
        // env is not a credential source: it can't conflict with the flag.
        const result = await runFireconnect(
          ["login", "--api-key", VALID_KEY],
          {
            HOME: home,
            FIREWORKS_API_KEY: "fw_env_is_ignored_000000",
            NEXUS_GATEWAY_URL: url,
          },
        );
        assert.equal(result.code, 0, result.stderr);
      });
    } finally {
      server.close();
    }
  });

  it("ignores an env-only key for `on`: fails with login guidance", async () => {
    await withTempHome("on-validate-env-only-", async (home) => {
      const result = await runFireconnect(
        ["codex", "on"],
        {
          HOME: home,
          FIREWORKS_API_KEY: VALID_KEY,
          NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
        },
      );
      // env is not a credential source: without a stored key `on` fails and
      // nothing is written.
      assert.notEqual(result.code, 0, "env-only key must not satisfy `on`");
      assert.match(result.stderr, /No Fireworks API key found/);
      assert.match(result.stderr, /nexus login/);
      assert.equal(await fileExists(path.join(home, ".nexus", ".secret-memory")), false);
      assert.equal(await fileExists(path.join(home, ".codex", "config.toml")), false);
    });
  });

  it("ignores a malformed env key without a network request", async () => {
    await withTempHome("on-validate-env-shape-", async (home) => {
      const result = await runFireconnect(
        ["claude", "on", "--non-interactive"],
        {
          HOME: home,
          FIREWORKS_API_KEY: "not-a-fireworks-key",
          NEXUS_GATEWAY_URL: "http://127.0.0.1:1",
        },
      );
      // The env value is never even read: missing-key, not a shape error.
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No Fireworks API key found/);
      assert.equal(await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)), false);
    });
  });

  it("rejects a malformed key on shape before any network call", async () => {
    await withTempHome("on-validate-shape-", async (home) => {
      // Point verify at an unreachable port to prove the shape check short-circuits.
      const env = { HOME: home, NEXUS_GATEWAY_URL: "http://127.0.0.1:1" };
      const result = await runFireconnect(["login", "--api-key", "not-a-fireworks-key"], env);
      assert.notEqual(result.code, 0, "malformed --api-key must fail");
      assert.match(result.stderr, /doesn't look like a Fireworks key/i);
      assert.equal(
        await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)),
        false,
        "a rejected key must not be baked into the harness config",
      );
    });
  });

  it("rejects a well-shaped but unverifiable key (gateway 401)", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-reject-", async (home) => {
        const env = { HOME: home, NEXUS_GATEWAY_URL: url };
        const login = await runFireconnect(["login", "--api-key", REJECTED_KEY], env);
        assert.notEqual(login.code, 0, "a gateway-rejected --api-key must fail");
        assert.match(login.stderr, /didn't work/i);
        // Nothing stored: `on` must not proceed on a rejected key.
        const result = await runFireconnect(["claude", "on"], env);
        assert.notEqual(result.code, 0);
        assert.equal(
          await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)),
          false,
          "a rejected key must not be baked into the harness config",
        );
      });
    } finally {
      server.close();
    }
  });

  it("refuses to bake a saved key the gateway rejects", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-saved-reject-", async (home) => {
        await seedKeychainConfig(home, REJECTED_KEY);
        const result = await runFireconnect(
          ["claude", "on"],
          { HOME: home, NEXUS_GATEWAY_URL: url },
        );
        assert.notEqual(result.code, 0, "a gateway-rejected saved key must fail");
        assert.match(result.stderr, /rejected your saved Fireworks key/);
        assert.match(result.stderr, /nexus login/);
        assert.equal(
          await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)),
          false,
          "a rejected key must not be baked into the harness config",
        );
      });
    } finally {
      server.close();
    }
  });

  it("refuses to bake a saved key the gateway rejects (claude-desktop)", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-desktop-reject-", async (home) => {
        await seedKeychainConfig(home, REJECTED_KEY);
        const result = await runFireconnect(
          ["claude-desktop", "on"],
          { HOME: home, NEXUS_GATEWAY_URL: url },
        );
        assert.notEqual(result.code, 0, "a gateway-rejected saved key must fail");
        assert.match(result.stderr, /rejected your saved Fireworks key/);
        assert.match(result.stderr, /nexus login/);
        assert.equal(
          await fileExists(path.join(home, ".nexus", "claude-desktop")),
          false,
          "a rejected key must not start the profile lane or write its state",
        );
      });
    } finally {
      server.close();
    }
  });

  it("an env key is never baked: `on` uses only the stored key", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-env-reject-", async (home) => {
        const result = await runFireconnect(
          ["codex", "on"],
          { HOME: home, FIREWORKS_API_KEY: REJECTED_KEY, NEXUS_GATEWAY_URL: url },
        );
        assert.notEqual(result.code, 0, "env must not satisfy `on`");
        assert.match(result.stderr, /No Fireworks API key found/);
        assert.equal(await fileExists(path.join(home, ".codex", "config.toml")), false);
      });
    } finally {
      server.close();
    }
  });

  it("an env key never shadows a working saved key", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-env-nopersist-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        // Even a gateway-dead env value is ignored: the stored key wins.
        const result = await runFireconnect(
          ["codex", "on"],
          { HOME: home, FIREWORKS_API_KEY: REJECTED_KEY, NEXUS_GATEWAY_URL: url },
        );
        assert.equal(result.code, 0, result.stderr);
      });
    } finally {
      server.close();
    }
  });

  it("refuses to promote a rejected harness-local literal into shared storage", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-local-reject-", async (home) => {
        // An older `on` left a dead literal baked in codex's own config — the
        // migration path would promote it to the shared keychain and re-bake
        // it into every enabled harness before resolveOnKey's check fires.
        await writeCodexConfig(home, { apiKey: REJECTED_KEY });
        const result = await runFireconnect(
          ["codex", "on"],
          { HOME: home, NEXUS_GATEWAY_URL: url },
        );
        assert.notEqual(result.code, 0, "a gateway-rejected harness-local key must fail");
        assert.match(result.stderr, /rejected your saved Fireworks key/);
        assert.equal(
          await fileExists(path.join(home, ".nexus", ".secret-memory")),
          false,
          "the rejected literal must not be promoted into the shared keychain",
        );
        // The shared credential stayed empty: a saved working key succeeds.
        await seedKeychainConfig(home, VALID_KEY);
        const retried = await runFireconnect(
          ["codex", "on"],
          { HOME: home, NEXUS_GATEWAY_URL: url },
        );
        assert.equal(retried.code, 0, retried.stderr);
      });
    } finally {
      server.close();
    }
  });

  it("enables the harness with a saved key the gateway accepts", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-saved-accept-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        const result = await runFireconnect(
          ["claude", "on"],
          { HOME: home, NEXUS_GATEWAY_URL: url },
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)), true);
      });
    } finally {
      server.close();
    }
  });

  it("accepts a verified key and enables the harness", async () => {
    const { server, url } = await startMockGateway();
    try {
      await withTempHome("on-validate-accept-", async (home) => {
        const env = { HOME: home, NEXUS_GATEWAY_URL: url };
        const login = await runFireconnect(["login", "--api-key", VALID_KEY], env);
        assert.equal(login.code, 0, login.stderr);
        const result = await runFireconnect(["claude", "on"], env);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(
          await fileExists(path.join(home, USER_SETTINGS_RELATIVE_PATH)),
          true,
          "a verified key enables the harness",
        );
      });
    } finally {
      server.close();
    }
  });
});
