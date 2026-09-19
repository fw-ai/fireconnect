import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  printClaudePickerSummary,
} from "../../../lib/harnesses/claude/onboarding.mjs";
import {
  defaultClaudeModelMapping,
  mergeClaudeModelMappings,
} from "../../../lib/harnesses/claude/model-profile.mjs";

// Baseline mapping from defaultClaudeModelMapping() for picker summary tests.
const DEFAULTS = defaultClaudeModelMapping();

function outputBuffer() {
  let text = "";
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    text: () => text,
  };
}

describe("Claude model onboarding", () => {
  it("merges defaults, stored, live, and flags from lowest to highest", () => {
    assert.deepEqual(
      mergeClaudeModelMappings(
        DEFAULTS,
        { opus: "stored-opus", sonnet: "stored-sonnet" },
        { sonnet: "live-sonnet", haiku: "live-haiku" },
        { opus: "flag-opus", subagent: "" },
      ),
      {
        ...DEFAULTS,
        opus: "flag-opus",
        sonnet: "live-sonnet",
        haiku: "live-haiku",
      },
    );
  });

  it("prints the picker summary without tier slot rows for fireworks", () => {
    const output = outputBuffer();
    printClaudePickerSummary({ extraPickerModel: null, firepass: false }, output);
    const text = output.text();
    assert.match(text, /Model picker/);
    assert.match(text, /Anthropic model slots.*unchanged/);
    assert.match(text, /Fireworks catalog.*appended/);
    assert.doesNotMatch(text, /Fable|Opus|Main/);
  });

  it("prints an Added via --model row when main is pinned", () => {
    const output = outputBuffer();
    printClaudePickerSummary({
      extraPickerModel: "glm-latest",
      firepass: false,
    }, output);
    const text = output.text();
    assert.match(text, /Added via --model.*glm-latest/);
  });

  it("prints the Fire Pass summary instead of the catalog rows", () => {
    const output = outputBuffer();
    printClaudePickerSummary({ extraPickerModel: null, firepass: true }, output);
    const text = output.text();
    assert.match(text, /Fire Pass.*pinned routers/);
    assert.doesNotMatch(text, /Anthropic model slots/);
  });
});
