import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FIRECONNECT_FIREROUTER_PROVIDER_NAME,
  firerouterVscodeMessagesUrl,
  vscodeFirerouterProviderStatus,
} from "../lib/vscode-firerouter-core.mjs";
import {
  isFireconnectProvider,
} from "../lib/vscode-core.mjs";
import { FALLBACK_FIREROUTER_CLAUDE_MODELS } from "../lib/firerouter-catalog.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../lib/global-config.mjs";
import { runCli, runCliJson, withTempHome } from "./helpers.mjs";

const FW_KEY = "fw_test_fireworks_key_00000000000000";
const SK_ANT_KEY = "sk-ant-test-anthropic-key-zzz";

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

function stateDbFor(vscodePath) {
  return path.join(path.dirname(vscodePath), "globalStorage", "state.vscdb");
}

/** Read the `secret://<secretId>` row from a temp state.vscdb (plaintext mode). */
function readStateSecret(vscodePath, secretId) {
  const dbPath = stateDbFor(vscodePath);
  if (!existsSync(dbPath)) return undefined;
  const r = spawnSync("sqlite3", [dbPath, `SELECT value FROM ItemTable WHERE key='secret://${secretId}';`], {
    encoding: "utf8",
  });
  if (r.status !== 0) return undefined;
  const out = (r.stdout || "").replace(/\n$/, "");
  return out === "" ? undefined : out;
}

// Pin the router-mode Claude set so `on --router` is deterministic and offline
// (no live .well-known fetch). resolveFirerouterClaudeModels uses this verbatim.
const PINNED_ROUTER_MODELS = "claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5";
const secretEnv = () => ({
  FIRECONNECT_VSCODE_SECRET_PLAINTEXT: "1",
  FIRECONNECT_ROUTER_MODELS: PINNED_ROUTER_MODELS,
});

describe("vscode-firerouter-core pure", () => {
  it("firerouterVscodeMessagesUrl appends /v1/messages", () => {
    assert.equal(firerouterVscodeMessagesUrl("https://router.fireworks.ai"), "https://router.fireworks.ai/v1/messages");
    assert.equal(firerouterVscodeMessagesUrl(""), "https://router.fireworks.ai/v1/messages");
  });

  it("vscodeFirerouterProviderStatus detects messages provider, not chat-completions", () => {
    const router = [{
      name: FIRECONNECT_FIREROUTER_PROVIDER_NAME,
      vendor: "customendpoint",
      apiType: "messages",
      apiKey: "${input:chat.lm.secret.fw-abcd}",
      models: [{ id: "claude-opus-4-8", url: "https://router.fireworks.ai/v1/messages", requestHeaders: { "X-FireRouter-Fireworks-Key": "fw_x" } }],
    }];
    assert.equal(vscodeFirerouterProviderStatus(router), "firerouter");
    assert.equal(vscodeFirerouterProviderStatus([]), "none");
    // Direct-mode fireconnect provider is NOT router.
    const direct = [{
      name: "Fireworks",
      vendor: "customendpoint",
      apiType: "chat-completions",
      apiKey: "${input:chat.lm.secret.fw-abcd}",
      models: [{ id: "glm-latest", url: "https://api.fireworks.ai/inference" }],
    }];
    assert.equal(vscodeFirerouterProviderStatus(direct), "none");
  });
});

describe("vscode firerouter integration", () => {
  it("on --router writes a messages provider, the fw key as a plaintext header, and stores the ANTHROPIC key", async () => {
    await withTempHome("vscode-fr-on-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const arr = await readJson(vscodePath);
      assert.equal(arr.length, 1);
      const provider = arr[0];
      assert.equal(provider.name, FIRECONNECT_FIREROUTER_PROVIDER_NAME);
      assert.equal(provider.vendor, "customendpoint");
      assert.equal(provider.apiType, "messages");
      assert.match(provider.apiKey, /^\$\{input:chat\.lm\.secret\.fw-[0-9a-f]+\}$/);

      const model = provider.models[0];
      assert.equal(model.url, "https://router.fireworks.ai/v1/messages");
      assert.equal(model.apiType, "messages");
      assert.equal(model.requestHeaders["X-FireRouter-Fireworks-Key"], FW_KEY);

      // The fw- secret row holds the ANTHROPIC key (Layout A), not the Fireworks key.
      const secretId = provider.apiKey.match(/^\$\{input:(.+)\}$/)[1];
      assert.equal(readStateSecret(vscodePath, secretId), SK_ANT_KEY);

      // The plaintext-key warning is emitted to stderr.
      assert.match(r.stderr, /plaintext/);
    });
  });

  it("on --router seeds the curated Claude model set", async () => {
    await withTempHome("vscode-fr-curated-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      const ids = arr[0].models.map((m) => m.id);
      assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]);
      // Every seeded model is router-shaped (messages url + fw header).
      for (const m of arr[0].models) {
        assert.equal(m.url, "https://router.fireworks.ai/v1/messages");
        assert.equal(m.apiType, "messages");
        assert.equal(m.requestHeaders["X-FireRouter-Fireworks-Key"], FW_KEY);
      }
    });
  });

  it("on --router --main is rejected (pick models in the Chat picker)", async () => {
    await withTempHome("vscode-fr-main-reject-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--main", "claude-sonnet-5", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /--main does not apply in --router mode/);
      // Nothing should have been written.
      assert.equal(existsSync(vscodePath), false);
    });
  });

  it("off after router on restores the original file and deletes the secret", async () => {
    await withTempHome("vscode-fr-off-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await mkdir(path.dirname(vscodePath), { recursive: true });
      const original = JSON.stringify([{ name: "Mine", vendor: "customendpoint", apiType: "chat-completions", apiKey: "${input:chat.lm.secret.user-x}", models: [] }], null, "\t") + "\n";
      await writeFile(vscodePath, original);

      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const enabled = await readJson(vscodePath);
      const secretId = enabled.find(isFireconnectProvider).apiKey.match(/^\$\{input:(.+)\}$/)[1];
      assert.equal(readStateSecret(vscodePath, secretId), SK_ANT_KEY);

      const offR = await runCli(["vscode", "off", "--vscode-path", vscodePath, "--force"], { home, env: secretEnv() });
      assert.equal(offR.code, 0, `stderr: ${offR.stderr}`);
      assert.equal(await readFile(vscodePath, "utf8"), original);
      assert.equal(readStateSecret(vscodePath, secretId), undefined);
    });
  });

  it("status --json reports provider firerouter and both keys present", async () => {
    await withTempHome("vscode-fr-status-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const r = await runCliJson(["vscode", "status", "--vscode-path", vscodePath, "--json"], { home, env: secretEnv() });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.provider, "firerouter");
      assert.equal(r.json.mode, "router");
      assert.equal(r.json.hasFireworksKey, true);
      assert.equal(r.json.hasAnthropicKey, true);
      assert.ok(r.json.registeredModels.length >= 1);
    });
  });

  it("model add/select/reset/list all error in router mode", async () => {
    await withTempHome("vscode-fr-modelops-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      for (const args of [
        ["vscode", "model", "add", "claude-opus-4-8"],
        ["vscode", "model", "reset"],
        ["vscode", "model", "list"],
        ["vscode", "model", "select"],
      ]) {
        const r = await runCli([...args, "--vscode-path", vscodePath, "--force"], { home, env: secretEnv() });
        assert.notEqual(r.code, 0, `${args.join(" ")} should have failed`);
        assert.match(r.stderr, /--router mode/);
      }
    });
  });

  it("model add succeeds when disk is direct but config still says router", async () => {
    await withTempHome("vscode-fr-modelops-diverge-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const directOn = await runCli(
        ["vscode", "on", "--api-key", FW_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(directOn.code, 0, `stderr: ${directOn.stderr}`);

      const config = await readGlobalConfig(home);
      await writeGlobalConfig(home, {
        ...config,
        harnesses: { ...config.harnesses, vscode: { enabled: true, mode: "router" } },
      });

      const r = await runCli(
        ["vscode", "model", "add", "deepseek-v4-flash", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /--router mode/);
    });
  });

  it("on --router rejects a Fire Pass key", async () => {
    await withTempHome("vscode-fr-firepass-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", "fpk_test_firepass_key_000000000000", "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /Fire Pass/i);
    });
  });

  it("on --router without an Anthropic key (non-TTY) errors with the missing-key message", async () => {
    await withTempHome("vscode-fr-noanthropic-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: { ...secretEnv(), ANTHROPIC_API_KEY: "" } },
      );
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /No Anthropic API key|ANTHROPIC_API_KEY/);
    });
  });

  it("re-running on --router drops models no longer in the advertised catalog", async () => {
    await withTempHome("vscode-fr-shrink-catalog-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        {
          home,
          env: {
            ...secretEnv(),
            FIRECONNECT_ROUTER_MODELS: "claude-opus-4-8,claude-sonnet-5",
          },
        },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      const ids = arr.find(isFireconnectProvider).models.map((m) => m.id);
      assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-5"]);
    });
  });

  it("re-running on --router is idempotent on the curated model set (no duplicates)", async () => {
    await withTempHome("vscode-fr-reon-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      const ids = arr.find(isFireconnectProvider).models.map((m) => m.id);
      assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]);
    });
  });

  it("re-running on --router reuses the plaintext Fireworks header key when no other source is available", async () => {
    await withTempHome("vscode-fr-reuse-header-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      // First enable: supply the Fireworks key via env only (not --api-key), so
      // it is NOT persisted to keychain/global — it lives only in the JSON header.
      const first = await runCli(
        ["vscode", "on", "--router", "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: { ...secretEnv(), FIREWORKS_API_KEY: FW_KEY } },
      );
      assert.equal(first.code, 0, `stderr: ${first.stderr}`);

      // Re-run with NO Fireworks credential anywhere (no --api-key, no env, no
      // global, no keychain) and no --anthropic-api-key. The Fireworks key must
      // be recovered from the requestHeaders literal the first enable wrote, and
      // the Anthropic key from the fw- secret; otherwise this throws MISSING_KEY.
      const second = await runCli(
        ["vscode", "on", "--router", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(second.code, 0, `stderr: ${second.stderr}`);
      const arr = await readJson(vscodePath);
      for (const model of arr.find(isFireconnectProvider).models) {
        assert.equal(model.requestHeaders["X-FireRouter-Fireworks-Key"], FW_KEY);
      }
    });
  });

  it("re-running on --router refreshes the Fireworks key in model requestHeaders", async () => {
    const rotatedKey = "fw_rotated_fireworks_key_000000000000";
    await withTempHome("vscode-fr-rotate-key-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", rotatedKey, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      for (const model of arr.find(isFireconnectProvider).models) {
        assert.equal(model.requestHeaders["X-FireRouter-Fireworks-Key"], rotatedKey);
      }
    });
  });

  it("re-running on --router refreshes model url when --base-url changes", async () => {
    const customBase = "https://router-dev.example.com";
    await withTempHome("vscode-fr-base-url-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--base-url", customBase, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const expectedUrl = `${customBase}/v1/messages`;
      const arr = await readJson(vscodePath);
      for (const model of arr.find(isFireconnectProvider).models) {
        assert.equal(model.url, expectedUrl);
      }
    });
  });

  it("switching router -> direct drops router-shaped models (no FireRouter url/header leak)", async () => {
    await withTempHome("vscode-fr-to-direct-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      // Switch to direct mode (plain `on`).
      const r = await runCli(
        ["vscode", "on", "--api-key", FW_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const arr = await readJson(vscodePath);
      const provider = arr.find(isFireconnectProvider);
      assert.equal(provider.apiType, "chat-completions");
      assert.equal(vscodeFirerouterProviderStatus(arr), "none");
      for (const m of provider.models) {
        assert.doesNotMatch(m.url ?? "", /router\.fireworks\.ai/, `model ${m.id} still points at FireRouter`);
        assert.notEqual(m.apiType, "messages", `model ${m.id} still has apiType messages`);
        assert.equal(
          m.requestHeaders?.["X-FireRouter-Fireworks-Key"],
          undefined,
          `model ${m.id} still carries the plaintext Fireworks header`,
        );
      }
      // The secret row now holds the Fireworks key again (direct mode).
      const secretId = provider.apiKey.match(/^\$\{input:(.+)\}$/)[1];
      assert.equal(readStateSecret(vscodePath, secretId), FW_KEY);
    });
  });

  it("switching direct -> router drops direct models and seeds the curated Claude set", async () => {
    await withTempHome("vscode-direct-to-fr-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      await runCli(
        ["vscode", "on", "--api-key", FW_KEY, "--main", "glm-latest", "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: secretEnv() },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);

      const arr = await readJson(vscodePath);
      assert.equal(vscodeFirerouterProviderStatus(arr), "firerouter");
      const provider = arr.find(isFireconnectProvider);
      const ids = provider.models.map((m) => m.id);
      // The direct-mode glm model is gone; only the curated Claude set remains.
      assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]);
      // The secret row now holds the Anthropic key (router mode).
      const secretId = provider.apiKey.match(/^\$\{input:(.+)\}$/)[1];
      assert.equal(readStateSecret(vscodePath, secretId), SK_ANT_KEY);
    });
  });

  it("on --router falls back to the bundled Claude set when the catalog fetch fails", async () => {
    await withTempHome("vscode-fr-fallback-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      // Unset the models pin + point at an unreachable FireRouter so the
      // .well-known fetch fails and resolveFirerouterClaudeModels falls back.
      const r = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY,
          "--base-url", "http://127.0.0.1:9", "--vscode-path", vscodePath, "--force"],
        { home, env: { ...secretEnv(), FIRECONNECT_ROUTER_MODELS: "" } },
      );
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      const arr = await readJson(vscodePath);
      const ids = arr.find(isFireconnectProvider).models.map((m) => m.id);
      assert.deepEqual(ids, FALLBACK_FIREROUTER_CLAUDE_MODELS.map((m) => m.id));
    });
  });
});
