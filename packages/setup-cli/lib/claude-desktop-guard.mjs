import { FIREWORKS_BASE_URL } from "./fireconnect-core.mjs";

/** Marker so fireconnect can find/remove its own SessionStart hook entry. */
export const DESKTOP_GUARD_HOOK_MARKER = "fireconnect-desktop-guard.mjs";

function isOwnHookEntry(entry) {
  return typeof entry?.hooks?.[0]?.command === "string"
    && entry.hooks[0].command.includes(DESKTOP_GUARD_HOOK_MARKER);
}

/**
 * Add (or refresh) fireconnect's SessionStart guard hook without disturbing
 * any other hooks the user or another tool has configured.
 * @param {Record<string, unknown>} settings
 * @param {string} command
 */
export function withDesktopGuardHook(settings, command) {
  const hooks = settings.hooks ?? {};
  const sessionStart = (hooks.SessionStart ?? []).filter((entry) => !isOwnHookEntry(entry));
  sessionStart.push({
    matcher: "startup",
    hooks: [{ type: "command", command }],
  });
  return {
    ...settings,
    hooks: { ...hooks, SessionStart: sessionStart },
  };
}

/**
 * Remove fireconnect's SessionStart guard hook, leaving other hooks intact.
 * @param {Record<string, unknown>} settings
 */
export function withoutDesktopGuardHook(settings) {
  const hooks = settings.hooks;
  if (!hooks?.SessionStart) {
    return settings;
  }
  const sessionStart = hooks.SessionStart.filter((entry) => !isOwnHookEntry(entry));
  const nextHooks = { ...hooks, SessionStart: sessionStart };
  if (sessionStart.length === 0) {
    delete nextHooks.SessionStart;
  }
  if (Object.keys(nextHooks).length === 0) {
    const next = { ...settings };
    delete next.hooks;
    return next;
  }
  return { ...settings, hooks: nextHooks };
}

/**
 * Detect the Claude Desktop half-applied-env failure mode: Desktop forwards
 * ANTHROPIC_MODEL/ANTHROPIC_DEFAULT_*_MODEL/CLAUDE_CODE_SUBAGENT_MODEL but not
 * ANTHROPIC_BASE_URL, so a Fireworks model id ends up sent to Anthropic's API
 * (hard failures + silent billing to the user's Anthropic account).
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function detectPoisonedDesktopSession(env) {
  const isDesktop = env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop";
  const modelLooksFireworks = [
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    env.CLAUDE_CODE_SUBAGENT_MODEL,
  ].some((value) => typeof value === "string" && value.includes("fireworks"));
  const baseUrlIsFireworks = env.ANTHROPIC_BASE_URL === FIREWORKS_BASE_URL;

  return isDesktop && modelLooksFireworks && !baseUrlIsFireworks;
}

export const DESKTOP_GUARD_WARNING = [
  "FireConnect warning: this Claude Desktop session is misconfigured.",
  "Model settings point at Fireworks, but requests are going to api.anthropic.com —",
  "subagents and the permission classifier will fail, and any traffic that does succeed",
  "bills your Anthropic account instead of Fireworks. Run `fireconnect claude off` and",
  "fully restart Claude Desktop, or use the fireconnect-configured harness from a terminal instead.",
].join(" ");

/**
 * Entry point for the SessionStart hook fireconnect installs. Reads env from
 * the current process (inherited from the Claude Code process that spawned
 * this hook) and, if poisoned, emits additionalContext so the warning reaches
 * the assistant (and, by extension, the user) at the start of the session.
 * @param {NodeJS.ProcessEnv} env
 */
export function buildHookOutput(env) {
  if (!detectPoisonedDesktopSession(env)) {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: DESKTOP_GUARD_WARNING,
    },
  };
}
