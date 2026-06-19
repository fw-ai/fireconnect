import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { piSettingsPath, piAuthPath, PI_API_KEY_ENV_REF, PI_DATA_RELATIVE_DIR } from "../lib/pi-core.mjs";

const CLI = path.join(import.meta.dirname, "..", "bin", "fireconnect.mjs");

function runFireconnect(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("pi harness integration", () => {
  it("on/off round-trip restores settings and auth", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-"));
    const settingsDir = path.join(home, ".pi/agent");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const originalSettings = JSON.stringify({ defaultProvider: "openai" }, null, 2) + "\n";
    const originalAuth = JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2) + "\n";
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);

    const onResult = await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabledSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(enabledSettings.defaultProvider, "fireworks");
    assert.ok(enabledSettings.defaultModel.startsWith("accounts/fireworks/"));

    const enabledAuth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(enabledAuth.fireworks.managedBy, "fireconnect");

    const offResult = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restoredSettings = await readFile(settingsPath, "utf8");
    const restoredAuth = await readFile(authPath, "utf8");
    assert.equal(restoredSettings, originalSettings);
    assert.equal(restoredAuth, originalAuth);
  });

  it("writes $FIREWORKS_API_KEY env ref when key comes from environment", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-env-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const authPath = piAuthPath(home);

    const onResult = await runFireconnect(
      ["pi", "on"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);
    assert.match(onResult.stdout, /\$FIREWORKS_API_KEY/);

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(auth.fireworks.key, PI_API_KEY_ENV_REF);
    assert.equal(auth.fireworks.managedBy, "fireconnect");
  });

  it("second off after on/off round-trip leaves settings unchanged", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-double-off-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const originalSettings = JSON.stringify({ defaultProvider: "openai" }, null, 2) + "\n";
    const originalAuth = JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2) + "\n";
    await writeFile(settingsPath, originalSettings);
    await writeFile(authPath, originalAuth);

    await runFireconnect(
      ["pi", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    await runFireconnect(["pi", "off"], { HOME: home });

    const secondOff = await runFireconnect(["pi", "off"], { HOME: home });
    assert.equal(secondOff.code, 0);
    assert.match(secondOff.stdout, /not enabled for Pi/);

    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
  });

  it("re-on after data dir wipe snapshots so off can restore", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-wipe-"));
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const env = { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" };

    await writeFile(settingsPath, `${JSON.stringify({ defaultProvider: "openai" }, null, 2)}\n`);
    await writeFile(authPath, `${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2)}\n`);

    await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], env);
    const beforeReOnSettings = await readFile(settingsPath, "utf8");
    const beforeReOnAuth = await readFile(authPath, "utf8");

    await rm(path.join(home, PI_DATA_RELATIVE_DIR), { recursive: true, force: true });

    await runFireconnect(["pi", "on", "--api-key", "fw_test_key_12345"], env);
    await runFireconnect(["pi", "off"], env);

    assert.equal(await readFile(settingsPath, "utf8"), beforeReOnSettings);
    assert.equal(await readFile(authPath, "utf8"), beforeReOnAuth);
  });
});
