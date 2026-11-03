/**
 * The one loopback rule: the host names that only ever reach this machine,
 * and "https, or plain http only on loopback". Pure leaf (the Desktop shim
 * imports it).
 */

/** Loopback host names as URL.hostname spells them. */
export const LOOPBACK_HOSTNAMES = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);

/** @param {string} hostname a URL.hostname */
export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.includes(String(hostname ?? "").toLowerCase());
}

/** Host header values that address a loopback listener on `port`. */
export function loopbackHostHeaders(port) {
  return LOOPBACK_HOSTNAMES.map((host) => `${host}:${port}`);
}

/** @param {URL} url https anywhere, or http on a loopback host. */
export function isHttpsOrLoopbackHttp(url) {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
}
