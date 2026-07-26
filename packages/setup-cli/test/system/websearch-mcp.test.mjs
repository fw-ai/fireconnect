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

describe("websearch-mcp", () => {
  it("builds the Fireworks search MCP entry", () => {
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
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({
        mcpServers: {
          "user-server": { type: "stdio", command: "echo" },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const enabled = await enableWebsearchMcp(home);
    assert.equal(enabled.changed, true);
    const afterEnable = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(hasManagedWebsearchMcp(afterEnable), true);
    assert.equal(afterEnable.mcpServers["user-server"].command, "echo");
    assert.equal(afterEnable.mcpServers[WEBSEARCH_MCP_SERVER_NAME].url, WEBSEARCH_MCP_URL);

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
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry() } }, null, 2)}\n`,
      "utf8",
    );

    await disableWebsearchMcp(home);
    const afterDisable = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(Object.hasOwn(afterDisable, "mcpServers"), false);
  });

  it("is idempotent when the managed server is already present", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-idem-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await seedKeychainConfig(home, "fw_test_key_12345");
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry() } }, null, 2)}\n`,
      "utf8",
    );
    const result = await enableWebsearchMcp(home);
    assert.equal(result.changed, false);
    const shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.match(shell, /export FIREWORKS_API_KEY=/);
  });

  it("reconciles websearch and Codex exports without either consumer clobbering the other", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-codex-hook-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await seedKeychainConfig(home, "fw_test_key_12345");
    await writeGlobalConfig(home, {
      anthropicApiKey: "sk-ant-stored",
      harnesses: { codex: { enabled: true } },
    });

    await enableWebsearchMcp(home);
    let shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.match(shell, /export FIREWORKS_API_KEY=/);
    assert.match(shell, /export ANTHROPIC_API_KEY=/);

    await writeGlobalConfig(home, {
      harnesses: { codex: { enabled: false } },
    });
    await reconcileShellEnvHook(home);
    shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.match(shell, /export FIREWORKS_API_KEY=/);
    assert.doesNotMatch(shell, /export ANTHROPIC_API_KEY=/);

    await writeGlobalConfig(home, {
      harnesses: { codex: { enabled: true } },
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

  it("removes the shell hook on disable when no env-shell harnesses remain", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-shell-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await seedKeychainConfig(home, "fw_test_key_12345");
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry() } }, null, 2)}\n`,
      "utf8",
    );
    await enableWebsearchMcp(home);

    await disableWebsearchMcp(home);
    const shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.equal(shell.includes(SHELL_HOOK_BEGIN), false);
    assert.equal(shell.includes(SHELL_HOOK_END), false);
  });

  it("fail-closed sync removes a stale managed server when flag lookup is unavailable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-sync-"));
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: websearchMcpServerEntry() } }, null, 2)}\n`,
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
});
