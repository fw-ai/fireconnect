import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OPENCODE_API_KEY_ENV_REF } from "../../lib/harnesses/opencode/core.mjs";
import {
  DEFAULT_HAIKU_MODEL,
  DEFAULT_OPUS_MODEL,
  DEFAULT_SONNET_MODEL,
} from "../../lib/harnesses/claude/model-profile.mjs";
import {
  FIREWORKS_INFERENCE_URL,
  FPK_KEY,
  FW_CLAUDE_KEY,
  FIREPASS_ROUTER,
  GLM_LATEST,
  GLM_FAST_LATEST,
  KIMI_FAST_LATEST,
  NO_ENV_KEY,
  expectedOpencodeLatestRouterEntry,
  readClaudeSettings,
  readOpencodeConfig,
  runCli,
  runCliJson,
  seedServerlessCatalogCache,
  SK_ANT_KEY,
  withTempHome,
  writeClaudeSettings,
  writeNativeAnthropicSettings,
  assertClaudeMainModel,
  writeOpencodeConfig,
} from "../helpers.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";

const CLAUDE_STORED_MAIN_MODEL = `${KIMI_FAST_LATEST}[1m]`;
const CLAUDE_STORED_FABLE_MODEL = "glm-flash-latest[1m]";
const CLAUDE_STORED_GLM_MODEL = `${GLM_FAST_LATEST}[1m]`;
const CLAUDE_STORED_DS_FLASH_MODEL = "deepseek-flash-latest[1m]";
const CLAUDE_STORED_FIREROUTER_MODEL = "firerouter[1m]";
const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

describe("fireconnect bare invocation", () => {
  test("prints help when not attached to a TTY", async () => {
    await withTempHome("bare-help", async (home) => {
      const result = await runCli([], { home });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /FireConnect/);
      assert.match(result.stdout, /Harness commands/);
      assert.match(result.stdout, /fireconnect <harness> help/);
    });
  });
});

describe("fireconnect help quick", () => {
  test("shows main commands without the full reference", async () => {
    await withTempHome("help-quick", async (home) => {
      const quick = await runCli(["help", "quick"], { home });
      const full = await runCli(["help"], { home });
      assert.equal(quick.code, 0, quick.stderr);
      assert.match(quick.stdout, /Get started/);
      assert.match(quick.stdout, /login\s+Sign in to Fireworks/);
      assert.match(quick.stdout, /claude\s+Route Claude Code/);
      assert.match(quick.stdout, /help\s+Full command reference/);
      assert.doesNotMatch(quick.stdout, /Global options/);
      assert.ok(
        quick.stdout.length < full.stdout.length,
        "quick help should be shorter than full help",
      );
    });
  });
});

describe("harness help matches supported command features", () => {
  test("documents shared Azure options only on Azure-capable harnesses", async () => {
    await withTempHome("help-azure", async (home) => {
      for (const harness of ["opencode", "codex", "pi", "cursor", "vscode"]) {
        const result = await runCli(["help", harness], { home });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /--azure/);
        assert.match(result.stdout, /Microsoft Foundry endpoint/);
      }
      const deepseek = await runCli(["help", "deepseek"], { home });
      assert.equal(deepseek.code, 0, deepseek.stderr);
      assert.doesNotMatch(deepseek.stdout, /--azure/);
      const claude = await runCli(["help", "claude"], { home });
      assert.doesNotMatch(claude.stdout, /--azure/);
      assert.match(claude.stdout, /Anthropic-compatible gateway URL override/);
    });
  });

  test("does not advertise ignored gateway base-url overrides", async () => {
    await withTempHome("help-baseurl", async (home) => {
      for (const harness of ["codex", "pi"]) {
        const result = await runCli(["help", harness], { home });
        assert.doesNotMatch(result.stdout, /Fireworks gateway URL override/);
        assert.match(result.stdout, /--base-url.*Microsoft Foundry endpoint/);
      }
    });
  });

  test("documents optional usage and VS Code FireRouter options", async () => {
    const root = await runCli(["help"]);
    assert.match(root.stdout, /usage/);
    assert.match(root.stdout, /--refresh/);

    const vscode = await runCli(["help", "vscode"]);
    assert.match(vscode.stdout, /--routing-preference/);
    assert.match(vscode.stdout, /--anthropic-api-key/);
  });

  test("documents FireRouter caveats per harness", async () => {
    const claude = await runCli(["claude", "help"]);
    assert.equal(claude.code, 0, claude.stderr);
    assert.match(claude.stdout, /Options for on/);
    assert.match(claude.stdout, /Options for usage/);
    assert.match(claude.stdout, /Options for all commands/);
    assert.match(claude.stdout, /--interactive/);
    assert.match(claude.stdout, /Open the model mapping wizard/);
    assert.match(claude.stdout, /--plain/);
    assert.match(claude.stdout, /Plain text summary/);
    assert.match(claude.stdout, /--home <path>/);
    assert.match(claude.stdout, /--data-dir <path>/);
    assert.match(claude.stdout, /Override HOME/);
    assert.match(claude.stdout, /max-intelligence, more-intelligence, balanced/);
    assert.match(claude.stdout, /firerouter slot/);

    const codex = await runCli(["codex", "help"]);
    assert.equal(codex.code, 0, codex.stderr);
    assert.match(codex.stdout, /Options for on/);
    assert.match(codex.stdout, /use firerouter for FireRouter/);
    assert.match(codex.stdout, /ANTHROPIC_API_KEY/);
    assert.match(codex.stdout, /configure --anthropic-api-key|--anthropic-api-key <key>/);
    assert.match(codex.stdout, /Pass --anthropic-api-key with codex on/);

    const pi = await runCli(["pi", "help"]);
    assert.equal(pi.code, 0, pi.stderr);
    assert.match(pi.stdout, /Alias for --settings-path/);

    const cursor = await runCli(["cursor", "help"]);
    assert.equal(cursor.code, 0, cursor.stderr);
    assert.match(cursor.stdout, /Quit Cursor before on\/off/);
    assert.match(cursor.stdout, /Only Fireworks models work while FireConnect is on/);
    assert.match(cursor.stdout, /built-ins are hidden/);

    const deepseek = await runCli(["deepseek", "help"]);
    assert.equal(deepseek.code, 0, deepseek.stderr);
    assert.match(deepseek.stdout, /use firerouter for FireRouter/);
  });

  test("fireconnect <harness> help matches fireconnect help <harness>", async () => {
    for (const harness of ["claude", "codex", "pi"]) {
      const topicFirst = await runCli([harness, "help"]);
      const helpFirst = await runCli(["help", harness]);
      assert.equal(topicFirst.code, 0, topicFirst.stderr);
      assert.equal(helpFirst.code, 0, helpFirst.stderr);
      assert.equal(topicFirst.stdout, helpFirst.stdout);
    }
  });
});

describe("fireconnect version", () => {
  test("supports --version flag", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const result = await runCli(["--version"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), `v${pkg.version}`);
  });

  test("supports -V flag", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const result = await runCli(["-V"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), `v${pkg.version}`);
  });

  test("rejects version subcommand", async () => {
    const result = await runCli(["version"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown command: version/);
  });

  test("supports --version --json", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const { code, stderr, json } = await runCliJson(["--version", "--json"]);
    assert.equal(code, 0, stderr);
    assert.equal(json.version, pkg.version);
  });

  test("supports -V --json", async () => {
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const { code, stderr, json } = await runCliJson(["-V", "--json"]);
    assert.equal(code, 0, stderr);
    assert.equal(json.version, pkg.version);
  });
});

describe("unexpected input guidance", () => {
  test("harness errors point to harness help", async () => {
    const result = await runCli(["claude", "on", "--not-a-flag"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown argument: --not-a-flag/);
    assert.match(result.stderr, /Run: fireconnect claude help/);

    const wrongContext = await runCli(["pi", "on", "--force"]);
    assert.notEqual(wrongContext.code, 0);
    assert.match(wrongContext.stderr, /--force is only supported/);
    assert.match(wrongContext.stderr, /Run: fireconnect pi help/);
  });

  test("global errors point to global help", async () => {
    const result = await runCli(["not-a-command"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown command: not-a-command/);
    assert.match(result.stderr, /Run: fireconnect help/);
  });
});

describe("fireconnect claude on", () => {
  test("fw_ leaves main native, routes Opus via FireRouter, pins Sonnet and the rest", async () => {
    await withTempHome("on-fw", async (home) => {
      const result = await runCli(
        ["claude", "on", "--api-key", FW_CLAUDE_KEY],
        { home, env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
      // FireRouter is Opus-tier, so first setup with a regular fw_ key puts it on
      // the Opus slot. FireConnect no longer probes for a Claude OAuth login —
      // Claude Code attaches Anthropic auth at request time — so only Fire Pass
      // is ineligible. See "drop OAuth detection; let Claude Code own auth".
      assert.match(result.stdout, /FireRouter is on/);

      const settings = await readClaudeSettings(home);
      // Main is native (unpinned): no top-level model and no legacy main env.
      assert.equal(settings.model, undefined);
      assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
      assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, CLAUDE_STORED_FIREROUTER_MODEL);
      assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "FireRouter");
      // FireRouter on Opus moves GLM to Sonnet.
      assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-latest[1m]");
      assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "GLM 5.3 (Latest)");
      assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, CLAUDE_STORED_DS_FLASH_MODEL);
      assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "DeepSeek V4 Flash (0731) (Latest)");
      assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, CLAUDE_STORED_FABLE_MODEL);
      assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "GLM 5.3 Flash (Latest)");
      // Subagent takes the Haiku model, with the [1m] tag stripped.
      assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-flash-latest");
      assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
      assert.equal(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
      assert.equal(settings.env.DISABLE_TELEMETRY, "1");
      assert.equal(settings.env.DO_NOT_TRACK, "1");
      assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
      assert.equal(settings.env.ENABLE_TOOL_SEARCH, "true");
      assert.equal(Object.hasOwn(settings.env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
    });
  });

  test("fpk_ routes Claude Code to kimi-fast-latest", async () => {
    await withTempHome("on-fpk", async (home) => {
      const result = await runCli(
        ["claude", "on", "--api-key", FPK_KEY],
        { home, env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /kimi-fast-latest/);

      const settings = await readClaudeSettings(home);
      assertClaudeMainModel(settings, CLAUDE_STORED_MAIN_MODEL);
      for (const key of [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
      ]) {
        assert.equal(settings.env[key], CLAUDE_STORED_MAIN_MODEL);
      }
      // Subagent model is forwarded verbatim to the provider, so the [1m] beta
      // tag must be stripped (Fireworks has no "...kimi-fast-latest[1m]" model).
      assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, KIMI_FAST_LATEST);
      assert.equal(Object.hasOwn(settings.env, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), false);
    });
  });

  test("uses FIREWORKS_API_KEY when settings only have native Anthropic key", async () => {
    await withTempHome("on-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const result = await runCli(["claude", "on"], {
        home,
        env: {
          FIREWORKS_API_KEY: FW_CLAUDE_KEY,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      });
      assert.equal(result.code, 0, result.stderr);

      const settings = await readClaudeSettings(home);
      assert.equal(settings.apiKeyHelper, undefined);
      assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Fireworks-Api-Key: ${FW_CLAUDE_KEY}`));
      // FireRouter is Opus-tier: with native Anthropic auth present it takes the
      // Opus slot. Main stays native (unpinned).
      assert.equal(settings.model, undefined);
      assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
      assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "firerouter[1m]");
      assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, CLAUDE_STORED_FABLE_MODEL);
      assert.equal(settings.env.ANTHROPIC_API_KEY, SK_ANT_KEY);
      assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
      assert.equal(settings.env.ANTHROPIC_BASE_URL, FIREWORKS_INFERENCE_URL);
    });
  });

  test("re-run: FIREWORKS_API_KEY env beats stored Fire Pass key", async () => {
    await withTempHome("reon-fpk", async (home) => {
      await runCli(
        ["claude", "on", "--api-key", FPK_KEY],
        { home, env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } },
      );
      const result = await runCli(["claude", "on"], {
        home,
        env: {
          FIREWORKS_API_KEY: FW_CLAUDE_KEY,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /Fire Pass/);

      const settings = await readClaudeSettings(home);
      assert.equal(settings.apiKeyHelper, undefined);
      assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`X-Fireworks-Api-Key: ${FW_CLAUDE_KEY}`));
      assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    });
  });
});

describe("fireconnect opencode on", () => {
  test("fw_ uses kimi-fast-latest as default model", async () => {
    await withTempHome("on-fw-oc", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--api-key", FW_CLAUDE_KEY],
        { home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readOpencodeConfig(home);
      assert.equal(config.model, `fireworks-ai/${KIMI_FAST_LATEST}`);
      assert.deepEqual(
        config.provider["fireworks-ai"].models[KIMI_FAST_LATEST],
        {
          ...expectedOpencodeLatestRouterEntry("Kimi K3 Fast (Latest)", 1_040_000, 131_072),
          // Metered per-Mtok rates, so OpenCode can report spend. Fire Pass is a
          // subscription and gets no cost block — see the fpk_ case below.
          cost: { input: 4.5, output: 22.5, cache_read: 0.45 },
          modalities: { input: ["text", "image"] },
        },
      );
    });
  });

  test("fpk_ uses kimi-fast-latest", async () => {
    await withTempHome("on-fpk-oc", async (home) => {
      const result = await runCli(
        ["opencode", "on", "--api-key", FPK_KEY],
        { home },
      );
      assert.equal(result.code, 0, result.stderr);

      const config = await readOpencodeConfig(home);
      assert.equal(config.model, `fireworks-ai/${KIMI_FAST_LATEST}`);
      assert.deepEqual(
        config.provider["fireworks-ai"].models[KIMI_FAST_LATEST],
        {
          ...expectedOpencodeLatestRouterEntry("Kimi K3 Fast (Latest)", 1_040_000, 131_072),
          modalities: { input: ["text", "image"] },
        },
      );
    });
  });
});

describe("fireconnect model list", () => {
  test("Fire Pass key shows supported routers", async () => {
    await withTempHome("ml-fpk", async (home) => {
      const { json } = await runCliJson(
        ["model", "list", "--api-key", FPK_KEY, "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
      assert.equal(json.source, "firepass");
      assert.equal(json.updatedAt, null);
      assert.equal(json.count, 4);
      assert.deepEqual(
        json.models.map((entry) => entry.shortId),
        [GLM_LATEST, GLM_FAST_LATEST, "glm-5p2-fast", KIMI_FAST_LATEST],
      );
    });
  });

  test("FIREWORKS_API_KEY env beats globally stored key", async () => {
    await withTempHome("ml-env", async (home) => {
      await writeGlobalConfig(home, { apiKey: FW_CLAUDE_KEY });
      const { json } = await runCliJson(
        ["model", "list", "--json"],
        { home, env: { FIREWORKS_API_KEY: FPK_KEY } },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("uses the globally stored key and ignores harness-only keys", async () => {
    await withTempHome("ml-global-key", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const missing = await runCli(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /No Fireworks API key found/);

      await writeGlobalConfig(home, { apiKey: FPK_KEY });
      const { json } = await runCliJson(
        ["model", "list", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.keyType, "firepass");
    });
  });

  test("text output groups preferred Fire Pass routers without pricing columns (subscription)", async () => {
    await withTempHome("ml-banner", async (home) => {
      const result = await runCli(
        ["model", "list", "--api-key", FPK_KEY],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /LATEST ROUTERS — recommended, automatically track new versions/);
      assert.match(result.stdout, /FAST ROUTERS — higher tokens per second/);
      // Fire Pass is a subscription — no per-model metered pricing columns.
      assert.doesNotMatch(result.stdout, /INPUT\s+CACHED\s+OUTPUT/);
      assert.doesNotMatch(result.stdout, /\$/);
      assert.match(result.stdout, /glm-latest/);
      assert.match(result.stdout, /glm-fast-latest/);
      assert.match(result.stdout, /kimi-fast-latest/);
      assert.match(result.stdout, /\(text-only\)/);
      assert.doesNotMatch(result.stdout, /glm-5p2-fast/);
      assert.doesNotMatch(result.stdout, /kimi-k2p6-turbo/);
      assert.doesNotMatch(result.stdout, /kimi-latest/);
      assert.doesNotMatch(result.stdout, /\bKIND\b/);
      assert.match(result.stdout, /Last updated: bundled with FireConnect/);
      assert.match(result.stdout, /fireconnect model list --refresh/);
    });
  });

  test("--json --refresh reports stale when the gateway is unreachable", async () => {
    await withTempHome("ml-refresh-stale", async (home) => {
      seedServerlessCatalogCache(home, [{
        id: "accounts/fireworks/models/cached-model",
        shortId: "cached-model",
        displayName: "Cached Model",
        kind: "serverless",
      }]);

      const { code, stderr, json } = await runCliJson(
        ["model", "list", "--api-key", FW_CLAUDE_KEY, "--refresh", "--json"],
        {
          home,
          env: {
            ...NO_ENV_KEY,
            FIRECONNECT_GATEWAY_URL: "http://127.0.0.1:9",
          },
        },
      );

      assert.equal(code, 0, stderr);
      assert.equal(json.source, "stale");
      assert.match(json.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(json.models.some((entry) => entry.shortId === "cached-model"));
    });
  });

});

describe("fireconnect <harness> status", () => {
  test("Claude Fire Pass key shows correct defaults and message", async () => {
    await withTempHome("status-cc-fpk", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, KIMI_FAST_LATEST);
      assert.equal(json.defaults.opus, KIMI_FAST_LATEST);

      // The text view reports connection/provider/auth; the per-slot defaults are
      // asserted through --json above, which is the machine-readable contract.
      const text = await runCli(["claude", "status"], { home, env: NO_ENV_KEY });
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /Connection: on/);
      assert.match(text.stdout, /Provider: Fireworks/);
      // Guard against a stale legacy default resurfacing in either view.
      assert.doesNotMatch(text.stdout, /kimi-k2p6-turbo/);
    });
  });

  test("fw_ key gets non-Fire-Pass defaults", async () => {
    await withTempHome("status-fw", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.defaults.main, "claude-default");
      assert.equal(json.defaults.opus, DEFAULT_OPUS_MODEL);
      // Sonnet defaults to deepseek-pro-latest.
      assert.equal(json.defaults.sonnet, DEFAULT_SONNET_MODEL);
      assert.equal(json.defaults.haiku, DEFAULT_HAIKU_MODEL);
    });
  });

  test("ignores sk-ant tokens in Claude settings for key type", async () => {
    await withTempHome("status-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const { json } = await runCliJson(["claude", "status", "--json"], { home, env: NO_ENV_KEY });
      assert.equal(json.provider, "default");
      assert.equal(json.defaults.sonnet, DEFAULT_SONNET_MODEL);
    });
  });

  test("opencode with Fire Pass key shows kimi-fast-latest default", async () => {
    await withTempHome("status-oc-fpk", async (home) => {
      await writeOpencodeConfig(home, FPK_KEY);
      const { json } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: NO_ENV_KEY },
      );
      assert.equal(json.defaults.main, KIMI_FAST_LATEST);
    });
  });

  test("opencode resolves env-ref Fire Pass key", async () => {
    await withTempHome("status-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const { json } = await runCliJson(
        ["opencode", "status", "--json"],
        { home, env: { FIREWORKS_API_KEY: FPK_KEY } },
      );
      assert.equal(json.defaults.main, KIMI_FAST_LATEST);
    });
  });
});

describe("unsupported model mutation commands", () => {
  for (const subcommand of ["select", "reset", "add"]) {
    test(`model ${subcommand} uses generic harness guidance`, async () => {
      await withTempHome(`removed-model-${subcommand}`, async (home) => {
        const result = await runCli(["opencode", "model", subcommand], { home });
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, new RegExp(`Unknown harness command: model ${subcommand}`));
        assert.match(result.stderr, /Run: fireconnect opencode help/);
      });
    });
  }

  test("--slot is an ordinary unknown option", async () => {
    await withTempHome("removed-claude-slot", async (home) => {
      const result = await runCli(
        ["claude", "on", "--slot", "sonnet"],
        { home },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown argument: --slot/);
      assert.match(result.stderr, /Run: fireconnect claude help/);
    });
  });
});
