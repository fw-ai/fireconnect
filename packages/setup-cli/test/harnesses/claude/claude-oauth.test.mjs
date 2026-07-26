import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  hasClaudeOAuthCredentials,
  hasClaudeOAuthTokenMaterial,
} from "../../../lib/harnesses/claude/oauth.mjs";
import { withTempHome } from "../../helpers.mjs";

describe("Claude OAuth detection", () => {
  it("recognizes supported credential shapes with token material", () => {
    assert.equal(hasClaudeOAuthTokenMaterial({
      claudeAiOauth: { accessToken: "oauth-access" },
    }), true);
    assert.equal(hasClaudeOAuthTokenMaterial({
      oauth: { refresh_token: "oauth-refresh" },
    }), true);
    assert.equal(hasClaudeOAuthTokenMaterial({
      anthropic: { token: "oauth-token" },
    }), true);
    assert.equal(hasClaudeOAuthTokenMaterial({
      claudeAiOauth: { accessToken: "  ", refreshToken: "" },
    }), false);
    assert.equal(hasClaudeOAuthTokenMaterial({ claudeAiOauth: {} }), false);
  });

  it("reads OAuth credentials next to Claude settings", async () => {
    await withTempHome("claude-oauth-file", async (home) => {
      const claudeDir = path.join(home, ".claude");
      const settingsPath = path.join(claudeDir, "settings.json");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access",
          refreshToken: "oauth-refresh",
        },
      }));

      assert.equal(await hasClaudeOAuthCredentials({
        home,
        settingsPath,
        platform: "linux",
      }), true);
    });
  });

  it("falls back to the Claude Code macOS keychain entry", async () => {
    await withTempHome("claude-oauth-keychain", async (home) => {
      const found = await hasClaudeOAuthCredentials({
        home,
        settingsPath: path.join(home, ".claude", "settings.json"),
        platform: "darwin",
        readKeychainCredentials: () => ({
          claudeAiOauth: { refreshToken: "keychain-refresh" },
        }),
      });

      assert.equal(found, true);
    });
  });

  it("does not treat empty credentials as OAuth", async () => {
    await withTempHome("claude-oauth-empty", async (home) => {
      let queriedKeychain = false;
      const found = await hasClaudeOAuthCredentials({
        home,
        settingsPath: path.join(home, ".claude", "settings.json"),
        platform: "linux",
        readKeychainCredentials: () => {
          queriedKeychain = true;
          return { claudeAiOauth: { accessToken: "unexpected" } };
        },
      });

      assert.equal(found, false);
      assert.equal(queriedKeychain, false);
    });
  });
});
