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
import { symbols } from "../../lib/ui/style.mjs";
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
    assert.match(output, /fireconnect claude --model <id>/);
    // FireRouter stays discoverable via --model help, not a standing hint row.
    assert.doesNotMatch(output, /--model firerouter/);
    assert.doesNotMatch(output, /--opus|--interactive/);
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
      printFirerouterNote({ harnessId: "pi" });
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
    assert.match(lines[1], /FireRouter is on\. Routes each request between Claude and open models/);
    assert.equal(lines[2], "Also in your model list: glm-latest");
    // Nothing selected → the note stays quiet (no advertisement); the next
    // printed line is the Fire Pass refusal from the case after it.
    assert.match(lines[3], /FireRouter needs a regular Fireworks API key/);
    assert.equal(lines[4], "Restart Claude Code to use the new setup.");
    assert.match(lines[5], /Quit & reopen the ChatGPT app/);
    assert.match(lines[6], /^To resume existing Codex sessions with Fireworks:\n/);
    assert.match(lines[6], /^ {2}codex resume <id> -c model_provider="fireworks-ai"/m);
    assert.equal(lines[7], "Restart Pi to use the new setup.");
    assert.equal(lines[8], "Restart DeepSeek Harness to use the new setup.");
    assert.equal(lines[9], "Restart OpenCode to use the new setup.");
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
      // Success line + restart hint only — no FireRouter advertisement.
      assert.equal(lines.length, 2, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks · deepseek-v4-flash/);
      assert.equal(lines[1], "Restart OpenCode to use the new setup.");
      assert.doesNotMatch(result.stdout, /Next →|Revert anytime|Tip:|API key written/);
      assert.doesNotMatch(result.stdout, /FireRouter/);
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
      assert.match(result.stdout, /OpenCode → Fireworks · auto/);
      // A plain `on` never advertises FireRouter — even with a key present.
      assert.doesNotMatch(result.stdout, /FireRouter/);
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
      assert.match(lines[1], /FireRouter is on\. Routes each request between Claude and open models/);
      assert.match(lines[2], /Change routing: fireconnect opencode --model firerouter --routing-preference balanced/);
      assert.match(lines[3], /Other levels: max-intelligence \(1\).*max-savings \(5\)/);
      assert.equal(lines[4], "Restart OpenCode to use the new setup.");
      assert.doesNotMatch(result.stdout, /→ FireRouter|Choose models|Models added:|FireRouter default/);
      assert.match(result.stdout, /FireRouter is on\. Routes each request between Claude and open models/);
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
      assert.equal(lines.length, 6, result.stdout);
      assert.match(lines[0], /OpenCode → Fireworks · firerouter/);
      assert.match(lines[1], /FireRouter is on\. Routes each request between Claude and open models/);
      assert.match(lines[2], /Routing: balanced \(3\) \(applies to firerouter slots\)/);
      assert.match(lines[3], /Change routing: fireconnect opencode --model firerouter --routing-preference balanced/);
      assert.match(lines[4], /Other levels: max-intelligence \(1\).*more-savings \(4\), max-savings \(5\)/);
      assert.equal(lines[5], "Restart OpenCode to use the new setup.");
    });
  });

  it("omits the routing confirmation for firerouter compounds", async () => {
    await withTempHome("compact-compound-routing-pref-", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--model", "firerouter/kimi-k3", "--routing-preference", "balanced"],
        {
          home,
          env: {
            FIREWORKS_API_KEY: "fw_compact_output_key",
            ANTHROPIC_API_KEY: "sk-ant-configured",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /Routing:/);
      assert.match(result.stdout, /Change routing: fireconnect opencode --model firerouter --routing-preference balanced/);
    });
  });

  it("uses Claude default tier slots when BYOK is configured without explicit flags", async () => {
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
      assert.equal(lines[0], `${symbols.ok} Claude Code → Fireworks · firerouter`);
      assert.match(result.stdout, /Model picker/);
      assert.match(result.stdout, /Anthropic model slots.*unchanged/);
      assert.match(result.stdout, /Fireworks catalog.*appended/);
      assert.doesNotMatch(result.stdout, /Opus\s+→/);
      assert.doesNotMatch(result.stdout, /FireRouter is on/);
      assert.doesNotMatch(result.stdout, /no Anthropic key found/);
      assert.match(result.stdout, /Restart Claude Code to use the new setup/);
    });
  });

  it("confirms routing preference for Claude when --routing-preference is passed", async () => {
    await withTempHome("compact-claude-routing-pref-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: "sk-ant-configured" });
      const result = await runCli(
        [
          "claude", "on",
          "--api-key", "fw_compact_output_key",
          "--model", "firerouter",
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
      assert.equal(lines[0], `${symbols.ok} Claude Code → Fireworks · firerouter`);
      assert.match(result.stdout, /Model picker/);
      assert.match(result.stdout, /Added via --model.*firerouter/);
      assert.match(result.stdout, /FireRouter is on\. Routes each request between Claude and open models/);
      assert.match(result.stdout, /Routing: balanced \(3\) \(applies to firerouter slots\)/);
      assert.match(
        lines.find((line) => line.startsWith("Change routing:")),
        /Change routing: fireconnect claude --model firerouter --routing-preference balanced/,
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
      assert.match(result.stdout, /FireRouter is on\. Routes each request between Claude and open models/);
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
