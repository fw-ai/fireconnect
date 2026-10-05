import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFireconnectModelPickerOptions,
  FIREPASS_MODEL_PICKER_CONFLICT_MESSAGE,
  INVALID_MODEL_PICKER_MESSAGE,
  isFireconnectModelPicker,
  stripFireconnectModelPicker,
  validateClaudeModelPicker,
  withFireconnectModelPicker,
} from "../../../lib/harnesses/claude/settings-model-picker.mjs";

describe("Claude settings modelPicker", () => {
  it("marks managed picker rows and keeps built-in Anthropic options", () => {
    const next = withFireconnectModelPicker({}, ["auto", "glm-latest"]);
    assert.equal(isFireconnectModelPicker(next.modelPicker), true);
    assert.equal(next.modelPicker.replaceBuiltInOptions, false);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["auto[1m]", "glm-latest[1m]"],
    );
  });

  it("appends missing rows to an existing modelPicker without changing its rows", () => {
    const settings = {
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [{ model: "claude-sonnet-4-6", label: "Mine" }],
      },
    };
    const next = withFireconnectModelPicker(settings, ["auto"]);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["claude-sonnet-4-6", "auto[1m]"],
    );
    assert.equal(next.modelPicker.fireconnectManaged, undefined);
  });

  it("appends missing rows after the FireConnect marker is stripped", () => {
    // What Claude Code leaves behind after persisting a /model pick: our rows,
    // our shape, but the unknown fireconnectManaged key stripped.
    const drifted = {
      modelPicker: {
        replaceBuiltInOptions: false,
        options: [
          { model: "firerouter[1m]", label: "FireRouter" },
          { model: "glm-latest[1m]", label: "GLM 5.3 (Latest)" },
        ],
      },
    };
    const next = withFireconnectModelPicker(drifted, ["firerouter", "glm-latest", "auto"]);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["firerouter[1m]", "glm-latest[1m]", "auto[1m]"],
    );
    assert.equal(next.modelPicker.fireconnectManaged, undefined);
  });

  it("refreshes a managed picker and dedupes normalized ids", () => {
    const settings = {
      modelPicker: {
        fireconnectManaged: true,
        options: [{ model: "glm-latest[1m]" }, { model: "kimi-latest" }],
      },
    };
    const next = withFireconnectModelPicker(settings, [
      "glm-latest",
      "accounts/fireworks/routers/glm-latest",
      "kimi-latest",
      "auto",
    ]);
    assert.deepEqual(
      next.modelPicker.options.map((row) => row.model),
      ["glm-latest[1m]", "kimi-latest", "auto[1m]"],
    );
  });

  it("leaves a complete picker unchanged", () => {
    const settings = withFireconnectModelPicker({}, ["auto"]);
    const refreshed = withFireconnectModelPicker(settings, ["auto", "auto"]);
    assert.equal(refreshed, settings);
    assert.deepEqual(refreshed.modelPicker.options.map((row) => row.model), ["auto[1m]"]);
  });

  it("rejects every malformed pre-existing picker value", () => {
    for (const modelPicker of [
      null,
      "invalid",
      [],
      42,
      { options: "invalid" },
      { options: [null] },
      { options: ["auto"] },
      { options: [{}] },
      { options: [{ model: "" }] },
      { options: [{ model: 42 }] },
    ]) {
      const settings = { modelPicker };
      assert.throws(
        () => withFireconnectModelPicker(settings, ["auto"]),
        (error) => error.message === INVALID_MODEL_PICKER_MESSAGE,
      );
      assert.throws(
        () => validateClaudeModelPicker(settings),
        (error) => error.message === INVALID_MODEL_PICKER_MESSAGE,
      );
    }
  });

  it("adds options when an existing modelPicker has no options field", () => {
    const next = withFireconnectModelPicker({ modelPicker: { replaceBuiltInOptions: false } }, ["auto"]);
    assert.deepEqual(next.modelPicker.options.map((row) => row.model), ["auto[1m]"]);
  });

  it("allows a fresh Fire Pass user picker but rejects a standard-to-Fire-Pass ambiguity", () => {
    const settings = {
      modelPicker: { options: [{ model: "claude-sonnet-4-6" }] },
    };
    assert.doesNotThrow(() => validateClaudeModelPicker(settings, {
      keyType: "firepass",
      priorKeyType: "",
    }));
    assert.throws(
      () => validateClaudeModelPicker(settings, {
        keyType: "firepass",
        priorKeyType: "fireworks",
      }),
      (error) => error.message === FIREPASS_MODEL_PICKER_CONFLICT_MESSAGE,
    );
  });

  it("strips only FireConnect-managed modelPicker blocks", () => {
    const managed = withFireconnectModelPicker({}, ["auto"]);
    const { settings: stripped, changed } = stripFireconnectModelPicker(managed);
    assert.equal(changed, true);
    assert.equal(stripped.modelPicker, undefined);

    const user = {
      modelPicker: { options: [{ model: "claude-opus-4-8" }] },
    };
    const kept = stripFireconnectModelPicker(user);
    assert.equal(kept.changed, false);
    assert.deepEqual(kept.settings, user);
  });

  it("buildFireconnectModelPickerOptions dedupes normalized ids", () => {
    const options = buildFireconnectModelPickerOptions([
      "auto",
      "auto",
      "glm-latest",
      "accounts/fireworks/routers/glm-latest",
    ]);
    assert.equal(options.length, 2);
  });
});
