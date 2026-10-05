import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { globalConfigPath } from "../../lib/config/global-config.mjs";
import { codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { runCli, withTempHome } from "../helpers.mjs";

describe("harness option validation", () => {
  const rejects = async (home, args, pattern) => {
    const result = await runCli(args, {
      home,
      env: {
        FIREWORKS_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    });
    assert.notEqual(result.code, 0, `${args.join(" ")} should fail`);
    assert.match(result.stderr, pattern);
  };

  it("rejects Azure and provider flags that the selected harness cannot apply", async () => {
    await withTempHome("option-azure-", async (home) => {
      await rejects(home, ["claude", "on", "--azure"], /Claude does not support Azure mode/);
      await rejects(home, ["pi", "on", "--provider", "azure"], /--provider is configure-only/);
      await rejects(
        home,
        ["codex", "on", "--base-url", "https://example.services.ai.azure.com"],
        /--base-url on this harness requires --azure/,
      );
    });
  });

  it("requires a firerouter target before accepting routing-only options", async () => {
    await withTempHome("option-firerouter-", async (home) => {
      // Claude's default `on` already lands on firerouter, so an explicit
      // `--model firerouter` is not required there — but an explicit
      // non-firerouter picker model still rejects the flag.
      await rejects(
        home,
        [
          "claude", "on",
          "--api-key", "fw_test_key_12345",
          "--model", "glm-latest",
          "--routing-preference", "balanced",
        ],
        /--routing-preference requires a Claude slot set to firerouter/,
      );
      await rejects(
        home,
        ["opencode", "on", "--routing-preference", "balanced"],
        /--routing-preference requires .*--model firerouter/,
      );
      await rejects(
        home,
        ["pi", "on", "--anthropic-api-key", "sk-ant-test"],
        /--anthropic-api-key requires .*--model firerouter/,
      );
    });
  });

  it("rejects BYOK flags a harness cannot forward", async () => {
    await withTempHome("option-firerouter-capability-", async (home) => {
      // Cursor can't forward local provider keys, so both BYOK flags stay
      // unsupported there even though bare firerouter itself now connects.
      await rejects(
        home,
        ["cursor", "on", "--model", "firerouter/kimi-k3", "--anthropic-api-key", "sk-ant-test"],
        /--anthropic-api-key is not supported by this harness/,
      );
      await rejects(
        home,
        ["cursor", "on", "--model", "firerouter/kimi-k3", "--openai-api-key", "sk-openai-test"],
        /--openai-api-key is not supported by this harness/,
      );
      await rejects(
        home,
        ["deepseek", "on", "--model", "firerouter", "--routing-preference", "balanced"],
        /--routing-preference is not supported/,
      );
    });
  });

  it("accepts --openai-api-key on codex firerouter on", async () => {
    await withTempHome("option-codex-openai-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const result = await runCli(
        [
          "codex", "on",
          "--api-key", "fw_test_key_12345",
          "--model", "firerouter",
          "--openai-api-key", "sk-proj-codex-flag-12345",
        ],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            SHELL: "/bin/bash",
            ZSH_VERSION: "",
            BASH_VERSION: "5",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /"x-openai-api-key" = "OPENAI_API_KEY"/);
      const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.equal(globalConfig.openaiApiKey, "sk-proj-codex-flag-12345");
    });
  });

  it("accepts --anthropic-api-key on codex firerouter on", async () => {
    await withTempHome("option-codex-anthropic-", async (home) => {
      await mkdir(path.join(home, ".codex"), { recursive: true });
      const result = await runCli(
        [
          "codex", "on",
          "--api-key", "fw_test_key_12345",
          "--model", "firerouter",
          "--anthropic-api-key", "sk-ant-codex-flag-12345",
        ],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            SHELL: "/bin/bash",
            ZSH_VERSION: "",
            BASH_VERSION: "5",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const config = await readFile(codexConfigPath(home), "utf8");
      assert.match(config, /env_http_headers = \{ "x-anthropic-api-key" = "ANTHROPIC_API_KEY" \}/);
      const globalConfig = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
      assert.equal(globalConfig.anthropicApiKey, "sk-ant-codex-flag-12345");
    });
  });

  it("accepts Claude FireRouter with routing preference and no Anthropic BYOK", async () => {
    await withTempHome("option-claude-firerouter-", async (home) => {
      const result = await runCli(
        [
          "claude", "on",
          "--api-key", "fw_test_key_12345",
          "--model", "firerouter",
          "--routing-preference", "balanced",
        ],
        { home, env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
    });
  });

  it("scopes Claude tier-slot flags to claude on", async () => {
    await withTempHome("option-specific-", async (home) => {
      await rejects(home, ["pi", "on", "--force"], /--force is only supported/);
      await rejects(home, ["cursor", "on", "--mode", "composer"], /Unknown argument: --mode/);
      await rejects(home, ["cursor", "on", "--slot", "main"], /Unknown argument: --slot/);
      await rejects(home, ["pi", "on", "--opus", "glm-latest"], /--opus.*apply only to `fireconnect claude on`/);
      await rejects(home, ["cursor", "on", "--subagent", "glm-latest"], /--subagent.*apply only to `fireconnect claude on`/);
      await rejects(home, ["claude", "status", "--sonnet", "glm-latest"], /--opus.*apply only to `fireconnect claude on`/);
      await rejects(home, ["opencode", "on", "--non-interactive"], /applies only to .*claude on/);
      await rejects(home, ["opencode", "on", "--interactive"], /applies only to .*claude on/);
      await rejects(
        home,
        ["claude", "on", "--interactive", "--non-interactive"],
        /cannot be used together/,
      );
      await rejects(
        home,
        ["claude", "on", "--interactive", "--opus", "glm-latest"],
        /--interactive is not supported/,
      );
      await rejects(
        home,
        ["claude", "on", "--interactive"],
        /--interactive is not supported/,
      );
    });
  });

  it("rejects usage, JSON, and path options where they are ignored", async () => {
    await withTempHome("option-command-scope-", async (home) => {
      await rejects(home, ["pi", "status", "--session", "abc"], /--session applies only to/);
      await rejects(home, ["opencode", "on", "--json"], /--json is supported by/);
      await rejects(home, ["claude", "on", "--refresh"], /--refresh applies only to .*model list/);
      await rejects(home, ["codex", "status", "--db-path", "/tmp/state.vscdb"], /--db-path is supported only by Cursor/);
      await rejects(home, ["cursor", "status", "--config-path", "/tmp/config"], /--config-path is supported only by/);
      await rejects(home, ["vscode", "status", "--settings-path", "/tmp/settings"], /--settings-path is supported only by/);
    });
  });

  it("accepts --session for claude live as well as claude usage", async () => {
    await withTempHome("option-live-session-", async (home) => {
      // `claude live --session` must clear option validation; any later failure
      // (no tmux, or no matching session log in the empty home) is not the
      // "applies only to" rejection this test guards against.
      const live = await runCli(["claude", "live", "--session", "abc"], {
        home,
        env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
      });
      assert.doesNotMatch(live.stderr, /--session applies only to/);
      // Report-only flags stay usage-only even on the live command.
      await rejects(home, ["claude", "live", "--days", "3"], /--days\/--last-n\/--verbose\/--plain apply only to/);

      // The pi usage/live pair accepts the same flags as claude's.
      const piLive = await runCli(["pi", "live", "--session", "abc"], {
        home,
        env: { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
      });
      assert.doesNotMatch(piLive.stderr, /--session applies only to/);
      await rejects(home, ["pi", "live", "--days", "3"], /--days\/--last-n\/--verbose\/--plain apply only to/);
      await rejects(home, ["opencode", "live"], /live` is supported only for Claude Code and Pi/);
    });
  });
});
