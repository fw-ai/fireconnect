import assert from "node:assert/strict";
import { describe, test } from "node:test";

import claude from "../lib/harnesses/claude.mjs";
import opencode from "../lib/harnesses/opencode.mjs";
import { resolveFireworksApiKey } from "../lib/fireworks-models.mjs";
import {
  FW_CLAUDE_KEY,
  FW_OPENCODE_KEY,
  FPK_KEY,
  withTempHome,
  writeClaudeSettings,
  writeNativeAnthropicSettings,
  writeOpencodeConfig,
} from "./helpers.mjs";
import { OPENCODE_API_KEY_ENV_REF } from "../lib/opencode-core.mjs";

function harnessCtx(home) {
  return {
    home,
    settingsPath: "",
    configPath: "",
    dataDir: "",
    apiKey: "",
    apiKeyFromFlag: false,
    baseUrl: "",
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    subagent: "",
    slot: "",
    search: "",
    json: false,
    harnesses: "",
    apiKeyMode: "",
  };
}

describe("harness resolveKey", () => {
  test("claude returns harness-local Fireworks key", async () => {
    await withTempHome("claude-key", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const key = await claude.resolveKey(harnessCtx(home));
      assert.equal(key, FW_CLAUDE_KEY);
    });
  });

  test("claude skips non-Fireworks-shaped tokens", async () => {
    await withTempHome("claude-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const key = await claude.resolveKey(harnessCtx(home));
      assert.equal(key, "");
    });
  });

  test("opencode returns harness-local Fireworks key", async () => {
    await withTempHome("opencode-key", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const configPath = await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const key = await opencode.resolveKey(harnessCtx(home));
      assert.equal(key, FW_OPENCODE_KEY);
      assert.ok(configPath);
    });
  });

  test("opencode resolves env-ref to FIREWORKS_API_KEY", async () => {
    await withTempHome("opencode-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FPK_KEY;
      try {
        const key = await opencode.resolveKey(harnessCtx(home));
        assert.equal(key, FPK_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });
});

describe("resolveFireworksApiKey with harness resolveKey", () => {
  test("claude chain prefers harness-local key over env", async () => {
    await withTempHome("chain-claude-local", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      const ctx = harnessCtx(home);
      const resolved = await resolveFireworksApiKey({
        resolveKey: () => claude.resolveKey(ctx),
        home,
      });
      assert.equal(resolved, FPK_KEY);
    });
  });

  test("claude chain falls back to FIREWORKS_API_KEY env", async () => {
    await withTempHome("chain-claude-env", async (home) => {
      await writeNativeAnthropicSettings(home);
      const ctx = harnessCtx(home);
      const resolved = await resolveFireworksApiKey({
        resolveKey: () => claude.resolveKey(ctx),
        home,
        apiKey: "",
      });
      // resolveFireworksApiKey reads process.env.FIREWORKS_API_KEY last;
      // runCli clears it via NO_ENV_KEY but unit tests inherit shell env.
      // Pass explicit env via the test's expectation: empty harness key + no global config
      // means we need env set in process for this assertion.
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FW_CLAUDE_KEY;
      try {
        const key = await resolveFireworksApiKey({
          resolveKey: () => claude.resolveKey(ctx),
          home,
        });
        assert.equal(key, FW_CLAUDE_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("opencode chain ignores Claude settings", async () => {
    await withTempHome("chain-oc-only", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const ctx = harnessCtx(home);
      const resolved = await resolveFireworksApiKey({
        resolveKey: () => opencode.resolveKey(ctx),
        home,
      });
      assert.equal(resolved, FW_OPENCODE_KEY);
    });
  });
});
