import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canOnboardingSelectFirerouter,
  resolveClaudeActivationPlan,
} from "../../../lib/harnesses/claude/activation.mjs";
import {
  CLAUDE_MODEL_SLOTS,
  defaultClaudeModelMapping,
  inferClaudeActiveKeyType,
  normalizeClaudeProfiles,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";

const EMPTY_OVERRIDES = {
  main: "",
  opus: "",
  sonnet: "",
  haiku: "",
  fable: "",
  subagent: "",
};

describe("Claude model profiles", () => {
  it("stores complete mappings in separate key-type namespaces", () => {
    const fireworks = defaultClaudeModelMapping("fireworks");
    const firepass = defaultClaudeModelMapping("firepass");
    let profiles = withSavedClaudeModelMapping({}, "fireworks", fireworks);
    profiles = withSavedClaudeModelMapping(profiles, "firepass", firepass);

    assert.deepEqual(savedClaudeModelMapping(profiles, "fireworks"), fireworks);
    assert.deepEqual(savedClaudeModelMapping(profiles, "firepass"), firepass);
    assert.ok(CLAUDE_MODEL_SLOTS.every((slot) => firepass[slot] === "kimi-fast-latest"));
  });

  it("ignores legacy, incomplete, and malformed profile entries", () => {
    assert.deepEqual(normalizeClaudeProfiles({
      models: defaultClaudeModelMapping(),
      fireworks: { version: 1, models: { main: "glm-latest" } },
      firepass: { version: 99, models: defaultClaudeModelMapping("firepass") },
    }), {});
  });

  it("ignores an active mapping from a different key type", () => {
    const firepass = defaultClaudeModelMapping("firepass");
    const profiles = withSavedClaudeModelMapping({}, "firepass", firepass);
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "firepass",
      activeKeyType: "fireworks",
      snapshot: {
        profiles,
        intent: {
          mapping: {
            ...defaultClaudeModelMapping("fireworks"),
            main: "glm-latest",
          },
        },
      },
    });

    assert.deepEqual(plan.mapping, firepass);
  });

  it("infers unreadable active mappings from durable profile scope", () => {
    const fireworks = defaultClaudeModelMapping("fireworks");
    const firepass = defaultClaudeModelMapping("firepass");
    let profiles = withSavedClaudeModelMapping({}, "fireworks", fireworks);
    profiles = withSavedClaudeModelMapping(profiles, "firepass", firepass);
    assert.equal(inferClaudeActiveKeyType({
      profiles,
      activeMapping: { ...firepass, main: "glm-latest" },
      currentKeyType: "fireworks",
    }), "firepass");
  });

  it("uses the current key type only for metadata-free legacy mappings", () => {
    assert.equal(inferClaudeActiveKeyType({
      profiles: {},
      activeMapping: defaultClaudeModelMapping("firepass"),
      currentKeyType: "firepass",
    }), "firepass");
    assert.equal(inferClaudeActiveKeyType({
      tokenKeyType: "fireworks",
      recordedKeyType: "firepass",
      profiles: {},
      currentKeyType: "firepass",
    }), "fireworks");
  });

  it("does not infer profile scope from incidental model overlap", () => {
    const firepass = defaultClaudeModelMapping("firepass");
    const profiles = withSavedClaudeModelMapping({}, "firepass", firepass);
    assert.equal(inferClaudeActiveKeyType({
      profiles,
      activeMapping: defaultClaudeModelMapping("fireworks"),
      currentKeyType: "fireworks",
    }), "");
  });

  it("leaves ambiguous profile evidence unknown across a key switch", () => {
    const fireworks = defaultClaudeModelMapping("fireworks");
    const firepass = defaultClaudeModelMapping("firepass");
    let profiles = withSavedClaudeModelMapping({}, "fireworks", fireworks);
    profiles = withSavedClaudeModelMapping(profiles, "firepass", firepass);
    const ambiguous = {
      ...fireworks,
      main: firepass.main,
      opus: firepass.opus,
      sonnet: firepass.sonnet,
    };
    assert.equal(inferClaudeActiveKeyType({
      profiles,
      activeMapping: ambiguous,
      currentKeyType: "firepass",
    }), "");

    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "firepass",
      activeKeyType: "",
      snapshot: { profiles, intent: { mapping: ambiguous } },
    });
    assert.deepEqual(plan.mapping, firepass);
  });

  it("defers routing validation only when the wizard can add FireRouter", () => {
    assert.equal(canOnboardingSelectFirerouter({
      shouldRunOnboarding: true,
      keyType: "fireworks",
      hasFirerouterAuth: true,
    }), true);
    for (const options of [
      { shouldRunOnboarding: false, keyType: "fireworks", hasFirerouterAuth: true },
      { shouldRunOnboarding: true, keyType: "fireworks", hasFirerouterAuth: false },
      { shouldRunOnboarding: true, keyType: "firepass", hasFirerouterAuth: true },
    ]) {
      assert.equal(canOnboardingSelectFirerouter(options), false);
    }
  });
});
