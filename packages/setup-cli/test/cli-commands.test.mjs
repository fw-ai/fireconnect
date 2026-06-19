import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OPENCODE_API_KEY_ENV_REF } from "../lib/opencode-core.mjs";
import {
  FIREWORKS_INFERENCE_URL,
  FPK_KEY,
  FW_CLAUDE_KEY,
  FIREPASS_ROUTER,
  FIREPASS_ROUTER_1M,
  GLM_LATEST,
  K2P7_FAST,
  KIMI_FAST_LATEST,
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
  test("fw_ uses glm-latest as default main router", async () => {
    await withTempHome("on-fw", async (home) => {
      const result = await runCli(["claude", "on", "--api-key", FW_CLAUDE_KEY], { home });
      assert.equal(result.code, 0, result.stderr);

      const settings = await readClaudeSettings(home);
      assert.match(settings.model, /glm-latest/);
      assert.equal(settings.env.ANTHROPIC_MODEL, FIREPASS_ROUTER_1M);
      assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREPASS_ROUTER_1M);
      assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, FIREPASS_ROUTER_1M);
      assert.equal(Object.hasOwn(settings.env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
    });
  });

  test("fpk_ routes Claude Code to glm-latest", async () => {
    await withTempHome("on-fpk", async (home) => {
      const result = await runCli(["claude", "on", "--api-key", FPK_KEY], { home });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /glm-latest/);

      const { env } = await readClaudeSettings(home);
      for (const key of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ]) {
        assert.equal(env[key], FIREPASS_ROUTER_1M);
      }
      assert.equal(Object.hasOwn(env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
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
  test("fw_ uses glm-latest as default model", async () => {
    await withTempHome("on-fw-oc", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--api-key", FW_CLAUDE_KEY],
        { home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readOpencodeConfig(home);
      assert.equal(config.model, `fireworks-ai/${FIREPASS_ROUTER}`);
      assert.deepEqual(config.provider["fireworks-ai"].models[FIREPASS_ROUTER], {
        name: FIREPASS_ROUTER,
      });
    });
  });

  test("fpk_ uses glm-latest", async () => {
    await withTempHome("on-fpk-oc", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--api-key", FPK_KEY],
        { home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readOpencodeConfig(home);
      assert.equal(config.model, `fireworks-ai/${FIREPASS_ROUTER}`);
      assert.deepEqual(config.provider["fireworks-ai"].models[FIREPASS_ROUTER], {
        name: FIREPASS_ROUTER,
      });
    });
  });
});

describe("fireconnect <harness> model list", () => {
  test("Fire Pass key shows supported routers", async () => {
    await withTempHome("ml-fpk", async (home) => {
      const { json } = await runCliJson(
        ["claude", "model", "list", "--api-key", FPK_KEY, "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
      assert.equal(json.count, 3);
      assert.deepEqual(
        json.models.map((entry) => entry.shortId),
        [GLM_LATEST, KIMI_FAST_LATEST, K2P7_FAST],
      );
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
      assert.equal(json.models[0].shortId, GLM_LATEST);
      assert.match(stdout, /glm-latest/);
      assert.match(stdout, /kimi-fast-latest/);
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

  test("text banner mentions Fire Pass-supported routers", async () => {
    await withTempHome("ml-banner", async (home) => {
      const result = await runCli(
        ["claude", "model", "list", "--api-key", FPK_KEY],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /glm-latest/);
      assert.match(result.stdout, /kimi-fast-latest/);
      assert.match(result.stdout, /kimi-k2p7-code-fast/);
      assert.doesNotMatch(result.stdout, /kimi-k2p6-turbo/);
      assert.doesNotMatch(result.stdout, /kimi-latest/);
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
      assert.equal(json.defaults.main, GLM_LATEST);
      assert.equal(json.defaults.opus, GLM_LATEST);

      const text = await runCli(["claude", "status"], { home, env: NO_ENV_KEY });
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /default: glm-latest/);
      assert.doesNotMatch(text.stdout, /kimi-k2p6-turbo/);
    });
  });

  test("fw_ key gets non-Fire-Pass defaults", async () => {
    await withTempHome("status-fw", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, GLM_LATEST);
      assert.equal(json.defaults.opus, GLM_LATEST);
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

  test("opencode with Fire Pass key shows glm-latest default", async () => {
    await withTempHome("status-oc-fpk", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const { json } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.defaults.main, GLM_LATEST);
    });
  });

  test("opencode resolves env-ref Fire Pass key", async () => {
    await withTempHome("status-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const { json } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: { FIREWORKS_API_KEY: FPK_KEY } },
      );
      assert.equal(json.defaults.main, GLM_LATEST);
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
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, FIREPASS_ROUTER_1M);
      assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FIREPASS_ROUTER_1M);
      assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, FIREPASS_ROUTER_1M);
      assert.equal(env.ANTHROPIC_API_KEY, FPK_KEY);
    });
  });
});
