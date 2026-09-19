import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fireworksModelPickerDescription,
  fireworksModelPickerName,
} from "../../../lib/harnesses/claude/picker-labels.mjs";

describe("Claude picker labels", () => {
  it("uses Claude-style per Mtok pricing in descriptions", () => {
    assert.equal(
      fireworksModelPickerDescription("auto"),
      "Intelligent router across open models. Similar performance at lower cost.",
    );
    assert.equal(
      fireworksModelPickerDescription("firerouter"),
      "Intelligent router across Claude and open models. Similar performance at lower cost.",
    );
    const flash = fireworksModelPickerDescription("deepseek-v4-flash");
    assert.equal(flash, "Fireworks serverless · $0.22/$0.66 per Mtok");
    assert.doesNotMatch(flash, /cached in|Rates:/);

    const fast = fireworksModelPickerDescription("glm-5p2-fast");
    assert.equal(fast, "Fireworks serverless · Fast tier · $2.1/$6.6 per Mtok");
  });

  it("still resolves display names from specs", () => {
    assert.match(fireworksModelPickerName("glm-latest"), /GLM/);
  });
});
