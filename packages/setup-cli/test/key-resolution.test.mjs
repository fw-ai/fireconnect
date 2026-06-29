import assert from "node:assert/strict";
import { describe, test } from "node:test";

import claude from "../lib/harnesses/claude.mjs";
import opencode from "../lib/harnesses/opencode.mjs";
import codex from "../lib/harnesses/codex.mjs";
import pi from "../lib/harnesses/pi.mjs";
import { resolveFireworksApiKey, resolveHarnessOnApiKey } from "../lib/fireworks-models.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  writeGlobalConfig,
} from "../lib/global-config.mjs";
import {
  FW_CLAUDE_KEY,
  FW_CODEX_KEY,
  FW_OPENCODE_KEY,
  FPK_KEY,
  withTempHome,
  withoutEnvFireworksKey,
  writeClaudeSettings,
  writeCodexConfig,
  writeNativeAnthropicSettings,
  writeOpencodeConfig,
} from "./helpers.mjs";
import { OPENCODE_API_KEY_ENV_REF } from "../lib/opencode-core.mjs";
import { PI_API_KEY_ENV_REF, piAuthPath } from "../lib/pi-core.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function harnessCtx(home) {
  return {
    home,
    settingsPath: "",
    configPath: "",
    dataDir: "",
    apiKey: "",
    apiKeyFromFlag: false,
    baseUrl: "",
    main: "",
    opus: "",
    sonnet: "",
    haiku: "",
    subagent: "",
    slot: "",
    search: "",
    json: false,
    harnesses: "",
    apiKeyMode: "",
  };
}

async function writePiAuth(home, apiKey) {
  const authPath = piAuthPath(home);
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(
    authPath,
    `${JSON.stringify({ fireworks: { type: "api_key", key: apiKey } }, null, 2)}\n`,
  );
}

describe("harness resolveKey", () => {
  test("claude returns harness-local Fireworks key", async () => {
    await withTempHome("claude-key", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const key = await claude.resolveKey(harnessCtx(home));
      assert.equal(key, FW_CLAUDE_KEY);
    });
  });

  test("claude skips non-Fireworks-shaped tokens", async () => {
    await withTempHome("claude-skant", async (home) => {
      await writeNativeAnthropicSettings(home);
      const key = await claude.resolveKey(harnessCtx(home));
      assert.equal(key, "");
    });
  });

  test("opencode returns harness-local Fireworks key", async () => {
    await withTempHome("opencode-key", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      const configPath = await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const key = await opencode.resolveKey(harnessCtx(home));
      assert.equal(key, FW_OPENCODE_KEY);
      assert.ok(configPath);
    });
  });

  test("opencode resolves env-ref to FIREWORKS_API_KEY", async () => {
    await withTempHome("opencode-envref", async (home) => {
      await writeOpencodeConfig(home, OPENCODE_API_KEY_ENV_REF);
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FPK_KEY;
      try {
        const key = await opencode.resolveKey(harnessCtx(home));
        assert.equal(key, FPK_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("codex returns harness-local bearer token without env", async () => {
    await withoutEnvFireworksKey(async () => {
      await withTempHome("codex-bearer-key", async (home) => {
        await writeCodexConfig(home, { apiKey: FW_CODEX_KEY });
        const key = await codex.resolveKey(harnessCtx(home));
        assert.equal(key, FW_CODEX_KEY);
      });
    });
  });

  test("codex resolves env_key to FIREWORKS_API_KEY", async () => {
    await withTempHome("codex-envref", async (home) => {
      await writeCodexConfig(home, { envRef: true });
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FW_CODEX_KEY;
      try {
        const key = await codex.resolveKey(harnessCtx(home));
        assert.equal(key, FW_CODEX_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("codex resolveKey returns empty when fireworks routing is inactive", async () => {
    await withoutEnvFireworksKey(async () => {
      await withTempHome("codex-inactive", async (home) => {
        const key = await codex.resolveKey(harnessCtx(home));
        assert.equal(key, "");
      });
    });
  });

  test("pi resolves env-ref to FIREWORKS_API_KEY", async () => {
    await withTempHome("pi-envref", async (home) => {
      await writePiAuth(home, PI_API_KEY_ENV_REF);
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FPK_KEY;
      try {
        const key = await pi.resolveKey(harnessCtx(home));
        assert.equal(key, FPK_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });
});

describe("resolveFireworksApiKey with harness resolveKey", () => {
  test("claude chain prefers harness-local key over env", async () => {
    await withTempHome("chain-claude-local", async (home) => {
      await writeClaudeSettings(home, FPK_KEY);
      const ctx = harnessCtx(home);
      await withoutEnvFireworksKey(async () => {
        const resolved = await resolveFireworksApiKey({
          resolveKey: () => claude.resolveKey(ctx),
          home,
        });
        assert.equal(resolved, FPK_KEY);
      });
    });
  });

  test("claude chain falls back to FIREWORKS_API_KEY env", async () => {
    await withTempHome("chain-claude-env", async (home) => {
      await writeNativeAnthropicSettings(home);
      const ctx = harnessCtx(home);
      const resolved = await resolveFireworksApiKey({
        resolveKey: () => claude.resolveKey(ctx),
        home,
        apiKey: "",
      });
      // resolveFireworksApiKey reads process.env.FIREWORKS_API_KEY last;
      // runCli clears it via NO_ENV_KEY but unit tests inherit shell env.
      // Pass explicit env via the test's expectation: empty harness key + no global config
      // means we need env set in process for this assertion.
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = FW_CLAUDE_KEY;
      try {
        const key = await resolveFireworksApiKey({
          resolveKey: () => claude.resolveKey(ctx),
          home,
        });
        assert.equal(key, FW_CLAUDE_KEY);
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("opencode chain ignores Claude settings", async () => {
    await withTempHome("chain-oc-only", async (home) => {
      await writeClaudeSettings(home, FW_CLAUDE_KEY);
      await writeOpencodeConfig(home, FW_OPENCODE_KEY);
      const ctx = harnessCtx(home);
      await withoutEnvFireworksKey(async () => {
        const resolved = await resolveFireworksApiKey({
          resolveKey: () => opencode.resolveKey(ctx),
          home,
        });
        assert.equal(resolved, FW_OPENCODE_KEY);
      });
    });
  });
});

describe("resolveHarnessOnApiKey", () => {
  test("uses global literal before env", async () => {
    await withTempHome("on-global-literal", async (home) => {
      await writeGlobalConfig(home, {
        apiKey: "fw_global_key_12345",
        harnesses: { pi: { enabled: false } },
      });

      await withoutEnvFireworksKey(async () => {
        const resolved = await resolveHarnessOnApiKey({
          home,
          harnessEnvRef: PI_API_KEY_ENV_REF,
        });
        assert.equal(resolved.apiKey, "fw_global_key_12345");
        assert.equal(resolved.apiKeyFromFlag, true);
        assert.equal(resolved.source, "global-literal");
      });
    });
  });

  test("uses legacy global env ref when FIREWORKS_API_KEY is set", async () => {
    await withTempHome("on-global-envref", async (home) => {
      await writeGlobalConfig(home, {
        apiKey: FIREWORKS_API_KEY_ENV_REF,
        harnesses: { pi: { enabled: false } },
      });

      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = "fw_test_key_12345";
      try {
        const resolved = await resolveHarnessOnApiKey({
          home,
          harnessEnvRef: PI_API_KEY_ENV_REF,
        });
        assert.equal(resolved.apiKey, PI_API_KEY_ENV_REF);
        assert.equal(resolved.apiKeyFromFlag, false);
        assert.equal(resolved.source, "global-env-ref");
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });

  test("falls back to env when global config has no key", async () => {
    await withTempHome("on-env-only", async (home) => {
      const prev = process.env.FIREWORKS_API_KEY;
      process.env.FIREWORKS_API_KEY = "fw_test_key_12345";
      try {
        const resolved = await resolveHarnessOnApiKey({
          home,
          harnessEnvRef: OPENCODE_API_KEY_ENV_REF,
        });
        assert.equal(resolved.apiKey, OPENCODE_API_KEY_ENV_REF);
        assert.equal(resolved.source, "env");
      } finally {
        if (prev === undefined) {
          delete process.env.FIREWORKS_API_KEY;
        } else {
          process.env.FIREWORKS_API_KEY = prev;
        }
      }
    });
  });
});
