import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HARNESS } from "../../lib/harness/id.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import {
  SHELL_HOOK_BEGIN,
  SHELL_HOOK_END,
  installShellEnvHook,
  reconcileShellEnvHook,
  resolveShellConfigPath,
} from "../../lib/io/shell-env-hook.mjs";
import { seedKeychainConfig } from "../helpers.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  WEBSEARCH_MCP_URL,
  claudeJsonPath,
  disableWebsearchMcp,
  enableWebsearchMcp,
  hasManagedWebsearchMcp,
  syncWebsearchMcp,
  websearchMcpServerEntry,
} from "../../lib/system/websearch-mcp.mjs";

const TEST_KEY = "fw_test_key_12345";

describe("websearch-mcp", () => {
  it("builds a baked Bearer token MCP entry (same as claude mcp add --header)", () => {
    assert.deepEqual(websearchMcpServerEntry(TEST_KEY), {
      type: "http",
      url: WEBSEARCH_MCP_URL,
      headers: {
        Authorization: `Bearer ${TEST_KEY}`,
      },
    });
  });

  it("falls back to ${FIREWORKS_API_KEY} only when no key is provided", () => {
    assert.deepEqual(websearchMcpServerEntry(), {
      type: "http",
      url: WEBSEARCH_MCP_URL,
      headers: {
        Authorization: "Bearer ${FIREWORKS_API_KEY}",
      },
    });
  });

  it("enables and disables the managed server in ~/.claude.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-mcp-"));
    await seedKeychainConfig(home, TEST_KEY);
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({
        mcpServers: {
          "user-server": { type: "stdio", command: "echo" },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const enabled = await enableWebsearchMcp(home, HARNESS.CLAUDE, { apiKey: TEST_KEY });
    assert.equal(enabled.changed, true);
    const afterEnable = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(hasManagedWebsearchMcp(afterEnable), true);
    assert.equal(afterEnable.mcpServers["user-server"].command, "echo");
    assert.equal(afterEnable.mcpServers[WEBSEARCH_MCP_SERVER_NAME].url, WEBSEARCH_MCP_URL);
    assert.equal(
      afterEnable.mcpServers[WEBSEARCH_MCP_SERVER_NAME].headers.Authorization,
      `Bearer ${TEST_KEY}`,
    );

    const disabled = await disableWebsearchMcp(home);
    assert.equal(disabled.changed, true);
    const afterDisable = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(hasManagedWebsearchMcp(afterDisable), false);
    assert.equal(afterDisable.mcpServers["user-server"].command, "echo");
  });

  it("removes mcpServers when the managed entry was the only server", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-only-"));
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry(TEST_KEY) } }, null, 2)}\n`,
      "utf8",
    );

    await disableWebsearchMcp(home);
    const afterDisable = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(Object.hasOwn(afterDisable, "mcpServers"), false);
  });

  it("is idempotent when the same baked entry is already present", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-idem-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await seedKeychainConfig(home, TEST_KEY);
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry(TEST_KEY) } }, null, 2)}\n`,
      "utf8",
    );
    const result = await enableWebsearchMcp(home, HARNESS.CLAUDE, { apiKey: TEST_KEY });
    assert.equal(result.changed, false);
    // Baked auth: no FIREWORKS_API_KEY shell hook.
    const shellPath = resolveShellConfigPath(home);
    try {
      const shell = await readFile(shellPath, "utf8");
      assert.doesNotMatch(shell, /export FIREWORKS_API_KEY=/);
    } catch (error) {
      assert.equal(error.code, "ENOENT");
    }
  });

  it("rebakes a legacy ${FIREWORKS_API_KEY} entry to a literal Bearer token", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-rebake-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await seedKeychainConfig(home, TEST_KEY);
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry() } }, null, 2)}\n`,
      "utf8",
    );
    const result = await enableWebsearchMcp(home, HARNESS.CLAUDE, { apiKey: TEST_KEY });
    assert.equal(result.changed, true);
    const after = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(
      after.mcpServers[WEBSEARCH_MCP_SERVER_NAME].headers.Authorization,
      `Bearer ${TEST_KEY}`,
    );
  });

  it("does not install a FIREWORKS shell hook for websearch; Codex Anthropic export is independent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-codex-hook-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await seedKeychainConfig(home, TEST_KEY);
    await writeGlobalConfig(home, {
      anthropicApiKey: "sk-ant-stored",
      harnesses: { codex: { enabled: true } },
    });

    await enableWebsearchMcp(home, HARNESS.CLAUDE, { apiKey: TEST_KEY });
    let shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.doesNotMatch(shell, /export FIREWORKS_API_KEY=/);
    assert.match(shell, /export ANTHROPIC_API_KEY=/);

    await writeGlobalConfig(home, {
      harnesses: { codex: { enabled: false } },
    });
    await reconcileShellEnvHook(home);
    try {
      shell = await readFile(resolveShellConfigPath(home), "utf8");
      assert.doesNotMatch(shell, /export FIREWORKS_API_KEY=/);
      assert.doesNotMatch(shell, /export ANTHROPIC_API_KEY=/);
    } catch (error) {
      assert.equal(error.code, "ENOENT");
    }

    await writeGlobalConfig(home, {
      harnesses: { codex: { enabled: true } },
      anthropicApiKey: "sk-ant-stored",
    });
    await disableWebsearchMcp(home);
    shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.doesNotMatch(shell, /export FIREWORKS_API_KEY=/);
    assert.match(shell, /export ANTHROPIC_API_KEY=/);
  });

  it("disable is idempotent when the managed server is absent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-disable-idem-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await installShellEnvHook(home);
    const result = await disableWebsearchMcp(home);
    assert.equal(result.changed, false);
    const shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.doesNotMatch(shell, new RegExp(SHELL_HOOK_BEGIN));
  });

  it("removes a leftover FIREWORKS shell hook on enable/disable after baking", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-shell-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await seedKeychainConfig(home, TEST_KEY);
    await installShellEnvHook(home, { includeFireworks: true });
    assert.match(await readFile(resolveShellConfigPath(home), "utf8"), /export FIREWORKS_API_KEY=/);

    await enableWebsearchMcp(home, HARNESS.CLAUDE, { apiKey: TEST_KEY });
    let shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.equal(shell.includes(SHELL_HOOK_BEGIN), false);
    assert.equal(shell.includes(SHELL_HOOK_END), false);

    await disableWebsearchMcp(home);
    shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.equal(shell.includes(SHELL_HOOK_BEGIN), false);
  });

  it("fail-closed sync removes a stale managed server when flag lookup is unavailable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-sync-"));
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry(TEST_KEY) } }, null, 2)}\n`,
      "utf8",
    );

    const originalFetch = globalThis.fetch;
    const originalGrpcUrl = process.env.FIRECONNECT_GATEWAY_GRPC_WEB_URL;
    process.env.FIRECONNECT_GATEWAY_GRPC_WEB_URL = "http://127.0.0.1:1";
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    try {
      const result = await syncWebsearchMcp(home, {
        harnessId: HARNESS.CLAUDE,
        apiKey: "fw_test",
        accountId: "accounts/acme",
        quiet: true,
      });
      assert.equal(result.installed, false);
      const config = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
      assert.equal(hasManagedWebsearchMcp(config), false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalGrpcUrl === undefined) {
        delete process.env.FIRECONNECT_GATEWAY_GRPC_WEB_URL;
      } else {
        process.env.FIRECONNECT_GATEWAY_GRPC_WEB_URL = originalGrpcUrl;
      }
    }
  });

  it("refreshWebsearchMcpAuth rebakes legacy env-ref without requiring feature-flag sync", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-refresh-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry() } }, null, 2)}\n`,
      "utf8",
    );

    const { refreshWebsearchMcpAuth } = await import("../../lib/system/websearch-mcp.mjs");
    assert.equal(await refreshWebsearchMcpAuth(home, TEST_KEY), true);
    const after = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(
      after.mcpServers[WEBSEARCH_MCP_SERVER_NAME].headers.Authorization,
      `Bearer ${TEST_KEY}`,
    );
    assert.equal(await refreshWebsearchMcpAuth(home, TEST_KEY), false);
  });

  it("refreshWebsearchMcpAuth is a no-op when managed MCP is absent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-refresh-absent-"));
    const { refreshWebsearchMcpAuth } = await import("../../lib/system/websearch-mcp.mjs");
    assert.equal(await refreshWebsearchMcpAuth(home, TEST_KEY), false);
  });
});
