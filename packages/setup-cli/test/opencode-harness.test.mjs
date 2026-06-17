import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPENCODE_FIREWORKS_PROVIDER_ID, opencodeConfigPath } from "../lib/opencode-core.mjs";

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

describe("opencode harness integration", () => {
  it("on/off round-trip restores opencode.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-opencode-"));
    const configDir = path.join(home, ".config/opencode");
    await mkdir(configDir, { recursive: true });
    const configPath = opencodeConfigPath(home);
    const original = JSON.stringify({ model: "openai/gpt-4", provider: {} }, null, 2) + "\n";
    await writeFile(configPath, original);

    const onResult = await runFireconnect(
      ["opencode", "on", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "fw_test_key_12345" },
    );
    assert.equal(onResult.code, 0);

    const enabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.ok(enabled.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]);
    assert.equal(enabled.provider?.fireworks, undefined);
    assert.ok(enabled.model.startsWith(`${OPENCODE_FIREWORKS_PROVIDER_ID}/`));

    const offResult = await runFireconnect(["opencode", "off"], { HOME: home });
    assert.equal(offResult.code, 0);

    const restored = await readFile(configPath, "utf8");
    assert.equal(restored, original);
  });
});
