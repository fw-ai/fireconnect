import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../lib/parse-args.mjs";
import { globalConfigPath } from "../lib/global-config.mjs";
import { runFireconnect } from "./helpers.mjs";

describe("configure (provider / FireRouter setup)", () => {
  it("stores a literal Anthropic API key in global config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-anthropic-"));
    const result = await runFireconnect(
      ["configure", "--anthropic-api-key", "sk-ant-configure-12345"],
      { HOME: home, ANTHROPIC_API_KEY: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Stored Anthropic API key in global config/);

    const config = JSON.parse(await readFile(globalConfigPath(home), "utf8"));
    assert.equal(config.anthropicApiKey, "sk-ant-configure-12345");
  });

  it("rejects --api-key unless --provider azure (Fireworks key belongs to login)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-apikey-guard-"));
    const result = await runFireconnect(
      ["configure", "--api-key", "fw_should_not_store_here"],
      { HOME: home, FIREWORKS_API_KEY: "" },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /fireconnect login/);
    assert.match(result.stderr, /requires --provider azure/);
  });

  it("prints guidance and exits 0 when nothing is configured", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-configure-noop-"));
    const result = await runFireconnect(["configure"], { HOME: home, FIREWORKS_API_KEY: "" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Nothing to configure/);
    assert.match(result.stdout, /fireconnect login/);
  });

  it("rejects removed --api-key-mode flag", () => {
    assert.throws(
      () => parseCli(["configure", "--api-key-mode", "literal"]),
      /Unknown argument: --api-key-mode/,
    );
  });
});
