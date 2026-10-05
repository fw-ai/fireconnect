import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  PI_EXTENSION_DIR_NAME,
  installPiUsageExtension,
  piExtensionsDir,
  piUsageExtensionDir,
  piUsageExtensionImplPath,
  piUsageExtensionInstalled,
  piUsageExtensionStubSource,
  removePiUsageExtension,
} from "../../../lib/harnesses/pi/extension/install.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-ext-"));
  temps.push(home);
  return home;
}

describe("pi usage-bar extension install", () => {
  it("writes a marker-claimed stub with the implementation URL baked in", async () => {
    const home = await tempHome();
    const result = await installPiUsageExtension({ home });
    assert.equal(result.installed, true);
    assert.equal(result.dir, path.join(home, ".pi/agent/extensions", PI_EXTENSION_DIR_NAME));

    const marker = JSON.parse(await readFile(path.join(result.dir, "fireconnect.json"), "utf8"));
    assert.equal(marker.managedBy, "fireconnect");
    assert.equal(marker.impl, pathToFileURL(piUsageExtensionImplPath()).href);

    const stub = await readFile(path.join(result.dir, "index.js"), "utf8");
    assert.match(stub, /module\.exports = async function fireconnectUsageExtension/);
    assert.ok(stub.includes(JSON.stringify(marker.impl)), "the stub imports the exact impl URL");
  });

  it("derives the extensions dir from an explicit settings path", async () => {
    const home = await tempHome();
    const settingsPath = path.join(home, "elsewhere", "agent", "settings.json");
    assert.equal(
      piUsageExtensionDir(home, settingsPath),
      path.join(home, "elsewhere", "agent", "extensions", PI_EXTENSION_DIR_NAME),
    );
    assert.equal(piExtensionsDir(home), path.join(home, ".pi/agent/extensions"));
  });

  it("never touches a user-owned directory of the same name", async () => {
    const home = await tempHome();
    const dir = piUsageExtensionDir(home);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.js"), "// my own extension\n");

    const result = await installPiUsageExtension({ home });
    assert.equal(result.installed, false);
    assert.equal(result.reason, "user");

    const stub = await readFile(path.join(dir, "index.js"), "utf8");
    assert.equal(stub, "// my own extension\n");
    assert.equal(await piUsageExtensionInstalled({ home }), false);
  });

  it("refreshes a stale stub on re-on", async () => {
    const home = await tempHome();
    await installPiUsageExtension({ home });
    // Simulate an upgrade that moved the CLI: rewrite the marker's impl URL to
    // a path that no longer exists, then re-run on.
    const dir = piUsageExtensionDir(home);
    const stale = pathToFileURL("/gone/cli/lib/harnesses/pi/extension/main.mjs").href;
    await writeFile(path.join(dir, "fireconnect.json"), JSON.stringify({ managedBy: "fireconnect", impl: stale }));

    const result = await installPiUsageExtension({ home });
    assert.equal(result.installed, true);
    const marker = JSON.parse(await readFile(path.join(dir, "fireconnect.json"), "utf8"));
    assert.equal(marker.impl, pathToFileURL(piUsageExtensionImplPath()).href, "the stale URL is refreshed");
  });

  it("removes only the marker-claimed directory", async () => {
    const home = await tempHome();
    await installPiUsageExtension({ home });
    const removed = await removePiUsageExtension({ home });
    assert.equal(removed.removed, true);
    assert.equal(await piUsageExtensionInstalled({ home }), false);

    // A user-owned directory of the same name survives off.
    const dir = piUsageExtensionDir(home);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.js"), "// mine\n");
    const untouched = await removePiUsageExtension({ home });
    assert.equal(untouched.removed, false);
    assert.equal(await readFile(path.join(dir, "index.js"), "utf8"), "// mine\n");
  });

  it("removal without any install is a no-op", async () => {
    const home = await tempHome();
    const result = await removePiUsageExtension({ home });
    assert.equal(result.removed, false);
  });

  it("builds a self-contained CommonJS stub source", () => {
    const source = piUsageExtensionStubSource("file:///impl/main.mjs");
    // Valid CommonJS: no top-level ESM syntax outside the dynamic import.
    assert.doesNotMatch(source, /^import /m);
    assert.match(source, /await import\(implUrl\)/);
    assert.match(source, /module\.exports/);
  });
});
