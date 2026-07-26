import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIncumbentSettings,
  buildChallengerSettings,
  ANTHROPIC_DIRECT_BASE_URL,
} from "../../lib/demo/route-settings.mjs";
import { FIREWORKS_ENV_KEYS } from "../../lib/harnesses/claude/core.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import { CLAUDE_FIREROUTER_ENV_KEYS } from "../../lib/firerouter/core.mjs";
import { withoutEnvFireworksKey } from "../helpers.mjs";

// Both builders now produce CLEAN, isolated settings — no baseSettings spread,
// no inherited ~/.claude/settings.json keys. They're written to their own
// CLAUDE_CONFIG_DIR so Claude Code never merges against the user file.

test("buildIncumbentSettings: Anthropic direct base URL + inline Anthropic key", () => {
  const s = buildIncumbentSettings({ anthropicKey: "sk-ant-test" });
  assert.equal(s.env.ANTHROPIC_BASE_URL, ANTHROPIC_DIRECT_BASE_URL);
  assert.equal(s.env.ANTHROPIC_API_KEY, "sk-ant-test");
});

test("buildIncumbentSettings: no apiKeyHelper, no Fireworks/firerouter env, no model", () => {
  const s = buildIncumbentSettings({ anthropicKey: "sk-ant-test" });
  assert.equal(s.apiKeyHelper, undefined);
  assert.equal(s.model, undefined);
  // ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY are the incumbent's legit Anthropic-
  // direct routing + auth; every OTHER Fireworks/firerouter-owned key is absent.
  for (const k of [...FIREWORKS_ENV_KEYS, ...CLAUDE_FIREROUTER_ENV_KEYS]) {
    if (k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_API_KEY") continue;
    assert.equal(s.env[k], undefined, `${k} must not be set on the incumbent`);
  }
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("buildIncumbentSettings: no key still yields a valid (keyless) Anthropic-direct config", () => {
  // The orchestrator rejects an empty key before reaching here, but the builder
  // stays pure: it simply omits ANTHROPIC_API_KEY rather than inventing one.
  const s = buildIncumbentSettings({ anthropicKey: "" });
  assert.equal(s.env.ANTHROPIC_BASE_URL, ANTHROPIC_DIRECT_BASE_URL);
  assert.equal(s.env.ANTHROPIC_API_KEY, undefined);
});

test("buildChallengerSettings: routes to Fireworks direct with the challenger model + inline key", async () => {
  const { settings, token } = await buildChallengerSettings({
    fireworksKey: "fw_testkey",
    challengerModel: "glm-5p2-fast",
  });
  assert.equal(token, "fw_testkey");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, FIREWORKS_BASE_URL);
  assert.equal(settings.env.ANTHROPIC_API_KEY, "fw_testkey");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "fw_testkey");
  // Model mapping pins ANTHROPIC_MODEL to the challenger slug. The [1m] beta
  // tag matches real `fireconnect claude on` storage.
  assert.equal(
    settings.env.ANTHROPIC_MODEL,
    "glm-5p2-fast[1m]",
  );
});

test("buildChallengerSettings: top-level model is the challenger (direct mode)", async () => {
  const { settings } = await buildChallengerSettings({
    fireworksKey: "fw_testkey",
    challengerModel: "glm-5p2-fast",
  });
  assert.equal(settings.model, "glm-5p2-fast[1m]");
});

test("buildChallengerSettings: no apiKeyHelper (isolated, no keychain)", async () => {
  const { settings } = await buildChallengerSettings({
    fireworksKey: "fw_testkey",
    challengerModel: "glm-5p2-fast",
  });
  assert.equal(settings.apiKeyHelper, undefined);
});

test("buildChallengerSettings: throws without a Fireworks key", async () => {
  await withoutEnvFireworksKey(async () => {
    await assert.rejects(
      buildChallengerSettings({ fireworksKey: "", challengerModel: "glm-5p2-fast" }),
      /No Fireworks API key found/,
    );
  });
});
