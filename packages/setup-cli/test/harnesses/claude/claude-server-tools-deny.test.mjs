import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GATEWAY_DISABLED_SERVER_TOOLS,
  withGatewayServerToolsDenied,
} from "../../../lib/harnesses/claude/server-tools-deny.mjs";

describe("withGatewayServerToolsDenied", () => {
  it("denies WebSearch and WebFetch on settings with no permissions", () => {
    const next = withGatewayServerToolsDenied({ env: { X: "1" } });
    assert.deepEqual(next.permissions.deny, ["WebSearch", "WebFetch"]);
    // Other fields are preserved.
    assert.deepEqual(next.env, { X: "1" });
  });

  it("merges into an existing deny without disturbing allow/ask or other deny rules", () => {
    const next = withGatewayServerToolsDenied({
      permissions: { allow: ["Bash(ls:*)"], ask: ["Read(*)"], deny: ["Bash(rm:*)"] },
    });
    assert.deepEqual(next.permissions.deny, ["Bash(rm:*)", "WebSearch", "WebFetch"]);
    assert.deepEqual(next.permissions.allow, ["Bash(ls:*)"]);
    assert.deepEqual(next.permissions.ask, ["Read(*)"]);
  });

  it("is idempotent and returns the same reference when both tools are already denied", () => {
    const settings = { permissions: { deny: ["WebSearch", "WebFetch", "Bash(rm:*)"] } };
    assert.equal(withGatewayServerToolsDenied(settings), settings);
  });

  it("adds only the missing tool when one is already denied", () => {
    const next = withGatewayServerToolsDenied({ permissions: { deny: ["WebSearch"] } });
    assert.deepEqual(next.permissions.deny, ["WebSearch", "WebFetch"]);
  });

  it("uses bare tool names (removes the tools from Claude's context)", () => {
    assert.deepEqual([...GATEWAY_DISABLED_SERVER_TOOLS], ["WebSearch", "WebFetch"]);
  });
});
