import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  demoCliModel,
  prepareRouteSettings,
} from "../../lib/demo/route-settings.mjs";
import { FIRECONNECT_REQUIRED_MSG } from "../../lib/demo/demo-prep.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";

async function seedFireconnectedClaude(home) {
  const settingsDir = path.join(home, ".claude");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
        ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_testkey",
      },
    }),
  );
}

test("demoCliModel: Anthropic slots pass through unchanged", () => {
  assert.equal(demoCliModel("opus"), "opus");
  assert.equal(demoCliModel("sonnet"), "sonnet");
});

test("demoCliModel: Fireworks models get Claude Code context suffix when needed", () => {
  assert.equal(demoCliModel("glm-5p2-fast"), "glm-5p2-fast[1m]");
  assert.equal(demoCliModel("kimi-k2p6-fast"), "kimi-k2p6-fast");
});

test("prepareRouteSettings: resolves left/right cli models when claude is on", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-demo-route-"));
  try {
    await seedFireconnectedClaude(home);
    const result = await prepareRouteSettings({
      leftModel: "opus",
      rightModel: "glm-5p2-fast",
      home,
    });
    assert.equal(result.leftCliModel, "opus");
    assert.equal(result.rightCliModel, "glm-5p2-fast[1m]");
    assert.equal(typeof result.cleanup, "function");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("prepareRouteSettings: requires fireconnect claude on", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-demo-route-off-"));
  try {
    await assert.rejects(
      prepareRouteSettings({ leftModel: "opus", rightModel: "glm-5p2-fast", home }),
      (err) => err.message === FIRECONNECT_REQUIRED_MSG,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
