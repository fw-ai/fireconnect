import assert from "node:assert/strict";
import process from "node:process";
import { afterEach, describe, it } from "node:test";

import {
  finalizeClaudeOnOutcome,
} from "../../lib/cli/commands/harness.mjs";

describe("Claude on cancellation", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("exits non-zero without persisting deferred credentials", async () => {
    const persisted = [];
    const succeeded = await finalizeClaudeOnOutcome(
      { cancelled: true },
      {
        persistFireworksKey: () => persisted.push("fireworks"),
        persistAnthropicKey: () => persisted.push("anthropic"),
      },
    );

    assert.equal(succeeded, false);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(persisted, []);
  });

  it("persists deferred credentials after successful activation", async () => {
    const persisted = [];
    const succeeded = await finalizeClaudeOnOutcome(
      undefined,
      {
        persistFireworksKey: () => persisted.push("fireworks"),
        persistAnthropicKey: () => persisted.push("anthropic"),
      },
    );

    assert.equal(succeeded, true);
    assert.deepEqual(persisted, ["fireworks", "anthropic"]);
  });
});
