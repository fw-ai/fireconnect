import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canOnboardingSelectFirerouter,
  resolveClaudeActivationPlan,
} from "../../../lib/harnesses/claude/activation.mjs";
import {
  CLAUDE_FIREWORKS_PINNED_DEFAULTS,
  CLAUDE_MODEL_SLOTS,
  defaultClaudeModelMapping,
  FIRST_CONNECT_AUTOMATIC_SONNET_MODEL,
  inferClaudeActiveKeyType,
  migrateLegacyClaudeModelMapping,
  normalizeClaudeProfiles,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import { CLAUDE_NATIVE_MODEL_ID } from "../../../lib/fireworks/model-id.mjs";

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
      // Neutral subagent and fable so neither profile clears the strong-match
      // threshold. Fable matters because kimi-fast-latest is both the fireworks
      // fable default and the whole firepass mapping, so leaving it would score
      // for both profiles and tip firepass over the line.
      subagent: "glm-fast-latest",
      fable: "glm-latest",
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

  it("keeps a live Sonnet pin when Opus is already FireRouter", () => {
    const persisted = {
      ...defaultClaudeModelMapping("fireworks"),
      opus: "firerouter",
      sonnet: "deepseek-pro-latest",
    };
    const profiles = withSavedClaudeModelMapping({}, "fireworks", persisted);
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "fireworks",
      activeKeyType: "fireworks",
      snapshot: { profiles, intent: { mapping: persisted } },
    });
    assert.equal(plan.mapping.sonnet, "deepseek-pro-latest");
  });

  it("honors explicit --sonnet overrides and live custom Sonnet pins", () => {
    const live = {
      ...defaultClaudeModelMapping("fireworks"),
      opus: "firerouter",
      sonnet: "kimi-latest",
    };
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "fireworks",
      activeKeyType: "fireworks",
      snapshot: { profiles: {}, intent: { mapping: live } },
    });
    assert.equal(plan.mapping.sonnet, "kimi-latest");

    const explicit = resolveClaudeActivationPlan({
      ctx: { ...EMPTY_OVERRIDES, sonnet: "deepseek-pro-latest" },
      keyType: "fireworks",
      activeKeyType: "fireworks",
      snapshot: {
        profiles: {},
        intent: {
          mapping: {
            ...defaultClaudeModelMapping("fireworks"),
            opus: "firerouter",
          },
        },
      },
    });
    assert.equal(explicit.mapping.sonnet, "deepseek-pro-latest");
  });

  it("does not rewrite an unpinned native Sonnet slot under FireRouter Opus", () => {
    const live = {
      ...defaultClaudeModelMapping("fireworks"),
      opus: "firerouter",
      sonnet: CLAUDE_NATIVE_MODEL_ID,
    };
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "fireworks",
      activeKeyType: "fireworks",
      snapshot: { profiles: {}, intent: { mapping: live } },
    });
    assert.equal(plan.mapping.sonnet, CLAUDE_NATIVE_MODEL_ID);
  });

  it("moves Sonnet to GLM when Opus switches to FireRouter without a Sonnet override", () => {
    const live = {
      ...defaultClaudeModelMapping("fireworks"),
      opus: "glm-latest",
      sonnet: "deepseek-pro-latest",
    };
    const plan = resolveClaudeActivationPlan({
      ctx: { ...EMPTY_OVERRIDES, opus: "firerouter" },
      keyType: "fireworks",
      activeKeyType: "fireworks",
      snapshot: { profiles: {}, intent: { mapping: live } },
    });
    assert.equal(plan.mapping.opus, "firerouter");
    assert.equal(plan.mapping.sonnet, FIRST_CONNECT_AUTOMATIC_SONNET_MODEL);
  });

  it("auto-pins Opus to firerouter on first connect when FireRouter auth is available", () => {
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "fireworks",
      activeKeyType: "",
      automaticFirerouter: true,
      snapshot: { profiles: {}, intent: null },
    });
    assert.equal(plan.mapping.opus, "firerouter");
    assert.equal(plan.mapping.sonnet, FIRST_CONNECT_AUTOMATIC_SONNET_MODEL);
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

  it("migrates legacy pinned deepseek-v4-flash slots to the deepseek-flash-latest router alias", () => {
    // Bare slug, full accounts/fireworks ref, and [1m]-tagged forms all migrate;
    // unrelated slots pass through unchanged. The writer re-applies [1m] per
    // slot, so the migration target is the bare router alias.
    const migrated = migrateLegacyClaudeModelMapping({
      main: "kimi-fast-latest",
      opus: "accounts/fireworks/models/deepseek-v4-flash",
      sonnet: "glm-5p1",
      haiku: "deepseek-v4-flash",
      fable: "kimi-fast-latest",
      subagent: "deepseek-v4-flash[1m]",
    });
    assert.equal(migrated.changed, true);
    assert.deepEqual(migrated.mapping, {
      main: "kimi-fast-latest",
      opus: "deepseek-flash-latest",
      sonnet: "glm-5p1",
      haiku: "deepseek-flash-latest",
      fable: "kimi-fast-latest",
      subagent: "deepseek-flash-latest",
    });

    // A mapping with no legacy slugs is returned unchanged.
    const clean = migrateLegacyClaudeModelMapping(defaultClaudeModelMapping("fireworks"));
    assert.equal(clean.changed, false);
    assert.deepEqual(clean.mapping, defaultClaudeModelMapping("fireworks"));
  });

  it("migrates baked-in legacy slots but honors explicit per-run overrides", async () => {
    // An existing install has deepseek-v4-flash baked into its live mapping.
    const profiles = withSavedClaudeModelMapping({}, "fireworks", {
      ...defaultClaudeModelMapping("fireworks"),
      haiku: "deepseek-v4-flash",
      subagent: "deepseek-v4-flash",
    });
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "fireworks",
      snapshot: {
        profiles,
        intent: {
          mapping: {
            ...defaultClaudeModelMapping("fireworks"),
            haiku: "deepseek-v4-flash",
            subagent: "deepseek-v4-flash",
          },
        },
      },
      activeKeyType: "fireworks",
    });
    assert.equal(plan.mapping.haiku, "deepseek-flash-latest");
    assert.equal(plan.mapping.subagent, "deepseek-flash-latest");

    // An explicit --haiku deepseek-v4-pro override is honored (not migrated),
    // while the still-default subagent still migrates from the baked-in slug.
    const overridden = resolveClaudeActivationPlan({
      ctx: { ...EMPTY_OVERRIDES, haiku: "deepseek-v4-pro" },
      keyType: "fireworks",
      snapshot: {
        profiles,
        intent: {
          mapping: {
            ...defaultClaudeModelMapping("fireworks"),
            haiku: "deepseek-v4-flash",
            subagent: "deepseek-v4-flash",
          },
        },
      },
      activeKeyType: "fireworks",
    });
    assert.equal(overridden.mapping.haiku, "deepseek-v4-pro");
    assert.equal(overridden.mapping.subagent, "deepseek-flash-latest");
  });
});
