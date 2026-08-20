import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFireworksSettings } from "../../../lib/harnesses/claude/core.mjs";
import {
  assertClaudeModelOverrides,
  resolveClaudeModelMapping,
} from "../../../lib/harnesses/claude/model-profile.mjs";
import {
  CLAUDE_NATIVE_MODEL_ID,
  CLAUDE_NATIVE_SLOT_ALIAS,
  isAnthropicModelId,
  isClaudeNativeModel,
  normalizeModelId,
} from "../../../lib/fireworks/model-id.mjs";
import { isModelIdValidationApplicable } from "../../../lib/fireworks/model-servability.mjs";

const FW_KEY = "fw_test_claude_key_00000000000000";

// Spellings of FireConnect's internal unpinned-slot sentinel. Users are given
// `native` for this intent; every other spelling names nothing servable, so
// passing one as a slot value is rejected rather than quietly reinterpreted.
const SENTINEL_SPELLINGS = [
  "claude-default",
  "CLAUDE-DEFAULT",
  "Claude-Default",
  "claude-default[1m]",
  "CLAUDE-DEFAULT[1m]",
  "accounts/fireworks/models/claude-default",
];

const SLOT_FLAGS = {
  main: "--model",
  opus: "--opus",
  sonnet: "--sonnet",
  haiku: "--haiku",
  fable: "--fable",
  subagent: "--subagent",
};

function settingsFor(overrides) {
  const { settings } = buildFireworksSettings({ env: {} }, {
    apiKey: FW_KEY,
    mapping: resolveClaudeModelMapping(overrides, "fireworks"),
  });
  return settings;
}

describe("Claude native slot sentinel is not user input", () => {
  for (const spelling of SENTINEL_SPELLINGS) {
    for (const [slot, flag] of Object.entries(SLOT_FLAGS)) {
      it(`rejects ${flag} ${spelling}`, () => {
        assert.throws(
          () => assertClaudeModelOverrides({ [slot]: spelling }),
          (error) => {
            assert.match(error.message, /is not a model id/);
            assert.ok(
              error.message.includes(`${flag} ${CLAUDE_NATIVE_SLOT_ALIAS}`),
              `expected guidance toward \`${flag} native\`, got: ${error.message}`,
            );
            return true;
          },
        );
      });
    }
  }

  it("accepts the documented native alias in every slot", () => {
    const overrides = Object.fromEntries(
      Object.keys(SLOT_FLAGS).map((slot) => [slot, "native"]),
    );
    assert.doesNotThrow(() => assertClaudeModelOverrides(overrides));
  });

  it("accepts concrete Anthropic and Fireworks ids", () => {
    assert.doesNotThrow(() => assertClaudeModelOverrides({
      sonnet: "claude-sonnet-4-5",
      opus: "glm-fast-latest",
      main: "kimi-fast-latest",
    }));
  });

  it("ignores unset slots", () => {
    assert.doesNotThrow(() => assertClaudeModelOverrides({}));
    assert.doesNotThrow(() => assertClaudeModelOverrides({ sonnet: "" }));
  });

  // Bare "claude" names no concrete model. Folding it into the sentinel would
  // exempt it from catalog validation, replacing an accurate "not available on
  // Fireworks" with a guess about what the user meant.
  it("leaves bare claude to catalog validation", () => {
    assert.equal(isClaudeNativeModel("claude"), false);
    assert.equal(isAnthropicModelId("claude"), false);
    assert.equal(isModelIdValidationApplicable("claude"), true);
    assert.doesNotThrow(() => assertClaudeModelOverrides({ sonnet: "claude" }));
  });
});

describe("Claude native slot sentinel canonicalization", () => {
  // Saved profiles and settings written by older releases legitimately carry the
  // sentinel, so the mapping layer canonicalizes these instead of rejecting them.
  for (const spelling of [...SENTINEL_SPELLINGS, "native", "NATIVE", " native "]) {
    it(`normalizes ${JSON.stringify(spelling)} to the sentinel`, () => {
      const normalized = normalizeModelId(spelling);
      assert.equal(normalized, CLAUDE_NATIVE_MODEL_ID);
      assert.equal(isClaudeNativeModel(normalized), true);
      // A spelling that slips past the native check is classified as a real
      // Anthropic model and written into settings.json verbatim.
      assert.equal(isAnthropicModelId(normalized), false);
    });

    it(`leaves main unpinned for ${JSON.stringify(spelling)}`, () => {
      assert.equal(settingsFor({ main: spelling }).model, undefined);
    });

    it(`writes no sonnet pin for ${JSON.stringify(spelling)}`, () => {
      const { env } = settingsFor({ sonnet: spelling });
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, undefined);
      assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION, undefined);
    });

    it(`never leaks the sentinel into settings for ${JSON.stringify(spelling)}`, () => {
      const settings = settingsFor(
        Object.fromEntries(Object.keys(SLOT_FLAGS).map((slot) => [slot, spelling])),
      );
      assert.doesNotMatch(JSON.stringify(settings), /claude-default/i);
    });
  }

  it("still pins concrete Anthropic model ids", () => {
    assert.equal(isAnthropicModelId("claude-sonnet-4-5"), true);
    const { env } = settingsFor({ sonnet: "claude-sonnet-4-5" });
    // Pinned verbatim: the [1m] suffix is only added for Anthropic ids that
    // actually ship 1M context, and Sonnet 4.5 is not one of them.
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-4-5");
  });

  it("tags concrete Anthropic ids that do ship 1M context", () => {
    // The other half of the policy above, so narrowing or widening the 1M set
    // cannot silently drop the suffix for every model.
    const { env } = settingsFor({ sonnet: "claude-sonnet-5" });
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-5[1m]");
  });

  it("clears a sentinel pin left behind by an earlier install", () => {
    const { settings } = buildFireworksSettings({
      model: "CLAUDE-DEFAULT[1m]",
      env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: "CLAUDE-DEFAULT[1m]",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "CLAUDE DEFAULT",
      },
    }, {
      apiKey: FW_KEY,
      mapping: resolveClaudeModelMapping({ sonnet: "native" }, "fireworks"),
    });
    assert.equal(settings.model, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, undefined);
  });
});
