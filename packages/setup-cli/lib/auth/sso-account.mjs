import { Buffer } from "node:buffer";
import { grpcWebCall, pbDecode, pbField, pbString, pbStringAt } from "./grpc-web.mjs";
import { GATEWAY_GRPC_WEB_URL } from "../keys/mint-api-key.mjs";
import { isHttpsOrLoopbackHttp } from "../system/loopback.mjs";

/**
 * Enterprise SSO sign-in support, mirroring `firectl signin <account-id>`.
 *
 * Two unary gRPC-web calls against the gateway:
 *
 * - GetOAuthArguments (unauthenticated) resolves an account's OAuth config —
 *   for custom-SSO accounts, the tenant issuer/client/domain whose hosted UI
 *   federates to the org's identity provider. Feeding these into the
 *   existing localhost-callback flow is the whole SSO mechanism; tokens from
 *   the tenant issuer work on the same mint path as developer tokens.
 *
 * - CreateUser with an empty user is JIT self-provisioning: the server
 *   takes the email from the SSO token and adds the user to the account
 *   when the account allows it. AlreadyExists means the user was pre-added
 *   or has signed in before — equally fine.
 */

const GRPC_ALREADY_EXISTS = 6;
const GRPC_PERMISSION_DENIED = 7;

/**
 * @typedef {Object} OAuthArgsResult
 * @property {boolean} ok
 * @property {string} issuerUrl      OIDC issuer (may be "" even on ok).
 * @property {string} clientId       OAuth client id for the hosted UI.
 * @property {string} cognitoDomain  Hosted-UI base URL (https://… normalized).
 * @property {string} failure        One-line reason for the terminal ("" when ok).
 */

const failedArgs = (failure) => ({ ok: false, issuerUrl: "", clientId: "", cognitoDomain: "", failure });

/**
 * The gateway stores the domain as a URL (firectl url.Parse()s it verbatim),
 * but normalize defensively: no scheme → https, no trailing slash. The
 * result is opened in the browser, so only an https URL (http just for a
 * loopback host) without credentials, query or fragment is accepted.
 * @param {string} domain
 */
export function normalizeCognitoDomain(domain) {
  const trimmed = String(domain ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  // A scheme only when written as `scheme://`: a bare `host:port` (dots and
  // hyphens are legal scheme characters) is a host, like before.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!isHttpsOrLoopbackHttp(url) || url.username || url.password || url.search || url.hash
      || !/^(?:[a-z0-9.-]+|\[::1\])$/i.test(url.hostname)) {
      return "";
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/**
 * Resolve the OAuth arguments for an account's sign-in.
 * @param {string} accountId  bare id, e.g. "my-company"
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<OAuthArgsResult>}
 */
export async function getOAuthArgumentsForAccount(accountId, { baseUrl = GATEWAY_GRPC_WEB_URL } = {}) {
  const id = accountId?.trim() ?? "";
  if (!id) {
    return failedArgs("No account ID given.");
  }
  let result;
  try {
    result = await grpcWebCall(baseUrl, "GetOAuthArguments", pbString(1, id), "");
  } catch (error) {
    return failedArgs(`Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).`);
  }
  if (result.status !== 0 || !result.message) {
    // The server answers PERMISSION_DENIED for unknown accounts — don't
    // leak-guess; the recovery is the same either way.
    return failedArgs(
      `Couldn't find SSO sign-in configuration for account "${id}". Check the account ID with your admin, or use nexus login --paste.`,
    );
  }
  const fields = pbDecode(result.message);
  const clientId = pbStringAt(fields, 2);
  const cognitoDomain = normalizeCognitoDomain(pbStringAt(fields, 3));
  if (!clientId || !cognitoDomain) {
    return failedArgs(
      `Account "${id}" has no SSO sign-in configured. Check the account ID with your admin, or use nexus login --paste.`,
    );
  }
  return { ok: true, issuerUrl: pbStringAt(fields, 1), clientId, cognitoDomain, failure: "" };
}

/**
 * JIT self-provisioning after an SSO sign-in (mirrors firectl signin):
 * CreateUser{parent: accounts/<id>, user: {}} — the server fills the email
 * in from the SSO token. Outcomes:
 *   created / AlreadyExists  → ok (member, proceed)
 *   PermissionDenied         → ok: minting decides membership.
 * @param {string} idToken
 * @param {string} accountId  bare id, e.g. "my-company"
 * @param {{ baseUrl?: string }} [options]
 * @returns {Promise<{ ok: boolean, failure: string }>}
 */
export async function createUserJit(idToken, accountId, { baseUrl = GATEWAY_GRPC_WEB_URL } = {}) {
  const request = Buffer.concat([
    pbString(1, `accounts/${accountId}`),
    pbField(2, Buffer.alloc(0)),
  ]);
  let result;
  try {
    result = await grpcWebCall(baseUrl, "CreateUser", request, idToken);
  } catch (error) {
    return { ok: false, failure: `Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).` };
  }
  if (result.status === 0 || result.status === GRPC_ALREADY_EXISTS || result.status === GRPC_PERMISSION_DENIED) {
    return { ok: true, failure: "" };
  }
  return {
    ok: false,
    failure: `Something went wrong joining "${accountId}"${result.detail ? ` (${result.detail})` : ` (status ${result.status})`}.`,
  };
}
