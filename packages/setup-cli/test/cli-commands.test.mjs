import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OPENCODE_API_KEY_ENV_REF } from "../lib/opencode-core.mjs";
import {
  FIREPASS_ROUTER,
  FIREWORKS_INFERENCE_URL,
  FPK_KEY,
  FW_CLAUDE_KEY,
  K2P7_FAST,
  NO_ENV_KEY,
  readClaudeSettings,
  readOpencodeConfig,
  runCli,
  runCliJson,
  withTempHome,
  writeClaudeSettings,
  writeNativeAnthropicSettings,
  writeOpencodeConfig,
} from "./helpers.mjs";

describe("fireconnect claude on", () => {
  test("fpk_ routes Claude Code to kimi-k2p7-code-fast", async () => {
    await withTempHome("on-fpk", async (home) => {
      const result = await runCli(["claude", "on", "--api-key", FPK_KEY], { home });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /kimi-k2p7-code-fast/);

      const { env } = await readClaudeSettings(home);
      for (const key of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ]) {
        assert.equal(env[key], FIREPASS_ROUTER);
      }
    });
  });

  test("uses FIREWORKS_API_KEY when settings only have native Anthropic key", async () => {
    await withTempHome("on-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const result = await runCli(["claude", "on"], {
        home,
        env: { FIREWORKS_API_KEY: FW_CLAUDE_KEY },
      });
      assert.equal(result.code, 0, result.stderr);

      const { env } = await readClaudeSettings(home);
      assert.equal(env.ANTHROPIC_API_KEY, FW_CLAUDE_KEY);
      assert.equal(env.ANTHROPIC_BASE_URL, FIREWORKS_INFERENCE_URL);
    });
  });

  test("re-run: FIREWORKS_API_KEY env beats stored Fire Pass key", async () => {
    await withTempHome("reon-fpk", async (home) => {
      await runCli(["claude", "on", "--api-key", FPK_KEY], { home });
      const result = await runCli(["claude", "on"], {
        home,
        env: { FIREWORKS_API_KEY: FW_CLAUDE_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
      // env key (fw_) wins — no Fire Pass announcement
      assert.doesNotMatch(result.stdout, /Fire Pass/);

      const { env } = await readClaudeSettings(home);
      assert.equal(env.ANTHROPIC_API_KEY, FW_CLAUDE_KEY);
    });
  });
});

describe("fireconnect opencode on", () => {
  test("fpk_ uses kimi-k2p7-code-fast", async () => {
    await withTempHome("on-fpk-oc", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--api-key", FPK_KEY],
        { home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readOpencodeConfig(home);
      assert.match(config.model, /kimi-k2p7-code-fast/);
    });
  });
});

describe("fireconnect <harness> model list", () => {
  test("Fire Pass key shows kimi-k2p7-code-fast only", async () => {
    await withTempHome("ml-fpk", async (home) => {
      const { json } = await runCliJson(
        ["claude", "model", "list", "--api-key", FPK_KEY, "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
      assert.equal(json.count, 1);
      assert.equal(json.models[0].shortId, K2P7_FAST);
    });
  });

  test("opencode model list finds OpenCode-stored key", async () => {
    await withTempHome("ml-oc", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const { code, stderr, json, stdout } = await runCliJson(
        ["opencode", "model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(code, 0, stderr);
      assert.equal(json.keyType, "firepass");
      assert.equal(json.models[0].shortId, K2P7_FAST);
      assert.match(stdout, /kimi-k2p7-code-fast/);
    });
  });

  test("claude model list uses Claude key when both harnesses have keys", async () => {
    await withTempHome("ml-both", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      await writeOpencodeConfig(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(
        ["claude", "model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("FIREWORKS_API_KEY env beats harness-local key", async () => {
    await withTempHome("ml-env", async (home) => {
      // Store fw_ key in opencode; set fpk_ in env → env (fpk_) wins
      await writeOpencodeConfig(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(
        ["opencode", "model", "list", "--json"],
        { home, env: { FIREWORKS_API_KEY: FPK_KEY } },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("claude model list ignores OpenCode-only key", async () => {
    await withTempHome("ml-harness-cc", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const missing = await runCli(
        ["claude", "model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /No Fireworks API key found/);

      await writeClaudeSettings(home, FPK_KEY);
      const { json } = await runCliJson(
        ["claude", "model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("text banner mentions kimi-k2p7-code-fast for Fire Pass", async () => {
    await withTempHome("ml-banner", async (home) => {
      const result = await runCli(
        ["claude", "model", "list", "--api-key", FPK_KEY],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /kimi-k2p7-code-fast/);
      assert.doesNotMatch(result.stdout, /kimi-k2p6-turbo/);
    });
  });

  test("bare global model list redirects to harness scope", async () => {
    await withTempHome("ml-global", async (home) => {
      const result = await runCli(["model", "list"], { home, env: NO_ENV_KEY });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /model commands are harness-scoped/);
    });
  });
});

describe("fireconnect <harness> status", () => {
  test("Claude Fire Pass key shows correct defaults and message", async () => {
    await withTempHome("status-cc-fpk", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, K2P7_FAST);
      assert.equal(json.defaults.opus, K2P7_FAST);

      const text = await runCli(["claude", "status"], { home, env: NO_ENV_KEY });
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /kimi-k2p7-code-fast only/);
      assert.doesNotMatch(text.stdout, /kimi-k2p6-turbo/);
    });
  });

  test("fw_ key gets non-Fire-Pass defaults", async () => {
    await withTempHome("status-fw", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, K2P7_FAST);
      assert.equal(json.defaults.sonnet, "glm-5p1");
      assert.equal(json.defaults.haiku, "minimax-m2p5");
    });
  });

  test("ignores sk-ant tokens in Claude settings for key type", async () => {
    await withTempHome("status-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.provider, "default");
      assert.equal(json.defaults.sonnet, "glm-5p1");
    });
  });

  test("opencode with Fire Pass key shows kimi-k2p7-code-fast default", async () => {
    await withTempHome("status-oc-fpk", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const { json } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.defaults.main, K2P7_FAST);
    });
  });

  test("opencode resolves env-ref Fire Pass key", async () => {
    await withTempHome("status-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const { json } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: { FIREWORKS_API_KEY: FPK_KEY } },
      );
      assert.equal(json.defaults.main, K2P7_FAST);
    });
  });
});

describe("fireconnect claude model reset", () => {
  test("keeps Fire Pass defaults when FIREWORKS_API_KEY env differs", async () => {
    await withTempHome("reset-fpk", async (home) => {
      await runCli(["claude", "on", "--api-key", FPK_KEY], { home });
      const result = await runCli(["claude", "model", "reset"], {
        home,
        env: { FIREWORKS_API_KEY: FW_CLAUDE_KEY },
      });
      assert.equal(result.code, 0, result.stderr);

      const { env } = await readClaudeSettings(home);
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, FIREPASS_ROUTER);
      assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FIREPASS_ROUTER);
      assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, FIREPASS_ROUTER);
      assert.equal(env.ANTHROPIC_API_KEY, FPK_KEY);
    });
  });
});
