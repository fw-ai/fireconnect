import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import os from "node:os";
import { withTempHome } from "../helpers.mjs";
import { runInteractiveSignIn } from "../../lib/auth/login/flows.mjs";
import { resetSecretStoreForTests } from "../../lib/keys/secret-store.mjs";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import { grpcWebCall, pbDecode, pbField, pbString, pbStringAt } from "../../lib/auth/grpc-web.mjs";
import { defaultReturnTo, jwtClaims, signInViaDeviceFlow, signInViaLocalhostCallback, trustedVerificationUrl } from "../../lib/auth/browser-auth.mjs";
import { listAccountsForIdToken, mintApiKeyForAccount, mintApiKeyFromIdToken, mintedKeyName, readMintedKeyState } from "../../lib/keys/mint-api-key.mjs";

const EMAIL = "dev@example.com";

/** A structurally valid, unsigned JWT — the CLI only ever decodes the payload. */
function fakeJwt(claims) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}
const ID_TOKEN = fakeJwt({ email: EMAIL, exp: 9999999999 });

/** @param {(req, res, body: Buffer) => void} handle */
function startServer(handle) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Frame a protobuf message (+ OK trailers) the way a gRPC-web server does. */
function grpcWebFrames(message, { status = 0, detail = "" } = {}) {
  const frame = (flag, payload) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const trailers = Buffer.from(`grpc-status: ${status}\r\n${detail ? `grpc-message: ${encodeURIComponent(detail)}\r\n` : ""}`);
  return message === null
    ? frame(0x80, trailers)
    : Buffer.concat([frame(0, message), frame(0x80, trailers)]);
}

describe("grpc-web codec", () => {
  it("round-trips strings and nested messages", () => {
    const message = Buffer.concat([
      pbString(1, "accounts/test"),
      pbField(2, pbString(2, "nexus-host")),
    ]);
    const fields = pbDecode(message);
    assert.equal(pbStringAt(fields, 1), "accounts/test");
    const nested = pbDecode(fields.get(2)[0]);
    assert.equal(pbStringAt(nested, 2), "nexus-host");
  });

  it("decodes varint fields and skips them cleanly", () => {
    // field 3, wire type 0 (varint 300) followed by a string field
    const message = Buffer.concat([Buffer.from([0x18, 0xac, 0x02]), pbString(1, "x")]);
    assert.equal(pbStringAt(pbDecode(message), 1), "x");
  });

  it("parses message + trailer frames and percent-decoded errors", async () => {
    const { server, url } = await startServer((req, res, body) => {
      // echo the request message back if authorized, else a trailer-only error
      const authed = req.headers.authorization === "bearer good-token";
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      if (!authed) {
        res.end(frameError());
        return;
      }
      res.end(grpcWebFrames(body.subarray(5)));
    });
    function frameError() {
      const trailers = Buffer.from("grpc-status: 16\r\ngrpc-message: bad%20token\r\n");
      const head = Buffer.alloc(5);
      head[0] = 0x80;
      head.writeUInt32BE(trailers.length, 1);
      return Buffer.concat([head, trailers]);
    }

    const ok = await grpcWebCall(url, "Echo", pbString(1, "hello"), "good-token");
    assert.equal(ok.status, 0);
    assert.equal(pbStringAt(pbDecode(ok.message), 1), "hello");

    const denied = await grpcWebCall(url, "Echo", pbString(1, "hello"), "bad");
    assert.equal(denied.status, 16);
    assert.equal(denied.detail, "bad token");
    assert.equal(denied.message, null);

    server.close();
  });
});

describe("device flow", () => {
  const noSleep = () => Promise.resolve();

  /** Device-auth mock whose poll responses follow a script. */
  function startDeviceService(pollScript, { verificationUri, userCode = "ABCD-1234" } = {}) {
    let polls = 0;
    return startServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("grant_type")) {
        const step = pollScript[Math.min(polls, pollScript.length - 1)];
        polls += 1;
        res.writeHead(step.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(step.body));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        device_code: "dev-code",
        user_code: userCode,
        verification_uri: verificationUri ?? `http://${req.headers.host}/device`,
        verification_uri_complete: verificationUri ?? `http://${req.headers.host}/device?code=ABCD-1234`,
        interval: 1,
        expires_in: 300,
      }));
    });
  }

  it("polls through pending and slow_down to tokens", async () => {
    const { server, url } = await startDeviceService([
      { ok: false, body: { error: "authorization_pending" } },
      { ok: false, body: { error: "slow_down" } },
      { ok: true, body: { id_token: ID_TOKEN, refresh_token: "r", expires_in: 3600 } },
    ]);
    const lines = [];
    const result = await signInViaDeviceFlow({
      serviceUrl: url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      sleep: noSleep,
    });
    assert.equal(result.ok, true);
    assert.equal(result.email, EMAIL);
    assert.ok(lines.some((l) => l.includes("ABCD-1234")), "shows the one-time code");
    server.close();
  });

  it("refuses a verification link off the service host and strips escapes from the code", async () => {
    for (const verificationUri of ["https://elsewhere.example/device", "file:///etc/passwd", "not a url"]) {
      const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }], { verificationUri });
      const opened = [];
      const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep, onStatus: (l) => opened.push(l) });
      assert.equal(result.ok, false);
      assert.match(result.failure, /unexpected verification link/);
      assert.deepEqual(opened, []);
      server.close();
    }
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }], { userCode: "AB\u001b[2JCD" });
    const lines = [];
    await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep, onStatus: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes("ABCD")));
    assert.ok(lines.every((l) => !l.includes("\u001b")));
    server.close();
  });

  it("trustedVerificationUrl wants https on the service's host", () => {
    assert.equal(trustedVerificationUrl("https://device.example/x?c=1", "https://device.example"), "https://device.example/x?c=1");
    assert.equal(trustedVerificationUrl("http://device.example/x", "https://device.example"), "");
    assert.equal(trustedVerificationUrl("https://device.example.evil/x", "https://device.example"), "");
    assert.equal(trustedVerificationUrl("https://u:p@device.example/x", "https://device.example"), "");
    assert.equal(trustedVerificationUrl("https://device.example:8443/x", "https://device.example"), "");
  });

  it("trustedVerificationUrl accepts the default sign-in host when the service is reached under another name", () => {
    const viaOtherName = "https://device-auth.test.example";
    assert.equal(trustedVerificationUrl("https://device-auth.fireworks.ai/device?c=1", viaOtherName),
      "https://device-auth.fireworks.ai/device?c=1");
    assert.equal(trustedVerificationUrl("http://device-auth.fireworks.ai/device", viaOtherName), "");
    assert.equal(trustedVerificationUrl("https://device-auth.fireworks.ai:8443/device", viaOtherName), "");
  });

  it("treats denial as fatal (no paste fallback)", async () => {
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }]);
    const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    server.close();
  });

  it("stops on expired_token with a recovery line", async () => {
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "expired_token" } }]);
    const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /expired/);
    server.close();
  });

  it("fails softly when the service is unreachable", async () => {
    const result = await signInViaDeviceFlow({
      serviceUrl: "http://127.0.0.1:1",
      openBrowser: false,
      sleep: noSleep,
    });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /Couldn't reach/);
  });
});

describe("localhost callback flow", () => {
  let cognito;

  before(async () => {
    cognito = await startServer((req, res, body) => {
      if (req.url !== "/oauth2/token") {
        res.writeHead(404);
        res.end();
        return;
      }
      const params = new URLSearchParams(body.toString());
      const ok = params.get("grant_type") === "authorization_code"
        && params.get("code") === "good-code"
        && Boolean(params.get("code_verifier"));
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(ok
        ? JSON.stringify({ id_token: ID_TOKEN, access_token: "a", refresh_token: "r", expires_in: 3600 })
        : JSON.stringify({ error: "invalid_grant" }));
    });
  });

  after(() => {
    cognito.server.close();
  });

  /** Start the Nexus flow (our pages) and wait for the listener. */
  async function startNexusFlow() {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      nexusSignInPage: true,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { lines, pending };
  }

  /**
   * Pull the authorize URL (and its state) from what the flow prints via
   * onStatus: the authorize URL itself, or, with nexusSignInPage, our sign-in
   * page, whose first (Google) button carries it.
   */
  async function stateFrom(lines) {
    const page = /https?:\S+/.exec(lines.join("\n"))?.[0];
    let href = page;
    let cookie = "";
    if (page.startsWith("http://127.0.0.1:18000/s/")) {
      const response = await fetch(page);
      // The page belongs to the first browser that opens it: later loads
      // must carry its cookie, like a reload in that browser would.
      cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
      const html = await response.text();
      href = /<a class="btn" href="([^"]+)"/.exec(html)?.[1].replace(/&amp;/g, "&");
    }
    const url = new URL(href);
    return { page, url, state: url.searchParams.get("state"), cookie };
  }

  it("ignores stray requests, honors state, and exchanges the code (PKCE)", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      returnTo: "terminal",
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // listener up
    const { state } = await stateFrom(lines);
    assert.ok(state, "authorize URL with state was printed");

    // wrong path, wrong state, and forged errors (any local page can fire
    // these cross-origin) are all ignored, not fatal
    await fetch("http://localhost:18000/favicon.ico");
    await fetch(`http://localhost:18000/?code=evil&state=wrong`);
    await fetch("http://localhost:18000/?error=access_denied");
    await fetch(`http://localhost:18000/?error=server_error&state=wrong`);
    const landing = await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.match(await landing.text(), /return to your terminal/i);

    const result = await pending;
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.email, EMAIL);
  });

  it("serves its own sign-in page: social buttons skip Cognito's UI, email uses it", async () => {
    const { lines, pending } = await startNexusFlow();
    const { page, url, state, cookie } = await stateFrom(lines);
    // Our page, not Cognito's: on the IP literal (a squatter on [::1] can't
    // answer it) at a secret path.
    assert.match(page, /^http:\/\/127\.0\.0\.1:18000\/s\/[\w-]{43}$/);
    assert.equal(`${url.origin}${url.pathname}`, `${cognito.url}/oauth2/authorize`);
    assert.equal(url.searchParams.get("identity_provider"), "Google");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:18000");
    const response = await fetch(page, { headers: { cookie } });
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const html = await response.text();
    const providers = [...html.matchAll(/identity_provider=(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(providers, ["Google", "GitHub", "LinkedIn"]);
    // Email goes to Cognito's hosted UI (no identity_provider): passwords are
    // never typed on our page.
    const emailLink = html.split("<a ").find((tag) => tag.includes("Continue with email"));
    const email = /href="([^"]+)"/.exec(emailLink ?? "")?.[1]?.replaceAll("&amp;", "&");
    assert.equal(email, url.href.replace(/&identity_provider=Google$/, ""));
    assert.doesNotMatch(html, /<form|type="password"/);
    assert.equal((await fetch(`${page}/email`)).status, 404);

    // Another local process that doesn't know the path gets no state: not
    // at the root, not at a guessed path.
    for (const other of ["http://localhost:18000/", "http://127.0.0.1:18000/s/guess", "http://127.0.0.1:18000/s/"]) {
      assert.doesNotMatch(await (await fetch(other)).text(), new RegExp(state), other);
    }

    // A DNS-rebinding page reaches the listener under its own Host (or a
    // look-alike one): no page, no state.
    for (const host of ["attacker.example:18000", "localhost:18000.attacker.example"]) {
      const rebound = await new Promise((resolve, reject) => {
        request({ host: "127.0.0.1", port: 18000, path: new URL(page).pathname, headers: { Host: host } }, (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }).on("error", reject).end();
      });
      assert.equal(rebound.status, 400, host);
      assert.doesNotMatch(rebound.body, new RegExp(state));
    }

    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  /** A raw GET to the listener, for paths and headers fetch would normalize. */
  function rawGet(path, headers = {}) {
    return new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port: 18000, path, headers: { Host: "127.0.0.1:18000", ...headers } }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject).end();
    });
  }

  it("answers an unparsable request path with 400 and keeps waiting", async () => {
    const { lines, pending } = await startNexusFlow();
    for (const path of ["//", "//:", "http://[", "/%"]) {
      const { status } = await rawGet(path);
      assert.ok(status === 400 || status === 404, `${path} -> ${status}`);
    }
    const { state } = await stateFrom(lines);
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("a second tab opened at the same moment retries into the page", async () => {
    const { lines, pending } = await startNexusFlow();
    const { page, state, cookie } = await stateFrom(lines);
    // Tab two's request left before tab one's cookie was stored.
    const retry = await rawGet(new URL(page).pathname);
    assert.match(retry.body, /Opening sign-in/);
    // Its reload carries the cookie: the page, and sign-in goes on.
    const reloaded = await rawGet(new URL(page).pathname, { cookie });
    assert.equal(reloaded.status, 200);
    assert.match(reloaded.body, /Continue with Google/);
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("the sign-in page belongs to the first browser; another browser stops sign-in", async () => {
    const { lines, pending } = await startNexusFlow();
    const { page, state, cookie } = await stateFrom(lines);
    assert.match(cookie, /^nexus_signin=[\w-]{43}$/);
    // Reload or Back in the same browser still works.
    const again = await rawGet(new URL(page).pathname, { cookie });
    assert.equal(again.status, 200);
    // A load without the cookie gets one self-reloading page with no state
    // (a second tab opened at the same moment)...
    const retry = await rawGet(new URL(page).pathname);
    assert.equal(retry.status, 200);
    assert.match(retry.body, /Opening sign-in/);
    assert.doesNotMatch(retry.body, new RegExp(state));
    // ...later loads with no cookie at all (cookies blocked, a prerender)
    // get a page with no state, and sign-in goes on in the first window...
    const cookieless = await rawGet(new URL(page).pathname);
    assert.equal(cookieless.status, 200);
    assert.match(cookieless.body, /already open/);
    assert.doesNotMatch(cookieless.body, new RegExp(state));
    // ...and a cookie that isn't ours means another browser: nothing, and sign-in ends.
    const other = await rawGet(new URL(page).pathname, { cookie: "nexus_signin=forged" });
    assert.equal(other.status, 409);
    assert.doesNotMatch(other.body, new RegExp(state));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.match(result.failure, /second browser/);
  });

  it("hands the opener the authorize URL, so an app never has to load (and claim) the page", async () => {
    const calls = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      nexusSignInPage: true,
      open: async (url, info) => { calls.push({ url, info }); return true; },
      timeoutMs: 5000,
    });
    for (let tries = 0; !calls.length && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls.length, 1);
    const { url, info } = calls[0];
    assert.match(url, /^http:\/\/127\.0\.0\.1:18000\/s\//);
    const authorize = new URL(info.authorizeUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${cognito.url}/oauth2/authorize`);
    const state = authorize.searchParams.get("state");
    // The page is still unclaimed: the user's browser is its first load.
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /Continue with Google/);
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("keeps other clients (SSO pools) on Cognito's own sign-in", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      clientId: "sso-client",
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { page, url, state } = await stateFrom(lines);
    assert.equal(page, url.href, "the printed URL is Cognito's authorize URL");
    assert.equal(url.searchParams.get("client_id"), "sso-client");
    assert.equal(url.searchParams.get("identity_provider"), null);
    assert.doesNotMatch(await (await fetch("http://localhost:18000/")).text(), /Continue with Google/);

    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("drops a browser's unused preconnection when sign-in finishes", async () => {
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    // Chrome opens a spare connection and never sends on it; left alone it
    // holds server.close() (and `nexus login`) for Node's 60s headers timeout.
    const spare = connect(18000, "127.0.0.1");
    await new Promise((resolve) => spare.once("connect", resolve));
    const dropped = new Promise((resolve) => spare.once("close", resolve));
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.equal((await pending).ok, true);
    await Promise.race([
      dropped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("spare connection still open")), 1000)),
    ]);
  });

  /** Whether this machine can bind the IPv6 loopback (some CI containers can't). */
  async function ipv6LoopbackAvailable() {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
  }

  it("refuses to start when another process holds [::1]:18000", async (t) => {
    if (!await ipv6LoopbackAvailable()) {
      t.skip("no IPv6 loopback here");
      return;
    }
    // localhost may resolve to ::1, so a squatter there would receive the
    // Cognito callback (and its state). Sign-in must fail up front instead.
    const squatter = createServer((req, res) => res.end("lookalike"));
    await new Promise((resolve) => squatter.listen(18000, "::1", resolve));
    try {
      const result = await signInViaLocalhostCallback({
        cognitoDomain: cognito.url,
        nexusSignInPage: true,
        openBrowser: false,
        onStatus: () => {},
        timeoutMs: 5000,
      });
      assert.equal(result.ok, false);
      assert.match(result.failure, /Port 18000 is in use/);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it("answers the localhost callback on [::1] too", async (t) => {
    if (!await ipv6LoopbackAvailable()) {
      t.skip("no IPv6 loopback here");
      return;
    }
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    const landing = await fetch(`http://[::1]:18000/?code=good-code&state=${state}`);
    const text = await landing.text();
    // Shown before the token exchange: "finishing", never "signed in".
    assert.match(text, /Finishing sign-in/);
    assert.doesNotMatch(text, /signed in\b/i);
    assert.equal((await pending).ok, true);
  });

  it("ignores callbacks addressed to another Host, even with the right state", async () => {
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    // A DNS-rebinding page reaches loopback under its own Host: it gets a
    // 400 and can neither finish nor cancel the sign-in.
    for (const query of [`code=evil&state=${state}`, `error=access_denied&state=${state}`]) {
      const status = await new Promise((resolve, reject) => {
        request({ host: "127.0.0.1", port: 18000, path: `/?${query}`, headers: { Host: "attacker.example:18000" } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }).on("error", reject).end();
      });
      assert.equal(status, 400, query);
    }
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("closes a half-sent request soon after sign-in finishes", async () => {
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    // A request that never finishes its headers isn't "unused", so it used to
    // keep `nexus login` from exiting until Node's request timeout.
    const partial = connect(18000, "127.0.0.1");
    await new Promise((resolve) => partial.once("connect", resolve));
    partial.write("GET / HTTP/1.1\r\nHost: 127.0.0.1:18000\r\n");
    const dropped = new Promise((resolve) => partial.once("close", resolve));
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.equal((await pending).ok, true);
    await Promise.race([
      dropped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("half-sent request still open")), 3000)),
    ]);
  });

  it("sends the user back to the terminal or the Nexus app", async () => {
    // `nexus login` always has a terminal; Nexus desktop's helper has pipes.
    assert.equal(defaultReturnTo({ stdin: { isTTY: true }, stdout: { isTTY: true } }), "terminal");
    assert.equal(defaultReturnTo({ stdin: { isTTY: false }, stdout: { isTTY: true } }), "terminal");
    assert.equal(defaultReturnTo({ stdin: {}, stdout: {} }), "app");

    // The app's result page (passed explicitly: the default depends on
    // whether this test runs from a terminal, covered just above).
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      returnTo: "app",
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = await stateFrom(lines);
    const landing = await (await fetch(`http://localhost:18000/?code=good-code&state=${state}`)).text();
    assert.match(landing, /Return to the Nexus app\./);
    assert.doesNotMatch(landing, /terminal/i);
    assert.equal((await pending).ok, true);
  });

  it("treats access_denied with the matching state as fatal", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = await stateFrom(lines);
    await fetch(`http://localhost:18000/?error=access_denied&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
  });

  it("times out with a one-line failure instead of hanging", async () => {
    const result = await signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: () => {},
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.match(result.failure, /Timed out/);
  });

  it("surfaces a rejected code exchange as a soft failure", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = await stateFrom(lines);
    await fetch(`http://localhost:18000/?code=stale-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /invalid_grant/);
  });

  it("prints the sign-in URL alongside the opened-browser line", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: true, // pin: the runner itself may be an SSH session
      open: async () => true,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(lines.join("\n"), /Opened your browser/);
    assert.match(lines.join("\n"), /If nothing opened/);
    const { state } = await stateFrom(lines);
    assert.ok(state, "the authorize URL was printed as a fallback");
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("skips the opener entirely in a remote (SSH) session and prints the URL", async () => {
    process.env.SSH_TTY = "/dev/pts/7";
    try {
      const lines = [];
      let openerCalled = false;
      const pending = signInViaLocalhostCallback({
        cognitoDomain: cognito.url,
        open: async () => { openerCalled = true; return true; },
        onStatus: (line) => lines.push(line),
        timeoutMs: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(openerCalled, false, "no opener attempt on SSH");
      assert.match(lines.join("\n"), /Open this URL to sign in/);
      const { state } = await stateFrom(lines);
      await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
      const result = await pending;
      assert.equal(result.ok, true, result.failure);
    } finally {
      delete process.env.SSH_TTY;
    }
  });

  it("prints the URL and keeps listening when no browser can be opened", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: true, // pin: the runner itself may be an SSH session
      open: async () => false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(lines.join("\n"), /Couldn't open a browser here/);
    assert.match(lines.join("\n"), /login --paste/);
    // The wait is NOT abandoned: the printed URL still completes sign-in
    // (WSL's Windows browser, an SSH port-forward).
    const { state } = await stateFrom(lines);
    assert.ok(state, "the authorize URL was printed");
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });
});

describe("mint-api-key", () => {
  /** gRPC-web gateway mock: ListAccounts → ListUsers → CreateApiKey. */
  function startGateway({ minted = "fw_minted_key_0000000000000000000", authorized = true, accounts = ["accounts/test"], users = ["dev"], nexusAccounts = [], onKeyName = () => {} } = {}) {
    return startServer((req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      if (!authorized || req.headers.authorization !== `bearer ${ID_TOKEN}`) {
        res.end(grpcWebFrames(null, { status: 16 }));
        return;
      }
      const message = body.subarray(5);
      if (req.url.endsWith("/ListAccounts")) {
        // Account field 28 as a varint 1 marks a Nexus account.
        const productivityOnly = Buffer.from([0xe0, 0x01, 0x01]);
        res.end(grpcWebFrames(Buffer.concat(accounts.map((a) => pbField(1, Buffer.concat([
          pbString(1, a),
          ...(nexusAccounts.includes(a) ? [productivityOnly] : []),
        ]))))));
      } else if (req.url.endsWith("/ListUsers")) {
        const fields = pbDecode(message);
        const parent = pbStringAt(fields, 1);
        assert.match(parent, /^accounts\//);
        // An email filter narrows to one user; without it (no email claim in
        // the id_token) every configured user comes back, like the real API.
        let matched = users;
        if (pbStringAt(fields, 4)) {
          assert.match(pbStringAt(fields, 4), /email="dev@example\.com"/);
          matched = users.slice(0, 1);
        }
        res.end(grpcWebFrames(Buffer.concat(matched.map((u) => pbField(1, pbString(1, `${parent}/users/${u}`))))));
      } else if (req.url.endsWith("/CreateApiKey")) {
        const fields = pbDecode(message);
        const parent = pbStringAt(fields, 1);
        assert.match(parent, /^accounts\/.+\/users\/dev$/);
        const apiKey = pbDecode(fields.get(2)[0]);
        assert.match(pbStringAt(apiKey, 2), /^nexus-/);
        onKeyName(pbStringAt(apiKey, 2));
        res.end(grpcWebFrames(Buffer.concat([
          pbString(1, "key_test123"),
          pbString(2, pbStringAt(apiKey, 2)),
          pbString(3, minted),
        ])));
      } else {
        res.end(grpcWebFrames(null, { status: 12 }));
      }
    });
  }

  it("walks account → user → key and returns the plaintext once", async () => {
    const { server, url } = await startGateway();
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.key, "fw_minted_key_0000000000000000000");
    assert.equal(result.keyId, "key_test123");
    assert.equal(result.userName, "accounts/test/users/dev");
    server.close();
  });

  it("accepts any printable minted key without quotes or backslashes", async () => {
    const { server, url } = await startGateway({ minted: "fw_Ab9.~+=/:-_0000000000" });
    try {
      const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
      assert.equal(result.ok, true, result.failure);
      assert.equal(result.key, "fw_Ab9.~+=/:-_0000000000");
    } finally {
      server.close();
    }
  });

  it("refuses a minted key outside the fw_ charset", async () => {
    const { server, url } = await startGateway({ minted: "fw_abc\"\n[mcp_servers.x]" });
    try {
      const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
      assert.equal(result.ok, false);
      assert.equal(result.key, "");
      assert.match(result.failure, /malformed API key/);
    } finally {
      server.close();
    }
  });

  for (const minted of ["fw_{file:~/.ssh/id_rsa}", "fw_{env:HOME}", "fw_abc$HOME"]) {
    it(`refuses a minted key a harness config would expand: ${minted}`, async () => {
      const { server, url } = await startGateway({ minted });
      try {
        const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
        assert.equal(result.ok, false);
        assert.equal(result.key, "");
        assert.match(result.failure, /malformed API key/);
      } finally {
        server.close();
      }
    });
  }

  it("listAccountsForIdToken returns every account so the caller can pick", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"] });
    try {
      const listed = await listAccountsForIdToken(ID_TOKEN, { baseUrl: url });
      assert.equal(listed.ok, true, listed.failure);
      assert.deepEqual(listed.accountNames, ["accounts/acme", "accounts/personal"]);
      assert.deepEqual(listed.nexusAccountNames, []);
    } finally {
      server.close();
    }
  });

  it("listAccountsForIdToken gives up on a stalled response when its signal aborts", async () => {
    // Headers arrive, the body never does: without the signal this would hang.
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.write(Buffer.alloc(0));
    });
    try {
      const started = Date.now();
      const listed = await listAccountsForIdToken(ID_TOKEN, { baseUrl: url, signal: AbortSignal.timeout(100) });
      assert.equal(listed.ok, false);
      assert.deepEqual(listed.nexusAccountNames, []);
      assert.match(listed.failure, /Couldn't reach the Fireworks control plane/);
      assert.ok(Date.now() - started < 2_000, "returns at the deadline");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("listAccountsForIdToken says which accounts are Nexus accounts", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"], nexusAccounts: ["accounts/acme"] });
    try {
      const listed = await listAccountsForIdToken(ID_TOKEN, { baseUrl: url });
      assert.equal(listed.ok, true, listed.failure);
      assert.deepEqual(listed.accountNames, ["accounts/acme", "accounts/personal"]);
      assert.deepEqual(listed.nexusAccountNames, ["accounts/acme"]);
    } finally {
      server.close();
    }
  });

  it("mintApiKeyForAccount mints under the chosen account; the wrapper takes the first", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"] });
    try {
      const picked = await mintApiKeyForAccount(ID_TOKEN, "accounts/personal", { email: EMAIL, baseUrl: url });
      assert.equal(picked.ok, true, picked.failure);
      assert.equal(picked.userName, "accounts/personal/users/dev");

      // The non-interactive wrapper still defaults to the first account.
      const first = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
      assert.equal(first.ok, true, first.failure);
      assert.equal(first.userName, "accounts/acme/users/dev");
    } finally {
      server.close();
    }
  });

  it("refuses to guess among users when the sign-in has no email claim", async () => {
    const { server, url } = await startGateway({ users: ["alice", "bob"] });
    try {
      const result = await mintApiKeyForAccount(ID_TOKEN, "accounts/test", { baseUrl: url });
      assert.equal(result.ok, false);
      assert.match(result.failure, /didn't say which/);
      assert.match(result.failure, /--paste/);
    } finally {
      server.close();
    }
  });

  it("mints without an email claim when the account has exactly one user", async () => {
    const { server, url } = await startGateway();
    try {
      const result = await mintApiKeyForAccount(ID_TOKEN, "accounts/test", { baseUrl: url });
      assert.equal(result.ok, true, result.failure);
      assert.equal(result.userName, "accounts/test/users/dev");
    } finally {
      server.close();
    }
  });

  it("says the caller isn't a member on a bare ListUsers denial, and keeps a denial's reason", async () => {
    let detail = "";
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(null, { status: 7, detail }));
    });
    try {
      const bare = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(bare.ok, false);
      assert.match(bare.failure, /not a member of "example-account"/);

      detail = "SSO authentication is required";
      const explained = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(explained.ok, false);
      assert.match(explained.failure, /SSO authentication is required/);
      assert.doesNotMatch(explained.failure, /not a member/);
    } finally {
      server.close();
    }
  });

  it("maps an unauthenticated token to a --paste recovery line", async () => {
    const { server, url } = await startGateway({ authorized: false });
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
    assert.equal(result.ok, false);
    assert.match(result.failure, /--paste/);
    server.close();
  });

  it("fails softly when the control plane is unreachable", async () => {
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: "http://127.0.0.1:1" });
    assert.equal(result.ok, false);
    assert.match(result.failure, /Couldn't reach/);
  });

  it("names keys with an explicit origin and sanitized hostname", () => {
    assert.equal(mintedKeyName("Example-Workstation.local", "cli"), "nexus-cli-example-workstation");
    assert.equal(mintedKeyName("host_with.dots", "desktop"), "nexus-desktop-host-with");
    assert.equal(mintedKeyName("", "cli"), "nexus-cli-unknown-host");
    assert.equal(mintedKeyName("", "desktop"), "nexus-desktop-unknown-host");
    assert.equal(mintedKeyName("host", "unrecognized"), "nexus-cli-host");
    assert.equal(mintedKeyName("host", ""), "nexus-cli-host");
  });

  it("reads the explicit desktop signal at call time, defaulting to CLI", () => {
    const previous = process.env.NEXUS_CLIENT;
    try {
      delete process.env.NEXUS_CLIENT;
      assert.equal(mintedKeyName("host"), "nexus-cli-host");
      process.env.NEXUS_CLIENT = "desktop";
      assert.equal(mintedKeyName("host"), "nexus-desktop-host");
      process.env.NEXUS_CLIENT = "other";
      assert.equal(mintedKeyName("host"), "nexus-cli-host");
    } finally {
      if (previous === undefined) delete process.env.NEXUS_CLIENT;
      else process.env.NEXUS_CLIENT = previous;
    }
  });

  for (const client of ["cli", "desktop"]) {
    it(`sends the ${client} display name in the key creation request`, async () => {
      const names = [];
      const { server, url } = await startGateway({ onKeyName: (name) => names.push(name) });
      try {
        const keyName = mintedKeyName("Test-Machine.local", client);
        const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url, keyName });
        assert.equal(result.ok, true, result.failure);
        assert.deepEqual(names, [`nexus-${client}-test-machine`]);
      } finally {
        server.close();
      }
    });
  }

  for (const client of ["cli", "desktop"]) {
    it(`keeps the ${client} created name consistent with state and login output`, async (t) => {
      await withTempHome("key-origin-", async (home) => {
        const envKeys = ["HOME", "NEXUS_CLIENT", "FIREWORKS_API_KEY", "SSH_CONNECTION", "NEXUS_SECRET_STORE", "NEXUS_TEST"];
        const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        Object.assign(process.env, { HOME: home, NEXUS_CLIENT: client, FIREWORKS_API_KEY: "", SSH_CONNECTION: "test", NEXUS_SECRET_STORE: "memory", NEXUS_TEST: "1" });
        resetSecretStoreForTests();
        const hostnameMock = t.mock.method(os, "hostname", () => "example-host");
        const realFetch = globalThis.fetch;
        const lines = [];
        let createdName;
        let callback;
        const identityResponse = () => new Response(null, { headers: { "x-fireworks-developer-email": EMAIL } });
        // Local-only replies for token exchange, account/user lookup, creation,
        // and both identity checks. Unexpected requests fail closed.
        const replies = [
          () => Response.json({ id_token: ID_TOKEN }),
          () => new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test")))),
          () => new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test/users/dev")))),
          (_url, options) => {
            const request = pbDecode(options.body.subarray(5));
            createdName = pbStringAt(pbDecode(request.get(2)[0]), 2);
            // A changed environment after creation must not change local metadata/output.
            process.env.NEXUS_CLIENT = client === "desktop" ? "cli" : "desktop";
            return new Response(grpcWebFrames(Buffer.concat([
              pbString(1, "key-origin-test"), pbString(2, createdName),
              pbString(3, "fw_origin_test_0000000000000000000"),
            ])));
          },
          identityResponse,
          identityResponse,
        ];
        const fetchMock = t.mock.method(globalThis, "fetch", async (...args) => {
          const reply = replies.shift();
          assert.ok(reply, "unexpected auth request");
          return reply(...args);
        });
        const logMock = t.mock.method(console, "log", (...args) => {
          const line = args.join(" ");
          lines.push(line);
          const match = line.match(/http:\/\/127\.0\.0\.1:18000\/s\/[^\s]+/);
          if (match && !callback) {
            callback = (async () => {
              const page = await realFetch(match[0]);
              const html = await page.text();
              const href = html.match(/href="([^" ]+\/oauth2\/authorize\?[^" ]+)"/);
              assert.ok(href, "sign-in page links to authorization");
              const state = new URL(href[1].replaceAll("&amp;", "&")).searchParams.get("state");
              return realFetch(`http://127.0.0.1:18000/?code=test&state=${state}`);
            })();
            callback.catch(() => {});
          }
        });
        try {
          assert.equal(await runInteractiveSignIn(home, { method: "browser", nextHint: false }), true);
          await callback;
          assert.equal(replies.length, 0);
          assert.equal(createdName, mintedKeyName(os.hostname(), client));
          const state = await readMintedKeyState(home);
          assert.equal(state.displayName, createdName);
          const createdLine = lines.find((line) => line.includes(`Created API key ${createdName}`));
          assert.ok(createdLine);
          t.diagnostic(createdLine.trim());
        } finally {
          hostnameMock.mock.restore();
          fetchMock.mock.restore();
          logMock.mock.restore();
          resetSecretStoreForTests();
          for (const key of envKeys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
          }
        }
      });
    });
  }

  it("jwtClaims decodes without verifying and tolerates garbage", () => {
    assert.equal(jwtClaims(ID_TOKEN).email, EMAIL);
    assert.deepEqual(jwtClaims("not-a-jwt"), {});
  });
});
