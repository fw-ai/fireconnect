import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { runCli, seedKeychainConfig, withTempHome } from "./helpers.mjs";
import { pbDecode, pbStringAt } from "../lib/grpc-web.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../bin/fireconnect.mjs");

const VALID_KEY = "fw_login_test_key_000000000000000";
const REJECTED_KEY = "fw_login_rejected_key_00000000000";
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

/**
 * Mock of the control plane's gRPC-web surface, for logout's DeleteApiKey.
 * Captures auth header + decoded request fields; answers with the given
 * grpc-status in the trailers frame.
 */
function startMockGrpcGateway({ status = 0, detail = "" } = {}) {
  /** @type {{ method: string, apiKey: string, parent: string, keyId: string }[]} */
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const request = pbDecode(body.subarray(5)); // skip the 5-byte frame header
      calls.push({
        method: req.url?.split("/").at(-1) ?? "",
        apiKey: String(req.headers["x-api-key"] ?? ""),
        parent: pbStringAt(request, 1),
        keyId: pbStringAt(request, 2),
      });
      const trailer = Buffer.from(`grpc-status:${status}\r\ngrpc-message:${detail}\r\n`);
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(Buffer.concat([
        Buffer.from([0x00, 0, 0, 0, 0]), // empty message frame (Empty)
        Buffer.from([0x80]),
        (() => { const len = Buffer.alloc(4); len.writeUInt32BE(trailer.length); return len; })(),
        trailer,
      ]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/web/gateway.Gateway` });
    });
  });
}

const MINTED_STATE = {
  keyId: "key-123",
  userName: "accounts/acct-test/users/u-1",
  displayName: "fireconnect-testhost",
};

async function seedMintedState(home) {
  await mkdir(path.join(home, ".fireconnect"), { recursive: true });
  await writeFile(path.join(home, ".fireconnect", "minted-key.json"), JSON.stringify(MINTED_STATE));
}

/** Like helpers.runCli but with a writable stdin (for --with-token). */
function runCliWithStdin(args, { home, env = {}, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ...env,
        HOME: home,
        FIRECONNECT_SECRET_STORE: "memory",
        FIRECONNECT_TEST: "1",
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(input);
  });
}

describe("fireconnect login / logout", () => {
  let gateway;
  let gatewayEnv;

  before(async () => {
    gateway = await startMockGateway();
    gatewayEnv = { FIRECONNECT_GATEWAY_URL: gateway.url };
  });

  after(() => {
    gateway.server.close();
  });

  it("login --with-token validates, stores, and confirms identity", async () => {
    await withTempHome("login-with-token-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: `${VALID_KEY}\n`,
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));

      const exported = await runCli(["key", "export"], { home });
      assert.equal(exported.code, 0);
      assert.equal(exported.stdout.trim(), VALID_KEY);
    });
  });

  it("login --with-token rejects a wrong-shaped key without storing it", async () => {
    await withTempHome("login-token-shape-", async (home) => {
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: "sk-not-a-fireworks-key\n",
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /doesn't look like a Fireworks key/);
      assert.doesNotMatch(result.stderr, /Error:/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);
    });
  });

  it("login --with-token surfaces an API-rejected key without storing it", async () => {
    await withTempHome("login-token-rejected-", async (home) => {
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: `${REJECTED_KEY}\n`,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /That key didn't work/);
      assert.doesNotMatch(result.stderr, /Error:/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);
    });
  });

  it("login --api-key signs in non-interactively", async () => {
    await withTempHome("login-flag-key-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      const result = await runCli(["login", "--api-key", VALID_KEY], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));

      const exported = await runCli(["key", "export"], { home });
      assert.equal(exported.stdout.trim(), VALID_KEY);
    });
  });

  it("login short-circuits when already signed in and points at --force", async () => {
    await withTempHome("login-already-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);

      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Already signed in as ${EMAIL}`));
      assert.match(result.stdout, /fireconnect login --force/);
    });
  });

  it("login without a TTY points at --with-token instead of hanging", async () => {
    await withTempHome("login-no-tty-", async (home) => {
      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--with-token/);
      assert.doesNotMatch(result.stderr, /Error:/);
    });
  });

  it("logout clears stored credentials and confirms", async () => {
    await withTempHome("logout-", async (home) => {
      await mkdir(path.join(home, ".fireconnect"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);

      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Logged out/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);

      const check = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(check.code, 1);
    });
  });

  it("logout --revoke deletes the key this machine minted, then clears local state", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-revoke-", async (home) => {
        // Store first, then record the mint — the browser flow's order
        // (storing a key clears any previous machine's minted-key record).
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { FIRECONNECT_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.match(result.stdout, /Revoked .*fireconnect-testhost.* server-side/);

        assert.equal(grpc.calls.length, 1);
        assert.equal(grpc.calls[0].method, "DeleteApiKey");
        assert.equal(grpc.calls[0].apiKey, VALID_KEY, "auth must be x-api-key with the stored key");
        assert.equal(grpc.calls[0].parent, MINTED_STATE.userName);
        assert.equal(grpc.calls[0].keyId, MINTED_STATE.keyId);

        await assert.rejects(access(path.join(home, ".fireconnect", "minted-key.json")));
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout --revoke authenticates with the stored minted key, not a stray env key", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-revoke-env-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        // A different key exported in the shell must not authenticate the
        // deletion of the minted key — that would target the wrong principal.
        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { FIRECONNECT_GATEWAY_GRPC_WEB_URL: grpc.url, FIREWORKS_API_KEY: REJECTED_KEY },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.equal(grpc.calls.length, 1);
        assert.equal(grpc.calls[0].apiKey, VALID_KEY, "must authenticate with the stored minted key, not FIREWORKS_API_KEY");
        assert.equal(grpc.calls[0].keyId, MINTED_STATE.keyId);
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout without a TTY or --revoke leaves the minted key alone and says so", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-keep-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout"], {
          home,
          env: { FIRECONNECT_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.match(result.stdout, /Left .*fireconnect-testhost.* active/);
        assert.match(result.stdout, /api-keys/);
        assert.equal(grpc.calls.length, 0, "must not revoke without consent");
      });
    } finally {
      grpc.server.close();
    }
  });

  it("storing a different key invalidates the minted-key record", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-stale-mint-", async (home) => {
        // Browser sign-in minted a key on this machine…
        await seedMintedState(home);
        // …then the user stored a different key (paste / --api-key / key set).
        await seedKeychainConfig(home, VALID_KEY);

        // logout must not describe or try to revoke the old minted key on
        // behalf of a credential it no longer holds.
        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { FIRECONNECT_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.doesNotMatch(result.stdout, /fireconnect-testhost/);
        assert.equal(grpc.calls.length, 0, "no revocation for a key another credential minted");
        await assert.rejects(access(path.join(home, ".fireconnect", "minted-key.json")));
      });
    } finally {
      grpc.server.close();
    }
  });

  it("re-storing the same minted key keeps the revoke record", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-same-key-mint-", async (home) => {
        // Browser sign-in minted VALID_KEY and recorded the mint.
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        // An idempotent re-store of the SAME key (config repair, a repeated
        // sign-in) must NOT wipe minted-key.json — the key is still the one
        // this machine minted and should stay revocable.
        await seedKeychainConfig(home, VALID_KEY);
        await assert.doesNotReject(access(path.join(home, ".fireconnect", "minted-key.json")));

        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { FIRECONNECT_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Revoked .*fireconnect-testhost.* server-side/);
        assert.equal(grpc.calls.length, 1);
        assert.equal(grpc.calls[0].keyId, MINTED_STATE.keyId);
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout still completes when revocation is refused, and says so", async () => {
    const grpc = await startMockGrpcGateway({ status: 7, detail: "permission denied" });
    try {
      await withTempHome("logout-revoke-denied-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { FIRECONNECT_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.match(result.stdout, /Couldn't revoke/);
        assert.match(result.stdout, /permission denied/);
        assert.match(result.stdout, /api-keys/); // points at the console to finish the job

        const check = await runCli(["status"], { home, env: gatewayEnv });
        assert.equal(check.code, 1); // local credentials are gone regardless
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout with nothing stored says so and exits 0", async () => {
    await withTempHome("logout-none-", async (home) => {
      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Not signed in/);
    });
  });

  it("logout notes a lingering FIREWORKS_API_KEY env var", async () => {
    await withTempHome("logout-env-note-", async (home) => {
      const result = await runCli(["logout"], { home, env: { FIREWORKS_API_KEY: VALID_KEY } });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /FIREWORKS_API_KEY is still set/);
    });
  });

  // promptSignInMethod is TTY-only in real use; drive it through a subprocess
  // with piped stdin (same pattern as read-secret.test.mjs).
  function runMethodPrompt(input) {
    const loginPath = path.join(__dirname, "../lib/commands/login.mjs");
    const script = `
      import { promptSignInMethod } from ${JSON.stringify(loginPath)};
      const method = await promptSignInMethod();
      process.stdout.write("RESULT:" + JSON.stringify(method));
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  function parseMethod(stdout) {
    const marker = stdout.lastIndexOf("RESULT:");
    assert.notEqual(marker, -1, stdout);
    return JSON.parse(stdout.slice(marker + "RESULT:".length));
  }

  describe("promptSignInMethod", () => {
    it("offers create-a-key and paste, defaulting to create (browser) on Enter", async () => {
      const result = await runMethodPrompt("\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /needs a Fireworks API key for this machine/);
      assert.match(result.stdout, /fireconnect logout/);
      assert.match(result.stdout, /Create one for me/);
      assert.match(result.stdout, /already have a key/);
      assert.equal(parseMethod(result.stdout), "browser");
    });

    it("returns paste for choice 2", async () => {
      const result = await runMethodPrompt("2\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(parseMethod(result.stdout), "paste");
    });

    it("re-asks on invalid input, and q cancels", async () => {
      const result = await runMethodPrompt("banana\nq\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Enter 1 or 2/);
      assert.equal(parseMethod(result.stdout), null);
    });
  });

  describe("promptAccountChoice", () => {
    // When browser sign-in resolves to several accounts, the user must pick
    // which one the key belongs to — same TTY-only subprocess pattern as
    // promptSignInMethod.
    function runAccountPrompt(accountNames, input) {
      const loginPath = path.join(__dirname, "../lib/commands/login.mjs");
      const script = `
        import { promptAccountChoice } from ${JSON.stringify(loginPath)};
        const idx = await promptAccountChoice(${JSON.stringify(accountNames)});
        process.stdout.write("RESULT:" + JSON.stringify(idx));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    }

    const accounts = ["accounts/acme", "accounts/personal"];

    it("lists the accounts and defaults to the first on Enter", async () => {
      const result = await runAccountPrompt(accounts, "\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /more than one Fireworks account/);
      assert.match(result.stdout, /acme/);
      assert.match(result.stdout, /personal/);
      assert.equal(parseMethod(result.stdout), 0);
    });

    it("returns the chosen index for a number", async () => {
      const result = await runAccountPrompt(accounts, "2\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(parseMethod(result.stdout), 1);
    });

    it("re-asks on invalid input, and q cancels", async () => {
      const result = await runAccountPrompt(accounts, "banana\nq\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Enter 1 to 2, or q to cancel/);
      assert.equal(parseMethod(result.stdout), null);
    });
  });

  describe("promptYesNo", () => {
    function runYesNo(input) {
      const loginPath = path.join(__dirname, "../lib/commands/login.mjs");
      const script = `
        import { promptYesNo } from ${JSON.stringify(loginPath)};
        const answer = await promptYesNo("Proceed?");
        process.stdout.write("RESULT:" + JSON.stringify(answer));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
        child.stdin.end(input);
      });
    }

    it("Enter means yes", async () => {
      const result = await runYesNo("\n");
      assert.equal(parseMethod(result.stdout), true);
    });

    it("n means no; invalid input re-asks; EOF means no", async () => {
      assert.equal(parseMethod((await runYesNo("n\n")).stdout), false);
      const reasked = await runYesNo("maybe\nyes\n");
      assert.match(reasked.stdout, /Enter y or n/);
      assert.equal(parseMethod(reasked.stdout), true);
      assert.equal(parseMethod((await runYesNo("")).stdout), false);
    });
  });

  it("help lists login and logout", async () => {
    await withTempHome("login-help-", async (home) => {
      const help = await runCli(["help"], { home });
      assert.match(help.stdout, /login\s+Sign in to Fireworks/);
      assert.match(help.stdout, /logout\s+Clear stored Fireworks credentials/);

      const topic = await runCli(["help", "login"], { home });
      assert.match(topic.stdout, /--with-token/);
      assert.match(topic.stdout, /--force/);
      assert.match(topic.stdout, /--paste/);
    });
  });
});
