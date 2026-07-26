import assert from "node:assert/strict";
import { test } from "node:test";

import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import {
  DESKTOP_GUARD_HOOK_MARKER,
  buildHookOutput,
  detectPoisonedDesktopSession,
  withDesktopGuardHook,
  withoutDesktopGuardHook,
} from "../../../lib/harnesses/claude/desktop-guard.mjs";

test("detects the Claude Desktop poisoned-env case", () => {
  const env = {
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_MODEL: "kimi-fast-latest",
  };
  assert.equal(detectPoisonedDesktopSession(env), true);
});

test("still detects legacy canonical Fireworks model refs", () => {
  const env = {
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  };
  assert.equal(detectPoisonedDesktopSession(env), true);
});

test("not poisoned when base URL is actually Fireworks", () => {
  const env = {
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
    ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
  };
  assert.equal(detectPoisonedDesktopSession(env), false);
});

test("not poisoned outside Claude Desktop", () => {
  const env = {
    CLAUDE_CODE_ENTRYPOINT: "cli",
    ANTHROPIC_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  };
  assert.equal(detectPoisonedDesktopSession(env), false);
});

test("not poisoned when model isn't a Fireworks id", () => {
  const env = {
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_MODEL: "claude-sonnet-5",
  };
  assert.equal(detectPoisonedDesktopSession(env), false);
});

test("checks subagent + all alias slots, not just main", () => {
  const env = {
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_MODEL: "claude-sonnet-5",
    CLAUDE_CODE_SUBAGENT_MODEL: "accounts/fireworks/models/deepseek-v4-flash",
  };
  assert.equal(detectPoisonedDesktopSession(env), true);
});

test("detects poisoned fable alias slot", () => {
  const env = {
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_MODEL: "claude-sonnet-5",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "accounts/fireworks/routers/glm-latest",
  };
  assert.equal(detectPoisonedDesktopSession(env), true);
});

test("buildHookOutput returns null when healthy", () => {
  assert.equal(buildHookOutput({ CLAUDE_CODE_ENTRYPOINT: "cli" }), null);
});

test("buildHookOutput emits additionalContext when poisoned", () => {
  const output = buildHookOutput({
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    ANTHROPIC_MODEL: "accounts/fireworks/routers/kimi-k2p7-code-fast",
  });
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /FireConnect warning/);
});

test("withDesktopGuardHook adds a SessionStart entry without touching other hooks", () => {
  const settings = {
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }],
    },
  };
  const next = withDesktopGuardHook(settings, "node guard.mjs");
  assert.equal(next.hooks.SessionStart.length, 2);
  assert.equal(next.hooks.Stop, settings.hooks.Stop);
  assert.ok(next.hooks.SessionStart.some((e) => e.hooks[0].command.includes(DESKTOP_GUARD_HOOK_MARKER) === false));
});

test("withDesktopGuardHook is idempotent (refreshes, doesn't duplicate)", () => {
  let settings = {};
  settings = withDesktopGuardHook(settings, "node /old/path/fireconnect-desktop-guard.mjs");
  settings = withDesktopGuardHook(settings, "node /new/path/fireconnect-desktop-guard.mjs");
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /\/new\/path\//);
});

test("withoutDesktopGuardHook removes only fireconnect's entry", () => {
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] },
        { matcher: "startup", hooks: [{ type: "command", command: "node fireconnect-desktop-guard.mjs" }] },
      ],
    },
  };
  const next = withoutDesktopGuardHook(settings);
  assert.equal(next.hooks.SessionStart.length, 1);
  assert.equal(next.hooks.SessionStart[0].hooks[0].command, "echo hi");
});

test("withoutDesktopGuardHook drops the hooks key entirely when nothing is left", () => {
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: "node fireconnect-desktop-guard.mjs" }] },
      ],
    },
  };
  const next = withoutDesktopGuardHook(settings);
  assert.equal(Object.hasOwn(next, "hooks"), false);
});

test("withoutDesktopGuardHook is a no-op when there's nothing to remove", () => {
  const settings = { env: { FOO: "bar" } };
  const next = withoutDesktopGuardHook(settings);
  assert.equal(next, settings);
});
