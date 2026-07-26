/**
 * Claude Code's `WebSearch` and `WebFetch` are Anthropic **server-side** tools:
 * the model API executes them. Routed through the Fireworks gateway they don't
 * work (the gateway serves Fireworks models, not Anthropic's tool runtime), so
 * FireConnect disables them in `settings.json` via `permissions.deny` while a
 * harness is `on`. Bare tool names remove the tools from Claude's context
 * entirely — the strongest, docs-blessed deny form. The Fireworks-hosted
 * websearch MCP (installed separately in `~/.claude.json` when the account is
 * entitled) is the working replacement for web access.
 */
export const GATEWAY_DISABLED_SERVER_TOOLS = Object.freeze(["WebSearch", "WebFetch"]);

/**
 * Merge FireConnect's server-tool denials into `permissions.deny` without
 * disturbing the user's own allow/ask/deny rules. Idempotent: returns the same
 * object reference (so callers can skip the write) when nothing is missing.
 * Teardown is handled by the byte-for-byte settings snapshot restored on `off`,
 * which brings back the user's original `permissions` — so this only ever adds.
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function withGatewayServerToolsDenied(settings) {
  const existingPermissions = settings.permissions && typeof settings.permissions === "object"
    ? settings.permissions
    : null;
  const existingDeny = Array.isArray(existingPermissions?.deny) ? existingPermissions.deny : [];
  const missing = GATEWAY_DISABLED_SERVER_TOOLS.filter((tool) => !existingDeny.includes(tool));
  if (missing.length === 0) {
    return settings;
  }
  return {
    ...settings,
    permissions: {
      ...(existingPermissions ?? {}),
      deny: [...existingDeny, ...missing],
    },
  };
}

/**
 * Remove only FireConnect's bare server-tool denies while reconstructing a
 * pre-v0.9 baseline without a permission-aware legacy backup.
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function withoutGatewayServerToolsDenied(settings) {
  const permissions = settings.permissions;
  if (!permissions || typeof permissions !== "object" || !Array.isArray(permissions.deny)) {
    return settings;
  }
  const deny = permissions.deny.filter(
    (rule) => !GATEWAY_DISABLED_SERVER_TOOLS.includes(rule),
  );
  if (deny.length === permissions.deny.length) {
    return settings;
  }

  const nextPermissions = { ...permissions };
  if (deny.length > 0) {
    nextPermissions.deny = deny;
  } else {
    delete nextPermissions.deny;
  }
  const next = { ...settings };
  if (Object.keys(nextPermissions).length > 0) {
    next.permissions = nextPermissions;
  } else {
    delete next.permissions;
  }
  return next;
}
