import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GATEWAY_DISABLED_SERVER_TOOLS,
  reconcileGatewayServerToolDenials,
} from "../../../lib/harnesses/claude/server-tools-deny.mjs";

describe("reconcileGatewayServerToolDenials", () => {
  it("leaves settings unchanged when no legacy denials exist", () => {
    const settings = { env: { X: "1" } };
    assert.equal(reconcileGatewayServerToolDenials(settings), settings);
  });

  it("leaves unrelated permission rules unchanged", () => {
    const settings = {
      permissions: { allow: ["Bash(ls:*)"], ask: ["Read(*)"], deny: ["Bash(rm:*)"] },
    };
    assert.equal(reconcileGatewayServerToolDenials(settings), settings);
  });

  it("removes legacy FireConnect WebSearch and WebFetch denials", () => {
    const next = reconcileGatewayServerToolDenials({
      permissions: { deny: ["Bash(rm:*)", "WebSearch", "WebFetch"] },
    });
    assert.deepEqual(next.permissions.deny, ["Bash(rm:*)"]);
  });

  it("preserves explicit user server-tool denials", () => {
    const next = reconcileGatewayServerToolDenials(
      { permissions: { deny: ["WebSearch", "WebFetch"] } },
      { preserveDeniedTools: ["WebSearch", "WebFetch"] },
    );
    assert.deepEqual(next.permissions.deny, ["WebSearch", "WebFetch"]);
  });

  it("does not disable native server tools", () => {
    assert.deepEqual([...GATEWAY_DISABLED_SERVER_TOOLS], []);
  });
});
