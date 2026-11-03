import { isFireworksKey } from "./key-type.mjs";

/**
 * What a harness's `keyInUse` returns when it holds no copy of the key and
 * asks Nexus for it per request instead (Claude's `nexus key export`
 * apiKeyHelper): it always sends the stored key. A `$FIREWORKS_API_KEY`
 * reference is not this — it sends whatever the shell exports — so adapters
 * report it as null.
 */
export const LIVE_KEY = Object.freeze({ live: true });

/**
 * `perHarness[].keyCurrent` in `nexus status --json`: does this harness send
 * the key `status` resolved?
 *   - true: it fetches the key from Nexus, or holds a copy equal to `activeKey`;
 *   - false: it holds a different Fireworks key (e.g. one baked in before an
 *     account switch that the login sync couldn't rewrite);
 *   - null: not on Fireworks, no active key, an env reference, or a copy that
 *     can't be read without a keychain prompt.
 *
 * The adapter's `keyInUse(ctx)` reports what the harness sends — a literal
 * key, LIVE_KEY, or null for "off / can't tell" — and must never prompt.
 * Keys are compared here in memory only and never leave this function.
 * Never throws.
 * @param {{ keyInUse?: (ctx: object) => Promise<string | typeof LIVE_KEY | null> }} adapter
 * @param {object} ctx
 * @param {string} activeKey
 * @returns {Promise<boolean | null>}
 */
export async function harnessKeyCurrent(adapter, ctx, activeKey) {
  const active = activeKey?.trim() ?? "";
  if (!active || typeof adapter?.keyInUse !== "function") {
    return null;
  }
  try {
    const inUse = await adapter.keyInUse(ctx);
    if (inUse === LIVE_KEY) {
      return true;
    }
    const held = typeof inUse === "string" ? inUse.trim() : "";
    if (!isFireworksKey(held)) {
      return null;
    }
    return held === active;
  } catch {
    return null;
  }
}
