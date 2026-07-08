import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FIREWORKS_API_KEY_KEYCHAIN_REF, readGlobalConfig, writeGlobalConfig } from "../lib/global-config.mjs";
import { chatLanguageModelsPath } from "../lib/vscode-core.mjs";
import { runFireconnect, runCli, seedKeychainConfig, withTempHome } from "./helpers.mjs";

const FW_KEY = "fw_test_fireworks_key_00000000000000";
const SK_ANT_KEY = "sk-ant-test-anthropic-key-zzz";
// Plaintext secret seam + pinned router model set → deterministic, offline.
const vscodeRouterEnv = () => ({
  FIRECONNECT_VSCODE_SECRET_PLAINTEXT: "1",
  FIRECONNECT_ROUTER_MODELS: "claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5",
  // `status` live-verifies the active key; point at an unreachable gateway so
  // these storage/per-harness assertions stay offline and deterministic.
  FIRECONNECT_GATEWAY_URL: "http://127.0.0.1:1",
});

describe("fireconnect key", () => {
  it("export prints the stored keychain secret (internal apiKeyHelper/shell-hook resolver)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-export-"));
    await seedKeychainConfig(home, "fw_export_test_key");

    const result = await runFireconnect(["key", "export"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "fw_export_test_key");
  });

  it("status reports keychain-backed config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-key-status-"));
    await seedKeychainConfig(home, "fw_status_test_key");

    const result = await runFireconnect(["status", "--json"], {
      HOME: home,
      FIREWORKS_API_KEY: "",
      // Offline verify: a stored key is present, so status exits 0 once the
      // (unreachable) gateway check comes back as "couldn't verify".
      FIRECONNECT_GATEWAY_URL: "http://127.0.0.1:1",
    });
    assert.equal(result.code, 0);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.configRef, FIREWORKS_API_KEY_KEYCHAIN_REF);
    assert.equal(summary.keychainPresent, true);
  });

  it("status flags the plaintext Fireworks-key location for vscode in FireRouter mode", async () => {
    await withTempHome("fc-key-status-vscode-router-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const on = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: vscodeRouterEnv() },
      );
      assert.equal(on.code, 0, `stderr: ${on.stderr}`);

      // status live-verifies against an unreachable gateway (see vscodeRouterEnv);
      // exit code reflects auth, which is irrelevant here — assert on storage only.
      const status = await runCli(["status", "--json"], { home, env: vscodeRouterEnv() });
      const vscode = JSON.parse(status.stdout).perHarness.find((h) => h.id === "vscode");
      assert.equal(vscode.enabled, true);
      // Auditable: the Fireworks key is a plaintext literal in chatLanguageModels.json.
      assert.match(vscode.storage, /PLAINTEXT/);
      assert.match(vscode.storage, /chatLanguageModels\.json/);
      assert.match(vscode.readsFrom, /X-FireRouter-Fireworks-Key/);
    });
  });

  it("status flags plaintext Fireworks-key location when vscode disk is router but config is not", async () => {
    await withTempHome("fc-key-status-vscode-diverge-", async (home) => {
      // status reads the default VS Code path for home, not a custom --vscode-path.
      const vscodePath = chatLanguageModelsPath({ home });
      const on = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: vscodeRouterEnv() },
      );
      assert.equal(on.code, 0, `stderr: ${on.stderr}`);

      // Simulate setHarnessEnabled failing after enableFirerouterVscode wrote disk.
      const config = await readGlobalConfig(home);
      await writeGlobalConfig(home, {
        ...config,
        harnesses: { ...config.harnesses, vscode: { enabled: true, mode: "direct" } },
      });

      // status live-verifies against an unreachable gateway (see vscodeRouterEnv);
      // exit code reflects auth, which is irrelevant here — assert on storage only.
      const status = await runCli(["status", "--json"], { home, env: vscodeRouterEnv() });
      const vscode = JSON.parse(status.stdout).perHarness.find((h) => h.id === "vscode");
      assert.match(vscode.storage, /PLAINTEXT/);
      assert.match(vscode.storage, /chatLanguageModels\.json/);
      assert.match(vscode.readsFrom, /X-FireRouter-Fireworks-Key/);
    });
  });

  it("status reports direct-mode storage when vscode disk is direct but config is router", async () => {
    await withTempHome("fc-key-status-vscode-diverge-direct-", async (home) => {
      const vscodePath = chatLanguageModelsPath({ home });
      const routerOn = await runCli(
        ["vscode", "on", "--router", "--api-key", FW_KEY, "--anthropic-api-key", SK_ANT_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: vscodeRouterEnv() },
      );
      assert.equal(routerOn.code, 0, `stderr: ${routerOn.stderr}`);

      const directOn = await runCli(
        ["vscode", "on", "--api-key", FW_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: vscodeRouterEnv() },
      );
      assert.equal(directOn.code, 0, `stderr: ${directOn.stderr}`);

      // Simulate setHarnessEnabled failing after enableVscodeFireworks wrote disk.
      const config = await readGlobalConfig(home);
      await writeGlobalConfig(home, {
        ...config,
        harnesses: { ...config.harnesses, vscode: { enabled: true, mode: "router" } },
      });

      // status live-verifies against an unreachable gateway (see vscodeRouterEnv);
      // exit code reflects auth, which is irrelevant here — assert on storage only.
      const status = await runCli(["status", "--json"], { home, env: vscodeRouterEnv() });
      const vscode = JSON.parse(status.stdout).perHarness.find((h) => h.id === "vscode");
      assert.match(vscode.storage, /safeStorage \(encrypted\)/);
      assert.doesNotMatch(vscode.storage, /PLAINTEXT/);
      assert.match(vscode.readsFrom, /state\.vscdb/);
    });
  });

  it("status reports encrypted safeStorage for vscode in direct mode", async () => {
    await withTempHome("fc-key-status-vscode-direct-", async (home) => {
      const vscodePath = path.join(home, "chatLanguageModels.json");
      const on = await runCli(
        ["vscode", "on", "--api-key", FW_KEY, "--vscode-path", vscodePath, "--force"],
        { home, env: vscodeRouterEnv() },
      );
      assert.equal(on.code, 0, `stderr: ${on.stderr}`);

      const status = await runCli(["status", "--json"], { home, env: vscodeRouterEnv() });
      const vscode = JSON.parse(status.stdout).perHarness.find((h) => h.id === "vscode");
      assert.match(vscode.storage, /safeStorage \(encrypted\)/);
      assert.doesNotMatch(vscode.storage, /PLAINTEXT/);
    });
  });
});
