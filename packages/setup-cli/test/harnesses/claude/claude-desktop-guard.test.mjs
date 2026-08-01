import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DESKTOP_GUARD_HOOK_MARKER,
  withoutDesktopGuardHook,
} from "../../../lib/harnesses/claude/desktop-guard.mjs";

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
        { matcher: "startup", hooks: [{ type: "command", command: `node /path/${DESKTOP_GUARD_HOOK_MARKER}` }] },
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
