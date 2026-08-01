import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { FILE_CONFIG_HARNESS_IDS } from "../../lib/harness/id.mjs";
import {
  installShellEnvHook,
  reconcileShellEnvHook,
  removeShellEnvHook,
  shellHookBlock,
  stripShellHookBlock,
} from "../../lib/io/shell-env-hook.mjs";
import { seedKeychainConfig } from "../helpers.mjs";

describe("shell-env-hook", () => {
  it("installs and removes a marked block idempotently", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-hook-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      const firstPath = await installShellEnvHook(home);
      const secondPath = await installShellEnvHook(home);
      assert.equal(firstPath, secondPath);

      const raw = await readFile(path.join(home, ".zshrc"), "utf8");
      assert.match(raw, /# >>> fireconnect >>>/);
      assert.match(raw, /export FIREWORKS_API_KEY="\$\(/);
      assert.equal((raw.match(/# >>> fireconnect >>>/g) ?? []).length, 1);

      assert.equal(await removeShellEnvHook(home), true);
      assert.doesNotMatch(await readFile(path.join(home, ".zshrc"), "utf8"), /fireconnect/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("stripShellHookBlock removes only the marked region", () => {
    const raw = [
      "export PATH=/usr/bin",
      shellHookBlock("/tmp/home").trimEnd(),
      "alias ll='ls -la'",
    ].join("\n");
    const stripped = stripShellHookBlock(raw);
    assert.match(stripped, /export PATH/);
    assert.match(stripped, /alias ll/);
    assert.doesNotMatch(stripped, /fireconnect/);
  });

  it("reconcileShellEnvHook does not install FIREWORKS export for websearch MCP", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-sync-on-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      const { writeFile } = await import("node:fs/promises");
      const { claudeJsonPath } = await import("../../lib/system/websearch-state.mjs");
      const { WEBSEARCH_MCP_SERVER_NAME } = await import("../../lib/system/websearch-state.mjs");
      await writeFile(
        claudeJsonPath(home),
        `${JSON.stringify({
          mcpServers: {
            [WEBSEARCH_MCP_SERVER_NAME]: {
              type: "http",
              url: "https://mcp.fireworks.ai/work/mcp",
              headers: { Authorization: "Bearer fw_test_key_12345" },
            },
          },
        }, null, 2)}\n`,
      );
      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        harnesses: { claude: { enabled: true } },
      });

      assert.equal(await reconcileShellEnvHook(home), null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exports a configured Anthropic key for Codex BYOK", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-anthropic-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        anthropicApiKey: "sk-ant-stored",
        harnesses: { codex: { enabled: true } },
      });

      const shellPath = await reconcileShellEnvHook(home);
      const raw = await readFile(shellPath, "utf8");
      assert.match(raw, /export ANTHROPIC_API_KEY="\$\(/);
      assert.match(raw, /key export --stored-only --anthropic/);
      assert.doesNotMatch(raw, /sk-ant-stored/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reconcileShellEnvHook skips FIREWORKS export for legacy env-ref harness configs alone", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-legacy-envref-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      const { opencodeConfigPath } = await import("../../lib/harnesses/opencode/core.mjs");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.dirname(opencodeConfigPath(home, "")), { recursive: true });
      await writeFile(
        opencodeConfigPath(home, ""),
        `${JSON.stringify({
          model: "fireworks-ai/accounts/fireworks/models/glm-4p6",
          provider: {
            "fireworks-ai": {
              options: { apiKey: "{env:FIREWORKS_API_KEY}" },
              models: {},
            },
          },
        }, null, 2)}\n`,
      );
      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        harnesses: { opencode: { enabled: true } },
      });

      assert.equal(await reconcileShellEnvHook(home), null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reconcileShellEnvHook skips FIREWORKS export for websearch MCP with legacy global env-ref", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-websearch-envref-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      const { writeFile } = await import("node:fs/promises");
      const { claudeJsonPath, WEBSEARCH_MCP_SERVER_NAME } = await import("../../lib/system/websearch-state.mjs");
      await writeFile(
        claudeJsonPath(home),
        `${JSON.stringify({
          mcpServers: {
            [WEBSEARCH_MCP_SERVER_NAME]: {
              type: "http",
              url: "https://mcp.fireworks.ai/work/mcp",
              headers: { Authorization: "Bearer fw_test_key_12345" },
            },
          },
        }, null, 2)}\n`,
      );
      await writeGlobalConfig(home, {
        apiKey: "{env:FIREWORKS_API_KEY}",
        harnesses: { claude: { enabled: true } },
      });

      assert.equal(await reconcileShellEnvHook(home), null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reconcileShellEnvHook removes the hook when no consumer remains", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-sync-off-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        harnesses: Object.fromEntries(
          FILE_CONFIG_HARNESS_IDS.map((id) => [id, { enabled: false }]),
        ),
      });
      await installShellEnvHook(home);

      assert.equal(await reconcileShellEnvHook(home), null);
      assert.doesNotMatch(await readFile(path.join(home, ".zshrc"), "utf8"), /fireconnect/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reconcileShellEnvHook keeps anthropic export when codex BYOK remains", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-shell-sync-off-refresh-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    try {
      await seedKeychainConfig(home, "fw_test_key_12345");
      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        anthropicApiKey: "sk-ant-stored",
        harnesses: {
          codex: { enabled: true },
          opencode: { enabled: true },
        },
      });
      await reconcileShellEnvHook(home);

      await writeGlobalConfig(home, {
        apiKey: "{keychain:fireworks-api-key}",
        anthropicApiKey: "sk-ant-stored",
        harnesses: {
          codex: { enabled: true },
          opencode: { enabled: false },
        },
      });
      assert.ok(await reconcileShellEnvHook(home));

      const raw = await readFile(path.join(home, ".zshrc"), "utf8");
      assert.doesNotMatch(raw, /export FIREWORKS_API_KEY=/);
      assert.match(raw, /export ANTHROPIC_API_KEY=/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
