import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import {
  SHELL_HOOK_BEGIN,
  SHELL_HOOK_END,
  installShellEnvHook,
  resolveShellConfigPath,
} from "../../lib/io/shell-env-hook.mjs";
import {
  WEBSEARCH_MCP_SERVER_NAME,
  WEBSEARCH_MCP_URL,
  claudeJsonPath,
  disableWebsearchMcp,
  hasManagedWebsearchMcp,
} from "../../lib/system/websearch-mcp.mjs";

const TEST_KEY = "fw_test_key_12345";

function legacyWebsearchMcpEntry(apiKey = "") {
  const token = apiKey.trim();
  return {
    type: "http",
    url: WEBSEARCH_MCP_URL,
    headers: {
      Authorization: token
        ? `Bearer ${token}`
        : "Bearer ${FIREWORKS_API_KEY}",
    },
  };
}

describe("websearch-mcp", () => {
  it("removes the managed server from ~/.claude.json while preserving user MCPs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-mcp-"));
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({
        mcpServers: {
          "user-server": { type: "stdio", command: "echo" },
          [WEBSEARCH_MCP_SERVER_NAME]: legacyWebsearchMcpEntry(TEST_KEY),
        },
      }, null, 2)}\n`,
      "utf8",
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
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: legacyWebsearchMcpEntry(TEST_KEY) } }, null, 2)}\n`,
      "utf8",
    );

    await disableWebsearchMcp(home);
    const afterDisable = JSON.parse(await readFile(claudeJsonPath(home), "utf8"));
    assert.equal(Object.hasOwn(afterDisable, "mcpServers"), false);
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

  it("removes a leftover FIREWORKS shell hook when retiring the managed MCP", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-shell-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: legacyWebsearchMcpEntry(TEST_KEY) } }, null, 2)}\n`,
      "utf8",
    );
    await installShellEnvHook(home, { includeFireworks: true });
    assert.match(await readFile(resolveShellConfigPath(home), "utf8"), /export FIREWORKS_API_KEY=/);

    await disableWebsearchMcp(home);
    const shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.equal(shell.includes(SHELL_HOOK_BEGIN), false);
    assert.equal(shell.includes(SHELL_HOOK_END), false);
  });

  it("does not remove Codex Anthropic shell export when retiring websearch MCP", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-websearch-codex-hook-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    await writeFile(
      claudeJsonPath(home),
      `${JSON.stringify({ mcpServers: { [WEBSEARCH_MCP_SERVER_NAME]: legacyWebsearchMcpEntry(TEST_KEY) } }, null, 2)}\n`,
      "utf8",
    );
    await writeGlobalConfig(home, {
      anthropicApiKey: "sk-ant-stored",
      harnesses: { codex: { enabled: true } },
    });
    await installShellEnvHook(home, { includeFireworks: true, includeAnthropic: true });

    await disableWebsearchMcp(home);
    const shell = await readFile(resolveShellConfigPath(home), "utf8");
    assert.doesNotMatch(shell, /export FIREWORKS_API_KEY=/);
    assert.match(shell, /export ANTHROPIC_API_KEY=/);
  });
});
