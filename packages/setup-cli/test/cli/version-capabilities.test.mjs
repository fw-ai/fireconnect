import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { withTempHome } from "../helpers.mjs";

const cli = fileURLToPath(new URL("../../bin/nexus.mjs", import.meta.url));
it("version capability discovery is additive and never migrates legacy HOME", async () => {
  await withTempHome("version-capabilities-", async (home) => {
    mkdirSync(path.join(home, ".fireconnect"));
    writeFileSync(path.join(home, ".fireconnect", "config.json"), '{"nexusAccount":true}');
    for (const args of [["--version", "--json"], ["--json", "-V"]]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { HOME: home, USERPROFILE: home, NEXUS_NO_UPDATE_CHECK: "1" }, encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      const info = JSON.parse(result.stdout);
      assert.equal(typeof info.version, "string");
      assert.ok(info.capabilities.includes("login-account-type-v1"));
      assert.equal(result.stderr, "");
      assert.deepEqual(readdirSync(home), [".fireconnect"]);
      assert.equal(readFileSync(path.join(home, ".fireconnect", "config.json"), "utf8"), '{"nexusAccount":true}');
    }
  });
});


it("capability discovery works in a dependency-free checkout without installing anything", async () => {
  await withTempHome("version-no-deps-", async (root) => {
    const checkout = path.join(root, "checkout");
    const home = path.join(root, "home");
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    mkdirSync(path.join(checkout, "lib/system"), { recursive: true });
    mkdirSync(home);
    for (const file of ["bin/nexus.mjs", "lib/system/ensure-cli-deps.mjs", "lib/system/win-command.mjs", "lib/system/version.mjs", "lib/system/legacy-env.mjs"]) {
      copyFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), path.join(checkout, file));
    }
    writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ type: "module", version: "0.0.0", dependencies: { "never-install-test-dependency": "0" } }));
    const result = spawnSync(process.execPath, [path.join(checkout, "bin/nexus.mjs"), "--version", "--json"], {
      env: { HOME: home, USERPROFILE: home, PATH: "" }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: "0.0.0", capabilities: ["login-account-type-v1"] });
    assert.equal(result.stderr, "");
    assert.deepEqual(readdirSync(home), []);
    assert.deepEqual(readdirSync(checkout).sort(), ["bin", "lib", "package.json"]);
  });
});
