import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FIREROUTER_BASE_URL,
  normalizeFirerouterUrl,
  resolveAnthropicKey,
  resolveHarnessOnAnthropicKey,
  buildClaudeCustomHeaders,
  buildFirerouterHttpHeaders,
  firerouterStatusFromEnv,
  isFirerouterBaseUrl,
  resolveFirerouterBaseUrl,
  MISSING_ANTHROPIC_KEY_MESSAGE,
} from "../lib/firerouter-core.mjs";
import { FIREWORKS_BASE_URL, providerStatusFromEnv } from "../lib/fireconnect-core.mjs";
import { writeGlobalConfig } from "../lib/global-config.mjs";
import {
  classifyClaudeCredentials,
  classifyOpencodeAnthropicEntry,
  claudeCredentialsPath,
  hasEnterpriseAnthropicCredentials,
  opencodeAuthPath,
  resolveEnterpriseAnthropicAuth,
  _setTestClaudeKeychainBlob,
} from "../lib/anthropic-enterprise.mjs";
import { HARNESS } from "../lib/harness.mjs";

describe("firerouter-core", () => {
  // Neutralize the macOS keychain so tests that don't explicitly test it
  // aren't affected by a real Claude Code keychain entry on the dev machine.
  // Keychain-specific tests override this with _setTestClaudeKeychainBlob.
  _setTestClaudeKeychainBlob("");

  it("detects FireRouter base URL", () => {
    assert.equal(isFirerouterBaseUrl(FIREROUTER_BASE_URL), true);
    assert.equal(isFirerouterBaseUrl("https://api.fireworks.ai/inference"), false);
    assert.equal(isFirerouterBaseUrl("https://firerouter.staging.example.com"), false);
  });

  it("does not infer router mode from stale headers on direct Fireworks URL", () => {
    const env = {
      ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
      ANTHROPIC_CUSTOM_HEADERS: "X-FireRouter-Fireworks-Key: fw_test",
    };
    assert.equal(firerouterStatusFromEnv(env), "other");
    assert.equal(providerStatusFromEnv(env), "fireworks");
  });

  it("detects custom router base URL from env URL and global config", () => {
    const customUrl = "https://router-dev.example.com";
    assert.equal(
      firerouterStatusFromEnv({ ANTHROPIC_BASE_URL: customUrl }, { routerBaseUrl: customUrl }),
      "firerouter",
    );
    assert.equal(
      firerouterStatusFromEnv({
        ANTHROPIC_BASE_URL: customUrl,
        ANTHROPIC_CUSTOM_HEADERS: "X-FireRouter-Fireworks-Key: fw_test",
      }, { routerBaseUrl: customUrl }),
      "firerouter",
    );
  });

  it("does not infer router mode from headers when routerBaseUrl is missing", () => {
    const customUrl = "https://router-dev.example.com";
    const env = {
      ANTHROPIC_BASE_URL: customUrl,
      ANTHROPIC_CUSTOM_HEADERS: "X-FireRouter-Fireworks-Key: fw_test",
    };
    assert.equal(firerouterStatusFromEnv(env, { routerBaseUrl: "" }), "other");
  });

  it("falls back to stored router base URL when flag is omitted", () => {
    assert.equal(
      resolveFirerouterBaseUrl("", "https://router-dev.example.com"),
      "https://router-dev.example.com",
    );
  });

  it("defaults base URL to FIREROUTER_BASE_URL", () => {
    assert.equal(resolveFirerouterBaseUrl(""), FIREROUTER_BASE_URL);
    assert.equal(
      resolveFirerouterBaseUrl("https://api.fireworks.ai/inference"),
      FIREROUTER_BASE_URL,
    );
    assert.equal(
      resolveFirerouterBaseUrl("https://router-dev.example.com/"),
      "https://router-dev.example.com",
    );
    assert.equal(resolveFirerouterBaseUrl("router.fireworks.ai"), FIREROUTER_BASE_URL);
    assert.equal(normalizeFirerouterUrl("router.fireworks.ai"), FIREROUTER_BASE_URL);
    assert.equal(isFirerouterBaseUrl("router.fireworks.ai"), true);
  });

  it("builds Claude custom headers", () => {
    const headers = buildClaudeCustomHeaders({
      fireworksKey: "fw_test",
    });
    assert.equal(headers, "X-FireRouter-Fireworks-Key: fw_test");
  });

  it("builds HTTP headers for other harnesses", () => {
    const headers = buildFirerouterHttpHeaders({
      fireworksKey: "fw_test",
      anthropicKey: "sk-ant-test",
    });
    assert.equal(headers["x-api-key"], "sk-ant-test");
    assert.equal(headers["X-FireRouter-Fireworks-Key"], "fw_test");
  });

  it("resolves Anthropic key: flag beats global/env, else global, else settings", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env-12345";
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-anthropic-resolve-"));
      await writeGlobalConfig(home, {
        anthropicApiKey: "sk-ant-from-global-12345",
        harnesses: {},
      });

      assert.equal(await resolveAnthropicKey({ home }), "sk-ant-from-global-12345");
      assert.equal(
        await resolveAnthropicKey({
          apiKey: "sk-ant-from-flag-12345",
          home,
        }),
        "sk-ant-from-flag-12345",
      );
      assert.equal(
        await resolveAnthropicKey({ apiKey: "sk-ant-flag-only-12345" }),
        "sk-ant-flag-only-12345",
      );
      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(
        await resolveAnthropicKey({
          settingsEnv: { ANTHROPIC_AUTH_TOKEN: "sk-ant-settings" },
        }),
        "sk-ant-settings",
      );
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("resolveHarnessOnAnthropicKey requires an Anthropic-shaped key", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(
        () => resolveHarnessOnAnthropicKey({ home: "" }),
        (error) => error.message === MISSING_ANTHROPIC_KEY_MESSAGE,
      );
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-anthropic-harness-"));
      await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-from-global-12345", harnesses: {} });
      const resolved = await resolveHarnessOnAnthropicKey({ home });
      assert.equal(resolved.anthropicKey, "sk-ant-from-global-12345");
      assert.equal(resolved.anthropicKeyFromFlag, true);
      assert.equal(resolved.source, "global-literal");
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("classifyOpencodeAnthropicEntry rejects empty or tokenless entries", () => {
    assert.equal(classifyOpencodeAnthropicEntry({}), "none");
    assert.equal(classifyOpencodeAnthropicEntry({ type: "oauth" }), "none");
    assert.equal(classifyOpencodeAnthropicEntry({ type: "api", key: "not-anthropic" }), "none");
    assert.equal(
      classifyOpencodeAnthropicEntry({ type: "oauth", access: "token" }),
      "oauth",
    );
    assert.equal(
      classifyOpencodeAnthropicEntry({ type: "api", key: "sk-ant-from-opencode-auth" }),
      "api-key",
    );
  });

  it("classifyClaudeCredentials requires OAuth token material", () => {
    assert.equal(classifyClaudeCredentials({}), "none");
    assert.equal(classifyClaudeCredentials({ claudeAiOauth: {} }), "none");
    assert.equal(
      classifyClaudeCredentials({ claudeAiOauth: { accessToken: "enterprise-token" } }),
      "oauth",
    );
  });

  it("resolveHarnessOnAnthropicKey accepts enterprise Claude credentials", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-enterprise-claude-"));
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await writeFile(
        claudeCredentialsPath(home),
        JSON.stringify({ claudeAiOauth: { accessToken: "enterprise-token" } }),
      );

      const resolved = await resolveHarnessOnAnthropicKey({
        home,
        harness: HARNESS.CLAUDE,
      });
      assert.equal(resolved.anthropicKey, "");
      assert.equal(resolved.enterpriseAuth, true);
      assert.equal(resolved.source, "claude-credentials");
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("resolveHarnessOnAnthropicKey defers to OpenCode auth.json without copying API keys", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-auth-"));
      await mkdir(path.dirname(opencodeAuthPath(home)), { recursive: true });
      await writeFile(
        opencodeAuthPath(home),
        JSON.stringify({ anthropic: { type: "api", key: "sk-ant-from-opencode-auth" } }),
      );

      const resolved = await resolveHarnessOnAnthropicKey({
        home,
        harness: HARNESS.OPENCODE,
      });
      assert.equal(resolved.anthropicKey, "");
      assert.equal(resolved.source, "opencode-auth");
      assert.equal(resolved.runtimeAuth, true);
      assert.equal(resolved.enterpriseAuth, false);
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("hasEnterpriseAnthropicCredentials treats OpenCode auth.json OAuth as runtime auth, not enterprise", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-oauth-"));
    await mkdir(path.dirname(opencodeAuthPath(home)), { recursive: true });
    await writeFile(
      opencodeAuthPath(home),
      JSON.stringify({ anthropic: { type: "oauth", access: "token" } }),
    );
    assert.equal(await hasEnterpriseAnthropicCredentials(home, HARNESS.OPENCODE), false);
    assert.equal(await hasEnterpriseAnthropicCredentials(home, HARNESS.CLAUDE), false);
  });

  it("resolveHarnessOnAnthropicKey ignores OpenCode auth.json for Claude", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-ignore-opencode-auth-"));
      await mkdir(path.dirname(opencodeAuthPath(home)), { recursive: true });
      await writeFile(
        opencodeAuthPath(home),
        JSON.stringify({ anthropic: { type: "api", key: "sk-ant-from-opencode-only" } }),
      );
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await writeFile(claudeCredentialsPath(home), JSON.stringify({
        claudeAiOauth: { accessToken: "enterprise-token" },
      }));

      const resolved = await resolveHarnessOnAnthropicKey({
        home,
        harness: HARNESS.CLAUDE,
      });
      assert.equal(resolved.anthropicKey, "");
      assert.equal(resolved.enterpriseAuth, true);
      assert.equal(resolved.source, "claude-credentials");
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("hasEnterpriseAnthropicCredentials ignores empty Claude credentials for OpenCode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-no-claude-enterprise-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(claudeCredentialsPath(home), "{}");
    assert.equal(await hasEnterpriseAnthropicCredentials(home, HARNESS.OPENCODE), false);
  });

  it("resolveEnterpriseAnthropicAuth accepts Claude OAuth for OpenCode when auth.json is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-claude-oauth-fallback-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      claudeCredentialsPath(home),
      JSON.stringify({ claudeAiOauth: { accessToken: "enterprise-token" } }),
    );
    const resolved = await resolveEnterpriseAnthropicAuth(home, HARNESS.OPENCODE);
    assert.equal(resolved.enterpriseAuth, true);
    assert.equal(resolved.source, "claude-credentials");
  });

  it("resolveHarnessOnAnthropicKey rejects empty Claude credentials", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-empty-creds-"));
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await writeFile(claudeCredentialsPath(home), "{}");

      await assert.rejects(
        () => resolveHarnessOnAnthropicKey({ home, harness: HARNESS.CLAUDE }),
        (error) => error.message === MISSING_ANTHROPIC_KEY_MESSAGE,
      );
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("resolveHarnessOnAnthropicKey uses macOS keychain when credentials file is absent", async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _setTestClaudeKeychainBlob(JSON.stringify({
      claudeAiOauth: { accessToken: "enterprise-keychain-token" },
    }));
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-keychain-"));
      await mkdir(path.join(home, ".claude"), { recursive: true });

      const resolved = await resolveHarnessOnAnthropicKey({
        home,
        harness: HARNESS.CLAUDE,
      });
      assert.equal(resolved.anthropicKey, "");
      assert.equal(resolved.enterpriseAuth, true);
      assert.equal(resolved.source, "claude-keychain");
    } finally {
      _setTestClaudeKeychainBlob("");
      if (savedAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedAnthropic;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("credentials file takes priority over keychain", async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _setTestClaudeKeychainBlob(JSON.stringify({
      claudeAiOauth: { accessToken: "keychain-token" },
    }));
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-file-over-keychain-"));
      await mkdir(path.join(home, ".claude"), { recursive: true });
      await writeFile(
        claudeCredentialsPath(home),
        JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }),
      );

      const resolved = await resolveHarnessOnAnthropicKey({
        home,
        harness: HARNESS.CLAUDE,
      });
      assert.equal(resolved.enterpriseAuth, true);
      assert.equal(resolved.source, "claude-credentials");
    } finally {
      _setTestClaudeKeychainBlob("");
      if (savedAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedAnthropic;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("keychain with empty OAuth material does not count as enterprise auth", async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    _setTestClaudeKeychainBlob(JSON.stringify({
      claudeAiOauth: {},
    }));
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-claude-keychain-empty-oauth-"));
      await mkdir(path.join(home, ".claude"), { recursive: true });

      await assert.rejects(
        () => resolveHarnessOnAnthropicKey({ home, harness: HARNESS.CLAUDE }),
        (error) => error.message === MISSING_ANTHROPIC_KEY_MESSAGE,
      );
    } finally {
      _setTestClaudeKeychainBlob("");
      if (savedAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = savedAnthropic;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });
});
