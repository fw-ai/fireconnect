import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { link, openInBrowser } from "../ui/term.mjs";
import { sanitize } from "../ui/sanitize.mjs";
import { isLoopbackHostname, loopbackHostHeaders } from "../system/loopback.mjs";
import { isRemoteContext } from "../config/remote-context.mjs";
import { PAGE_HEADERS, callbackPage, firstWindowPage, openingPage, signInPage } from "./sign-in-page.mjs";

/**
 * Browser sign-in for `nexus login`.
 *
 * Primary flow: OAuth authorization-code + PKCE against Cognito, catching the
 * redirect on http://localhost:18000 — the redirect URI already registered on
 * the developer app client (firectl signin uses the same one). For the Nexus
 * client (`nexusSignInPage`), the same listener serves our own sign-in page
 * at that root (sign-in-page.mjs) first: the Google, GitHub and LinkedIn
 * buttons go to Cognito's authorize endpoint with identity_provider set,
 * which forwards straight to that provider, and email goes to Cognito's
 * hosted UI, so the CLI never sees a password. Other callers (SSO accounts'
 * own pools) open Cognito's authorize URL directly.
 *
 * Fallback flow (SSH / --no-browser): the RFC 8628 device-authorization
 * service at device-auth.fireworks.ai. When the service is unreachable, init
 * fails with a network error and callers degrade to the paste flow.
 *
 * Both flows yield a Cognito id_token; mint-api-key.mjs exchanges that for
 * the fw_ key everything downstream of auth actually uses.
 *
 * The client id, domains, and pool id are public values (the app client is a
 * public OAuth client — no secret exists). Env overrides point the CLI at a
 * different pool.
 */
export const OAUTH_CLIENT_ID = process.env.NEXUS_OAUTH_CLIENT_ID?.trim()
  || "sueas7prsfrdp16nantbeqcjv";
export const COGNITO_DOMAIN = process.env.NEXUS_COGNITO_DOMAIN?.trim()
  || "https://fireworks.auth.us-west-2.amazoncognito.com";
export const COGNITO_POOL_ID = process.env.NEXUS_COGNITO_POOL_ID?.trim()
  || "us-west-2_feAWJl2Gd";
const DEFAULT_DEVICE_AUTH_URL = "https://device-auth.fireworks.ai";
export const DEVICE_AUTH_URL = process.env.NEXUS_DEVICE_AUTH_URL?.trim()
  || DEFAULT_DEVICE_AUTH_URL;

/** The exact redirect URI registered on the Cognito app client (root path, port 18000). */
export const CALLBACK_URI = "http://localhost:18000";
const CALLBACK_PORT = 18000;
const CALLBACK_TIMEOUT_MS = 300_000;
/** How long a request still in flight when sign-in finishes may keep its connection. */
const LINGER_MS = 1_000;

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Decode a JWT payload without verifying the signature — same as
 * `firectl whoami`; we only read the email for display, the token's real
 * validation happens server-side when it mints the key.
 * @param {string} token
 * @returns {Record<string, unknown>}
 */
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * @typedef {Object} TokenResult
 * @property {boolean} ok
 * @property {string} idToken     Cognito id_token ("" on failure).
 * @property {string} email       email claim from the id_token (may be "").
 * @property {string} failure     One-line reason, phrased for the terminal ("" when ok).
 * @property {boolean} fatal      True when retrying another flow won't help (user denied).
 */

const failed = (failure, fatal = false) => ({ ok: false, idToken: "", email: "", failure, fatal });

const PAGE_OWNER_COOKIE = "nexus_signin";
export const PAGE_REUSED_FAILURE = "The sign-in link was opened in a second browser, so sign-in was stopped for safety; "
  + "finish in the browser it opens.";

/** One cookie's value from a Cookie header, or "". */
function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * Wait for the OAuth redirect on localhost:18000. Resolves with the
 * authorization code once the browser lands, or a failure line on
 * error/timeout. With `signInPage`, the listener also serves the sign-in page
 * that links to `authorizeUrl`, at a secret path on 127.0.0.1 (see below).
 * `onListening` runs after the port is bound (the listener must exist before
 * the browser navigates) with the URL to open (that page, else `authorizeUrl`
 * itself), to print status and open the browser.
 * @param {string} authorizeUrl
 * @param {string} state
 * @param {(url: string) => Promise<void>} onListening
 * @param {{ timeoutMs?: number, port?: number, signInPage?: boolean }} [options]
 * @returns {Promise<{ code: string, failure: string, fatal: boolean }>}
 */
function waitForCallback(authorizeUrl, state, onListening, { timeoutMs = CALLBACK_TIMEOUT_MS, port = CALLBACK_PORT, signInPage: servePage = false, returnTo = "terminal" } = {}) {
  return new Promise((resolve) => {
    // The sign-in page carries state and the PKCE challenge in its links, so
    // it lives at a path only the opened URL knows. That URL is passed to
    // the browser opener as an argument, which other OS users on the same
    // machine may be able to read, so the page also belongs to the first
    // browser that opens it (a cookie): reloads and Back there still work,
    // and a load from any other browser stops the sign-in, so whoever else
    // has the URL can never finish it with their own account. The first
    // load without the cookie gets one retry instead (no state in it): a
    // browser that opened the link twice at once (two tabs) sends its second
    // request before the cookie is stored, and its retry carries the cookie.
    // Later loads with no cookie at all (cookies blocked, a prerender, a
    // restored tab) get a page with no state either, and sign-in goes on in
    // the first window; only a cookie that isn't ours stops it.
    const pagePath = `/s/${base64url(randomBytes(32))}`;
    const pageOwner = base64url(randomBytes(32));
    let pageClaimed = false;
    let strangerRetried = false;
    const hosts = loopbackHostHeaders(port);
    const handle = (req, res) => {
      // "Connection: close" everywhere: a lingering keep-alive socket would
      // otherwise outlive server.close() and hold the process open after
      // sign-in finishes.
      // Only answer requests addressed to this listener by name, before
      // anything else looks at the request: a DNS-rebinding page reaches
      // loopback under its own Host and gets nothing (no page, and no say in
      // the callback's outcome).
      if (!hosts.includes(req.headers.host ?? "")) {
        res.writeHead(400, { Connection: "close" });
        res.end();
        return;
      }
      // Any page the user visits can send a request here (an <img> tag), so
      // a target that doesn't parse is answered, never thrown.
      let url;
      try {
        url = new URL(req.url ?? "/", CALLBACK_URI);
      } catch {
        res.writeHead(400, { Connection: "close" });
        res.end();
        return;
      }
      if (servePage && url.pathname === pagePath) {
        const owner = cookieValue(req.headers.cookie, PAGE_OWNER_COOKIE);
        if (pageClaimed && owner !== pageOwner && !strangerRetried) {
          strangerRetried = true;
          res.writeHead(200, { ...PAGE_HEADERS, Refresh: "1", Connection: "close" });
          res.end(openingPage());
          return;
        }
        if (pageClaimed && !owner) {
          res.writeHead(200, { ...PAGE_HEADERS, Connection: "close" });
          res.end(firstWindowPage());
          return;
        }
        if (pageClaimed && owner !== pageOwner) {
          res.writeHead(409, { ...PAGE_HEADERS, "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
          res.end("This sign-in link was opened in another browser, so this sign-in was stopped. Run nexus login again.\n");
          finish({ code: "", failure: PAGE_REUSED_FAILURE, fatal: true });
          return;
        }
        pageClaimed = true;
        res.writeHead(200, {
          ...PAGE_HEADERS,
          "Set-Cookie": `${PAGE_OWNER_COOKIE}=${pageOwner}; Path=/s/; HttpOnly; SameSite=Lax`,
          Connection: "close",
        });
        res.end(signInPage(authorizeUrl));
        return;
      }
      if (url.pathname !== "/") {
        res.writeHead(404, { Connection: "close" });
        res.end();
        return;
      }
      const error = url.searchParams.get("error") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const stateOk = url.searchParams.get("state") === state;
      const ok = !error && stateOk && Boolean(code);
      res.writeHead(200, { ...PAGE_HEADERS, Connection: "close" });
      res.end(callbackPage(ok, { returnTo }));
      // A stray request shouldn't kill the wait unless Cognito reported a
      // real outcome — and "real" means the CSRF state matches, for errors
      // too (RFC 6749 §4.1.2.1 echoes state on error redirects). Otherwise
      // any local page could abort sign-in with a forged
      // /?error=access_denied fetch.
      if (ok) {
        finish({ code, failure: "", fatal: false });
      } else if (error === "access_denied" && stateOk) {
        finish({ code: "", failure: "Sign-in was cancelled in the browser.", fatal: true });
      } else if (error && stateOk) {
        finish({ code: "", failure: `The sign-in page reported an error (${error}).`, fatal: false });
      }
    };

    // The registered redirect is http://localhost, which browsers may resolve
    // to either loopback address, so listen on both: a process holding [::1]
    // would otherwise receive the callback (and its state) and leave the
    // browser on its own page mid-sign-in. No IPv6 on the machine is fine.
    const servers = [createServer(handle), createServer(handle)];

    // Browsers open spare connections ahead of time (Chrome preconnects to
    // the page's own origin). One that never sends a request isn't idle to
    // Node, so server.close() would wait out the 60s headers timeout with
    // `nexus login` stuck after "Signed in". Those are dropped at finish;
    // anything else still open (a request that never completed) gets a
    // moment to flush, then goes too.
    const sockets = new Set();
    const unused = new Set();
    for (const server of servers) {
      server.on("connection", (socket) => {
        sockets.add(socket);
        unused.add(socket);
        socket.once("data", () => unused.delete(socket));
        socket.once("close", () => {
          sockets.delete(socket);
          unused.delete(socket);
        });
      });
    }

    let timer = null;
    let settled = false;
    const finish = (result) => {
      // First outcome wins: the timeout and a callback in flight can race here.
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const server of servers) {
        server.close();
      }
      for (const socket of unused) {
        socket.destroy();
      }
      setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, LINGER_MS).unref();
      resolve(result);
    };
    const failedToListen = (error) => finish({
      code: "",
      failure: error?.code === "EADDRINUSE"
        ? `Port ${port} is in use (is another sign-in running?).`
        : `Couldn't start the local sign-in listener (${error?.message ?? "unknown error"}).`,
      fatal: false,
    });
    const listen = (server, host) => new Promise((done) => {
      server.once("error", done);
      server.listen(port, host, () => {
        server.off("error", done);
        server.on("error", failedToListen);
        done(null);
      });
    });

    (async () => {
      // Loopback only — nothing off-host ever belongs here.
      const v4 = await listen(servers[0], "127.0.0.1");
      if (v4) {
        failedToListen(v4);
        return;
      }
      const v6 = await listen(servers[1], "::1");
      if (v6 && v6.code === "EADDRINUSE") {
        failedToListen(v6);
        return;
      }
      if (v6) {
        servers.pop();
      }
      if (settled) {
        return;
      }
      timer = setTimeout(() => {
        finish({ code: "", failure: "Timed out waiting for the browser sign-in.", fatal: false });
      }, timeoutMs);
      // The page opens on the IP literal (RFC 8252 §8.3); the Cognito
      // callback comes back on the registered http://localhost, which both
      // binds above answer.
      await onListening(servePage ? `http://127.0.0.1:${port}${pagePath}` : authorizeUrl);
    })();
  });
}

/**
 * Where the result page sends the user back to. `nexus login` always runs on
 * a terminal; Nexus desktop drives this module from a helper process whose
 * stdio are pipes, so no terminal means the app started the sign-in.
 * @param {{ stdin?: { isTTY?: boolean }, stdout?: { isTTY?: boolean } }} [stdio]
 * @returns {"terminal" | "app"}
 */
export function defaultReturnTo({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return stdin?.isTTY || stdout?.isTTY ? "terminal" : "app";
}

/**
 * Primary flow: authorization-code + PKCE via Cognito, redirect caught on
 * localhost. `nexusSignInPage` (the Nexus client only) starts from our own
 * sign-in page instead of Cognito's hosted UI. `returnTo` picks the result
 * page's wording (terminal or app; see defaultReturnTo). `onStatus`
 * receives user-facing progress lines. `open` is the browser opener
 * (injectable for tests and for apps that compose this flow). Its second
 * argument carries `authorizeUrl`, the hosted authorize URL behind our own
 * sign-in page: a caller that needs it must take it from here, never by
 * loading the page, since the first load claims the page for its browser.
 * @param {{ onStatus?: (line: string) => void, openBrowser?: boolean, open?: (url: string, info: { authorizeUrl: string }) => Promise<boolean>, cognitoDomain?: string, clientId?: string, nexusSignInPage?: boolean, returnTo?: "terminal" | "app", timeoutMs?: number }} [options]
 * @returns {Promise<TokenResult>}
 */
export async function signInViaLocalhostCallback({
  onStatus = () => {},
  // On SSH/WSL a locally-opened browser can't reach the user — skip the
  // opener entirely and print the URL (it still completes sign-in via WSL's
  // Windows browser or an SSH port-forward to localhost:18000).
  openBrowser = !isRemoteContext(),
  open = (url) => openInBrowser(url),
  cognitoDomain = COGNITO_DOMAIN,
  clientId = OAUTH_CLIENT_ID,
  nexusSignInPage = false,
  returnTo = defaultReturnTo(),
  timeoutMs = CALLBACK_TIMEOUT_MS,
} = {}) {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const authorizeUrl = `${cognitoDomain}/oauth2/authorize?` + new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: CALLBACK_URI,
    state,
    code_challenge_method: "S256",
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
  }).toString();

  const { code, failure, fatal } = await waitForCallback(authorizeUrl, state, async (url) => {
    if (!openBrowser) {
      onStatus(`Open this URL to sign in:\n  ${link(url)}`);
      return;
    }
    if (await open(url, { authorizeUrl })) {
      onStatus("Opened your browser — finish signing in there.");
      onStatus(`If nothing opened, sign in at:\n  ${link(url)}`);
      return;
    }
    onStatus(`Couldn't open a browser here. To sign in, open this URL in a browser on this machine:\n  ${link(url)}`);
    onStatus("Or press Ctrl+C and run  nexus login --paste  to paste a key instead.");
  }, { timeoutMs, signInPage: nexusSignInPage, returnTo });
  if (!code) {
    return failed(failure, fatal);
  }

  let response;
  try {
    response = await fetch(`${cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: CALLBACK_URI,
        code_verifier: verifier,
      }),
    });
  } catch (error) {
    return failed(`Couldn't reach the sign-in service (${error?.message ?? "network error"}).`);
  }
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.id_token) {
    return failed(`The sign-in service rejected the browser sign-in (${tokens.error ?? response.status}).`);
  }
  const email = typeof jwtClaims(tokens.id_token).email === "string" ? jwtClaims(tokens.id_token).email : "";
  return { ok: true, idToken: tokens.id_token, email, failure: "", fatal: false };
}

/**
 * The verification URL to open or print, or "" when it isn't on the sign-in
 * service's own origin over https (plain http only when the service itself
 * is a loopback address, as in development). The service builds the link
 * from its own public address, which stays the default sign-in host when
 * the CLI reaches the service under another name, so that origin is
 * accepted too.
 * @param {unknown} candidate
 * @param {string} serviceUrl
 */
export function trustedVerificationUrl(candidate, serviceUrl) {
  try {
    const url = new URL(String(candidate));
    const service = new URL(serviceUrl);
    const loopback = isLoopbackHostname(service.hostname);
    const schemeOk = url.protocol === "https:" || (loopback && url.protocol === "http:" && service.protocol === "http:");
    const sameOrigin = url.hostname === service.hostname && url.port === service.port;
    if (!schemeOk || !(sameOrigin || url.origin === DEFAULT_DEVICE_AUTH_URL) || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Fallback flow: RFC 8628 device authorization. Init returns the one-time
 * code and verification URLs; we poll until the user approves in a browser
 * (on any device). The service's error contract: HTTP 400 with
 * {"error": "authorization_pending" | "slow_down" | "expired_token" | "denied"}.
 * @param {{ onStatus?: (line: string) => void, openBrowser?: boolean, serviceUrl?: string, clientId?: string, cognitoDomain?: string, cognitoPoolId?: string, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<TokenResult>}
 */
export async function signInViaDeviceFlow({
  onStatus = () => {},
  // Same remote-session rule as the localhost flow; the device verification
  // URL works from any device, so printing it is the whole point here.
  openBrowser = !isRemoteContext(),
  serviceUrl = DEVICE_AUTH_URL,
  clientId = OAUTH_CLIENT_ID,
  cognitoDomain = COGNITO_DOMAIN,
  cognitoPoolId = COGNITO_POOL_ID,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const baseParams = {
    client_id: clientId,
    cognito_pool_id: cognitoPoolId,
    cognito_domain: cognitoDomain,
  };
  const tokenUrl = (extra = {}) =>
    `${serviceUrl}/token?${new URLSearchParams({ ...baseParams, ...extra }).toString()}`;
  const post = (url) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  let init;
  try {
    const response = await post(tokenUrl());
    init = await response.json().catch(() => null);
    if (!response.ok || !init?.device_code) {
      return failed(`Browser sign-in service returned an unexpected response (${response.status}).`);
    }
  } catch (error) {
    return failed(`Couldn't reach the browser sign-in service (${error?.message ?? "network error"}).`);
  }

  const verifyUrl = trustedVerificationUrl(init.verification_uri_complete || init.verification_uri, serviceUrl);
  if (!verifyUrl) {
    return failed("Browser sign-in service returned an unexpected verification link.");
  }
  onStatus(`Your one-time code is  ${sanitize(init.user_code)}`);
  if (openBrowser && await openInBrowser(verifyUrl)) {
    onStatus("Opened your browser — approve the sign-in there (the code is pre-filled).");
  } else {
    onStatus(`On any device, open  ${link(verifyUrl)}`);
  }

  let intervalMs = Math.max(1, Number(init.interval) || 10) * 1000;
  const deadline = Date.now() + (Number(init.expires_in) || 1800) * 1000;
  const pollUrl = tokenUrl({ device_code: init.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let response;
    try {
      response = await post(pollUrl);
    } catch {
      continue; // transient network blip mid-poll: keep waiting
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.id_token) {
      const email = typeof jwtClaims(body.id_token).email === "string" ? jwtClaims(body.id_token).email : "";
      return { ok: true, idToken: body.id_token, email, failure: "", fatal: false };
    }
    if (body.error === "authorization_pending") {
      continue;
    }
    if (body.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (body.error === "denied") {
      return failed("Sign-in was denied in the browser.", true);
    }
    if (body.error === "expired_token") {
      return failed("The sign-in code expired before it was approved.");
    }
    return failed(`Browser sign-in failed (${body.error || `HTTP ${response.status}`}).`);
  }
  return failed("The sign-in code expired before it was approved.");
}
