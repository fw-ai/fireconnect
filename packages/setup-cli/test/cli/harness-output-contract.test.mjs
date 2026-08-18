import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCli, withTempHome } from "../helpers.mjs";
import {
  printClaudeModelManagementHints,
  printClaudeModelActivationHint,
  printCodexRestartHint,
  printDeepseekRestartHint,
  printFirerouterNote,
  printModelsAdded,
  printOpenCodeRestartHint,
  printPiRestartHint,
} from "../../lib/cli/messages.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";

function nonemptyLines(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("compact harness command output", () => {
  it("prints concise Claude model management commands", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printClaudeModelManagementHints();
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    assert.match(output, /Manage models/);
    assert.match(output, /fireconnect model list/);
    // `fireconnect claude <flag>` and `fireconnect claude on <flag>` are both
    // valid; the hints print the shorter form.
    assert.match(output, /fireconnect claude (?:on )?--interactive/);
    assert.match(output, /fireconnect claude (?:on )?--opus <model>/);
    assert.match(output, /--model --sonnet --haiku --fable --subagent/);
    assert.doesNotMatch(output, /Also in your model list/);
  });

  it("prints the two FireRouter model-list cases", () => {
    const lines = [];
    const original = console.log;
    console.log = (line = "") => lines.push(String(line));
    try {
      printModelsAdded([
        "accounts/fireworks/routers/glm-latest",
        "accounts/fireworks/routers/firerouter",
      ]);
      printFirerouterNote({ harnessId: "pi", included: true });
      printModelsAdded(["accounts/fireworks/routers/glm-latest"]);
      printFirerouterNote({ harnessId: "pi", supportsEnvByok: true });
      printFirerouterNote({ harnessId: "pi", supportsEnvByok: true, eligible: true });
      printFirerouterNote({
        harnessId: "pi",
        supportsEnvByok: true,
        workspaceByokLookup: {
          enabled: false,
          unavailable: true,
          reason: "network down",
        },
      });
      printFirerouterNote({ harnessId: "pi", firepass: true });
      printClaudeModelActivationHint();
      printCodexRestartHint();
      printPiRestartHint();
      printDeepseekRestartHint();
      printOpenCodeRestartHint();
    } finally {
      console.log = original;
    }
    assert.equal(lines[0], "Also in your model list: glm-latest, firerouter");
    assert.match(lines[1], /FireRouter is on\. Picks a model for each request/);
    assert.equal(lines[2], "Also in your model list: glm-latest");
    assert.match(lines[3], /FireRouter wasn't turned on \(no Anthropic API key\)/);
    assert.match(lines[3], /fireconnect pi --model firerouter/);
    assert.match(lines[4], /FireRouter is available/);
    assert.match(lines[4], /fireconnect pi --model firerouter/);
    assert.match(lines[5], /couldn't verify workspace BYOK \(network down\)/);
    assert.match(lines[6], /FireRouter needs a regular Fireworks API key/);
    assert.equal(lines[7], "Restart Claude Code to use the new setup.");
    assert.equal(lines[8], "Restart Codex to use the new setup.");
    assert.equal(lines[9], "Restart Pi to use the new setup.");
    assert.equal(lines[10], "Restart DeepSeek Harness to use the new setup.");
    assert.equal(lines[11], "Restart OpenCode to use the new setup.");
  });

  it("prints outcome, FireRouter help, and one apply action for routine on", async () => {
    await withTempHome("compact-on-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--model", "deepseek-v4-flash"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "fw_compact_output_key",
            ANTHROPIC_API_KEY: "",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines.length, 3, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks · deepseek-v4-flash/);
      assert.match(lines[1], /FireRouter wasn't turned on \(no Anthropic API key\)/);
      assert.match(lines[1], /fireconnect opencode --model firerouter/);
      assert.equal(lines[2], "Restart OpenCode to use the new setup.");
      assert.doesNotMatch(result.stdout, /Next →|Revert anytime|Tip:|API key written/);
      assert.match(result.stdout, /FireRouter wasn't turned on/);
      assert.match(result.stdout, /Restart OpenCode to use the new setup\./);
    });
  });

  it("does not claim FireRouter is on when only registered in the catalog", async () => {
    await withTempHome("compact-catalog-only-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--api-key", "fw_compact_output_key"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "sk-ant-configured",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /OpenCode → Fireworks · kimi-fast-latest/);
      assert.match(result.stdout, /FireRouter is available/);
      assert.doesNotMatch(result.stdout, /FireRouter is on/);
      assert.doesNotMatch(result.stdout, /Change routing:/);
    });
  });

  it("prints firerouter as the model under Fireworks", async () => {
    await withTempHome("compact-firerouter-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--model", "firerouter"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "fw_compact_output_key",
            ANTHROPIC_API_KEY: "sk-ant-configured",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines.length, 5, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks · firerouter/);
      assert.match(lines[1], /FireRouter is on\. Picks a model for each request/);
      assert.match(lines[2], /Change routing: fireconnect opencode --model firerouter --routing-preference balanced/);
      assert.match(lines[3], /Other levels: max-intelligence \(1\).*max-savings \(5\)/);
      assert.equal(lines[4], "Restart OpenCode to use the new setup.");
      assert.doesNotMatch(result.stdout, /→ FireRouter|Choose models|Models added:|FireRouter default/);
      assert.match(result.stdout, /FireRouter is on\. Picks a model for each request/);
      assert.match(result.stdout, /Change routing: fireconnect opencode --model firerouter --routing-preference balanced/);
    });
  });

  it("confirms routing preference when --routing-preference is passed", async () => {
    await withTempHome("compact-routing-pref-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--model", "firerouter", "--routing-preference", "balanced"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "fw_compact_output_key",
            ANTHROPIC_API_KEY: "sk-ant-configured",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines.length, 5, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks · firerouter/);
      assert.match(lines[1], /FireRouter is on\. Picks a model for each request/);
      assert.match(lines[2], /Change routing: fireconnect opencode --model firerouter --routing-preference balanced/);
      assert.match(lines[3], /Other levels: max-intelligence \(1\).*more-savings \(4\), max-savings \(5\)/);
      assert.equal(lines[4], "Restart OpenCode to use the new setup.");
    });
  });

  it("uses FireRouter by default when Claude has configured BYOK", async () => {
    await withTempHome("compact-claude-byok-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-configured" });
      const result = await runCli(
        ["claude", "on", "--api-key", "fw_compact_output_key"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines[0], "✓ Claude Code → Fireworks");
      assert.doesNotMatch(result.stdout, /Claude Code → Fireworks ·/);
      assert.match(result.stdout, /Model mapping/);
      // Main is never pinned, so it has no mapping row; Sonnet stays native.
      assert.doesNotMatch(result.stdout, /Main\s+→/);
      assert.match(result.stdout, /Sonnet\s+→ Claude default/);
      assert.match(result.stdout, /Opus\s+→ firerouter/);
      assert.match(result.stdout, /FireRouter is on\. Picks a model for each request/);
      assert.doesNotMatch(result.stdout, /no Anthropic key found/);
      assert.match(result.stdout, /Change routing: fireconnect claude --opus firerouter --routing-preference balanced/);
      assert.match(result.stdout, /Other levels: max-intelligence \(1\)/);
    });
  });

  it("confirms routing preference for Claude when --routing-preference is passed", async () => {
    await withTempHome("compact-claude-routing-pref-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-configured" });
      const result = await runCli(
        [
          "claude", "on",
          "--api-key", "fw_compact_output_key",
          "--opus", "firerouter",
          "--routing-preference", "balanced",
        ],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines[0], "✓ Claude Code → Fireworks");
      assert.doesNotMatch(result.stdout, /Claude Code → Fireworks ·/);
      assert.match(result.stdout, /Model mapping/);
      assert.match(result.stdout, /Opus\s+→ firerouter/);
      assert.match(result.stdout, /FireRouter is on\. Picks a model for each request/);
      assert.match(
        lines.find((line) => line.startsWith("Change routing:")),
        /Change routing: fireconnect claude --opus firerouter --routing-preference balanced/,
      );
      assert.match(result.stdout, /Restart Claude Code to use the new setup/);
    });
  });

  it("does not advertise routing preference for Codex firerouter on", async () => {
    await withTempHome("compact-codex-firerouter-", async (home) => {
      const result = await runCli(
        ["codex", "on", "--model", "firerouter", "--api-key", "fw_compact_output_key"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "sk-ant-configured",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Codex → Fireworks · firerouter/);
      assert.match(result.stdout, /FireRouter is on\. Picks a model for each request/);
      assert.doesNotMatch(result.stdout, /Routing:/);
    });
  });

  it("keeps Azure output to outcome, endpoint, and apply action", async () => {
    await withTempHome("compact-azure-", async (home) => {
      const result = await runCli(
        [
          "opencode", "on", "--azure",
          "--base-url", "https://demo.services.ai.azure.com",
          "--api-key", "az_demo",
        ],
        { home, env: { FIREWORKS_API_KEY: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
      const lines = nonemptyLines(result.stdout);
      assert.equal(lines.length, 3, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks on Microsoft Foundry · FW-GLM-5.2/);
      assert.match(lines[1], /Endpoint: https:\/\/demo\.services\.ai\.azure\.com\/openai\/v1/);
      assert.equal(lines[2], "Restart OpenCode to use the new setup.");
      assert.match(result.stdout, /openai\/v1\n\nRestart OpenCode/);
    });
  });
});
