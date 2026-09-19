import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveClaudeActivationPlan,
} from "../../../lib/harnesses/claude/activation.mjs";
import {
  CLAUDE_MODEL_SLOTS,
  defaultClaudeModelMapping,
  inferClaudeActiveKeyType,
  mappingUsesBareFirerouter,
  migrateLegacyClaudeModelMapping,
  normalizeClaudeProfiles,
  savedClaudeModelMapping,
  withSavedClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import {
  claudeExtraPickerModelFromCtx,
} from "../../../lib/harnesses/claude/connect.mjs";
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

  it("leaves fireworks tier slots native regardless of saved live mapping", () => {
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
    assert.deepEqual(plan.mapping, defaultClaudeModelMapping("fireworks"));
  });

  it("tracks --model as a picker addition without pinning tier slots", () => {
    const ctx = { ...EMPTY_OVERRIDES, main: "glm-latest" };
    assert.equal(claudeExtraPickerModelFromCtx(ctx), "glm-latest");
    const plan = resolveClaudeActivationPlan({
      ctx,
      keyType: "fireworks",
      activeKeyType: "",
      snapshot: { profiles: {}, intent: null },
    });
    assert.deepEqual(plan.mapping, defaultClaudeModelMapping("fireworks"));
  });

  it("leaves tier slots native on first connect", () => {
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "fireworks",
      activeKeyType: "",
      snapshot: { profiles: {}, intent: null },
    });
    assert.equal(plan.mapping.opus, CLAUDE_NATIVE_MODEL_ID);
    assert.equal(plan.mapping.sonnet, CLAUDE_NATIVE_MODEL_ID);
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

  it("migrates baked-in legacy slots for firepass profiles", () => {
    const profiles = withSavedClaudeModelMapping({}, "firepass", {
      ...defaultClaudeModelMapping("firepass"),
      haiku: "deepseek-v4-flash",
      subagent: "deepseek-v4-flash",
    });
    const plan = resolveClaudeActivationPlan({
      ctx: EMPTY_OVERRIDES,
      keyType: "firepass",
      snapshot: {
        profiles,
        intent: {
          mapping: {
            ...defaultClaudeModelMapping("firepass"),
            haiku: "deepseek-v4-flash",
            subagent: "deepseek-v4-flash",
          },
        },
      },
      activeKeyType: "firepass",
    });
    assert.equal(plan.mapping.haiku, "deepseek-flash-latest");
    assert.equal(plan.mapping.subagent, "deepseek-flash-latest");
  });

  it("scopes bare-firerouter detection to the firerouter model only", () => {
    const mapping = defaultClaudeModelMapping("fireworks");
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "firerouter" }), true);
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "firerouter[1m]" }), true);
    // Compounds pin their own targets; auto routes open models only.
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "firerouter/kimi-k3" }), false);
    assert.equal(mappingUsesBareFirerouter({ ...mapping, opus: "auto" }), false);
    assert.equal(mappingUsesBareFirerouter(mapping), false);
  });
});
