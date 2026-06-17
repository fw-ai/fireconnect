import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyModelMapping,
  enableFireworksProvider,
  FIREWORKS_BASE_URL,
  userSettingsPath,
} from "../lib/fireconnect-core.mjs";

describe("applyModelMapping", () => {
  it("updates ANTHROPIC_MODEL, top-level model, and custom option for main", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-apply-map-"));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = userSettingsPath(home);
    const dataDir = path.join(home, ".fireconnect/claude");

    await enableFireworksProvider({
      settingsPath,
      dataDir,
      apiKey: "fw_test_key_12345",
      baseUrl: FIREWORKS_BASE_URL,
    });

    const newMain = "accounts/fireworks/models/glm-5p1";
    await applyModelMapping({
      settingsPath,
      mapping: {
        main: newMain,
        opus: "accounts/fireworks/routers/kimi-k2p7-code-fast",
        sonnet: "accounts/fireworks/models/glm-5p1",
        haiku: "accounts/fireworks/models/minimax-m2p5",
        subagent: "accounts/fireworks/models/minimax-m2p5",
      },
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_MODEL, newMain);
    assert.equal(settings.model, newMain);
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, newMain);
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "glm-5p1 via Fireworks");
  });
});
