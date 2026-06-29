import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../lib/parse-args.mjs";
import { globalConfigPath } from "../lib/global-config.mjs";

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

describe("configure storage semantics", () => {
  it("stores a literal API key in global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-store-"));
    const result = await runFireconnect(
      ["configure", "--harnesses", "pi", "--api-key", "fw_test_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Stored Fireworks API key in global config/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.apiKey, "fw_test_key_12345");
    assert.equal(config.harnesses.pi.enabled, false);
  });

  it("preserves an existing API key when configure omits --api-key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-preserve-"));
    await runFireconnect(
      ["configure", "--harnesses", "pi", "--api-key", "fw_existing_key_12345"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );

    const result = await runFireconnect(
      ["configure", "--harnesses", "pi"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Kept existing API key in global config/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.apiKey, "fw_existing_key_12345");
    assert.equal(config.harnesses.pi.enabled, false);
  });

  it("reports when no API key is stored", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-no-key-"));
    const result = await runFireconnect(
      ["configure", "--harnesses", "pi"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No API key in config/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.apiKey, "");
  });

  it("does not persist FIREWORKS_API_KEY from the environment without --api-key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-env-"));
    const result = await runFireconnect(
      ["configure", "--harnesses", "pi"],
      { HOME: home, FIREWORKS_API_KEY: "fw_env_key_should_not_persist" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No API key in config/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.apiKey, "");
  });

  it("stores a literal Anthropic API key in global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-anthropic-"));
    const result = await runFireconnect(
      [
        "configure",
        "--harnesses", "claude",
        "--anthropic-api-key", "sk-ant-configure-12345",
      ],
      { HOME: home, ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Stored Anthropic API key in global config/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.anthropicApiKey, "sk-ant-configure-12345");
  });

  it("rejects removed --api-key-mode flag", () => {
    assert.throws(
      () => parseCli(["configure", "--api-key-mode", "literal"]),
      /Unknown argument: --api-key-mode/,
    );
  });
});
