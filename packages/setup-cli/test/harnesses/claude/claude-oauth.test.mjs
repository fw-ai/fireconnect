import assert from "node:assert/strict";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  hasClaudeOAuthCredentials,
  hasClaudeOAuthTokenMaterial,
  readClaudeOAuthCredentials,
  writeClaudeOAuthCredentialsToDir,
  CLAUDE_CREDENTIALS_FILENAME,
} from "../../../lib/harnesses/claude/oauth.mjs";
import { readJsonIfExists } from "../../../lib/io/json.mjs";
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

  it("readClaudeOAuthCredentials returns the on-disk blob", async () => {
    await withTempHome("claude-oauth-read", async (home) => {
      const claudeDir = path.join(home, ".claude");
      const settingsPath = path.join(claudeDir, "settings.json");
      const blob = {
        claudeAiOauth: {
          accessToken: "oauth-access",
          refreshToken: "oauth-refresh",
        },
      };
      await mkdir(claudeDir, { recursive: true });
      await writeFile(path.join(claudeDir, CLAUDE_CREDENTIALS_FILENAME), JSON.stringify(blob));

      assert.deepEqual(await readClaudeOAuthCredentials({
        home,
        settingsPath,
        platform: "linux",
      }), blob);
    });
  });

  it("writeClaudeOAuthCredentialsToDir seeds an isolated config dir", async () => {
    await withTempHome("claude-oauth-seed", async (home) => {
      const configDir = path.join(home, "isolated-claude");
      const blob = { claudeAiOauth: { accessToken: "seeded" } };
      await writeClaudeOAuthCredentialsToDir({ configDir, credentials: blob });
      assert.deepEqual(
        await readJsonIfExists(path.join(configDir, CLAUDE_CREDENTIALS_FILENAME)),
        blob,
      );
      const dirMode = (await stat(configDir)).mode & 0o777;
      const fileMode = (await stat(path.join(configDir, CLAUDE_CREDENTIALS_FILENAME))).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
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
