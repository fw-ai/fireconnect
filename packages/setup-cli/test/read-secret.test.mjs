import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSecretPath = path.join(__dirname, "../lib/read-secret.mjs");

function runReadSecret(input, { allowEmpty = false } = {}) {
  const script = `
    import { readSecret } from ${JSON.stringify(readSecretPath)};
    const value = await readSecret("Key: ", { allowEmpty: ${allowEmpty} });
    process.stdout.write("RESULT:" + JSON.stringify(value));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input,
    encoding: "utf8",
  });
}

function parseResult(stdout) {
  const marker = stdout.lastIndexOf("RESULT:");
  assert.notEqual(marker, -1, stdout);
  return JSON.parse(stdout.slice(marker + "RESULT:".length));
}

describe("readSecret", () => {
  it("reads piped input on non-TTY stdin", () => {
    const result = runReadSecret("secret-key\n", { allowEmpty: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseResult(result.stdout), "secret-key");
  });

  it("allows empty input when configured", () => {
    const result = runReadSecret("\n", { allowEmpty: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseResult(result.stdout), "");
  });

  it("rejects empty input by default", () => {
    const result = runReadSecret("\n");
    assert.notEqual(result.status, 0);
  });
});
