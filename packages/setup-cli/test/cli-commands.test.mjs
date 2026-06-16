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

describe("fireconnect on", () => {
  test("fpk_ routes Claude Code to kimi-k2p7-code-fast", async () => {
    await withTempHome("on-fpk", async (home) => {
      const result = await runCli(["on", "--api-key", FPK_KEY], { home });
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

  test("fpk_ with --harness opencode uses kimi-k2p7-code-fast", async () => {
    await withTempHome("on-fpk-oc", async (home) => {
      const result = await runCli(
        ["on", "--harness", "opencode", "--api-key", FPK_KEY],
        { home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readOpencodeConfig(home);
      assert.match(config.model, /kimi-k2p7-code-fast/);
    });
  });

  test("uses FIREWORKS_API_KEY when settings only have native Anthropic key", async () => {
    await withTempHome("on-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const result = await runCli(["on"], {
        home,
        env: { FIREWORKS_API_KEY: FW_CLAUDE_KEY },
      });
      assert.equal(result.code, 0, result.stderr);

      const { env } = await readClaudeSettings(home);
      assert.equal(env.ANTHROPIC_API_KEY, FW_CLAUDE_KEY);
      assert.equal(env.ANTHROPIC_BASE_URL, FIREWORKS_INFERENCE_URL);
    });
  });

  test("re-run preserves stored Fire Pass key over FIREWORKS_API_KEY env", async () => {
    await withTempHome("reon-fpk", async (home) => {
      await runCli(["on", "--api-key", FPK_KEY], { home });
      const result = await runCli(["on"], {
        home,
        env: { FIREWORKS_API_KEY: FW_CLAUDE_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /kimi-k2p7-code-fast/);

      const { env } = await readClaudeSettings(home);
      assert.equal(env.ANTHROPIC_API_KEY, FPK_KEY);
    });
  });
});

describe("fireconnect model list", () => {
  test("Fire Pass key shows kimi-k2p7-code-fast only", async () => {
    await withTempHome("ml-fpk", async (home) => {
      const { json } = await runCliJson(
        ["model", "list", "--api-key", FPK_KEY, "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
      assert.equal(json.count, 1);
      assert.equal(json.models[0].shortId, K2P7_FAST);
    });
  });

  test("without --harness finds OpenCode-stored key", async () => {
    await withTempHome("ml-oc", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const { code, stderr, json, stdout } = await runCliJson(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(code, 0, stderr);
      assert.equal(json.keyType, "firepass");
      assert.equal(json.models[0].shortId, K2P7_FAST);
      assert.match(stdout, /kimi-k2p7-code-fast/);
    });
  });

  test("without --harness prefers Claude when both keys exist", async () => {
    await withTempHome("ml-both", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      await writeOpencodeConfig(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("without --harness prefers stored key over FIREWORKS_API_KEY env", async () => {
    await withTempHome("ml-env", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const { json } = await runCliJson(
        ["model", "list", "--json"],
        { home, env: { FIREWORKS_API_KEY: FW_CLAUDE_KEY } },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("--harness claude uses only Claude key source", async () => {
    await withTempHome("ml-harness-cc", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const missing = await runCli(
        ["model", "list", "--harness", "claude", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /No Fireworks API key found/);

      await writeClaudeSettings(home, FPK_KEY);
      const { json } = await runCliJson(
        ["model", "list", "--harness", "claude", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("text banner mentions kimi-k2p7-code-fast for Fire Pass", async () => {
    await withTempHome("ml-banner", async (home) => {
      const result = await runCli(
        ["model", "list", "--api-key", FPK_KEY],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /kimi-k2p7-code-fast/);
      assert.doesNotMatch(result.stdout, /kimi-k2p6-turbo/);
    });
  });
});

describe("fireconnect list", () => {
  test("Claude Fire Pass key shows correct defaults and message", async () => {
    await withTempHome("list-cc-fpk", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      const { json } = await runCliJson(["list", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, K2P7_FAST);
      assert.equal(json.defaults.opus, K2P7_FAST);

      const text = await runCli(["list"], { home, env: NO_ENV_KEY });
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /kimi-k2p7-code-fast only/);
      assert.doesNotMatch(text.stdout, /kimi-k2p6-turbo/);
    });
  });

  test("fw_ key gets non-Fire-Pass defaults", async () => {
    await withTempHome("list-fw", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(["list", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, K2P7_FAST);
      assert.equal(json.defaults.sonnet, "glm-5p1");
      assert.equal(json.defaults.haiku, "minimax-m2p5");
    });
  });

  test("ignores sk-ant tokens in Claude settings", async () => {
    await withTempHome("list-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const { json } = await runCliJson(["list", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.provider, "default");
      assert.equal(json.defaults.sonnet, "glm-5p1");
    });
  });

  test("--harness opencode with Fire Pass key shows kimi-k2p7-code-fast default", async () => {
    await withTempHome("list-oc-fpk", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const { json } = await runCliJson(
        ["list", "--harness", "opencode", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.defaults.main, K2P7_FAST);
    });
  });

  test("--harness opencode resolves env-ref Fire Pass key", async () => {
    await withTempHome("list-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const { json } = await runCliJson(
        ["list", "--harness", "opencode", "--json"],
        { home, env: { FIREWORKS_API_KEY: FPK_KEY } },
      );
      assert.equal(json.defaults.main, K2P7_FAST);
    });
  });
});

describe("fireconnect reset", () => {
  test("keeps Fire Pass defaults when FIREWORKS_API_KEY env differs", async () => {
    await withTempHome("reset-fpk", async (home) => {
      await runCli(["on", "--api-key", FPK_KEY], { home });
      const result = await runCli(["reset"], {
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
