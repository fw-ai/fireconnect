import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFireconnectModelPickerOptions,
  isFireconnectModelPicker,
  stripFireconnectModelPicker,
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

  it("does not clobber a user-defined modelPicker", () => {
    const settings = {
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [{ model: "claude-sonnet-4-6", label: "Mine" }],
      },
    };
    const next = withFireconnectModelPicker(settings, ["auto"]);
    assert.equal(next, settings);
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

  it("buildFireconnectModelPickerOptions dedupes ids", () => {
    const options = buildFireconnectModelPickerOptions(["auto", "auto", "glm-latest"]);
    assert.equal(options.length, 2);
  });
});
