import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { printHelp } from "../../lib/cli/commands/global.mjs";
import {
  supportsAnthropicApiKeyFlag,
  supportsRoutingPreference,
} from "../../lib/firerouter/flag.mjs";
import { HARNESSES } from "../../lib/harness/id.mjs";
import { getHarness } from "../../lib/harness/registry.mjs";

function helpTextFor(harnessId) {
  const original = console.log;
  let text = "";
  console.log = (line = "") => { text += `${line}\n`; };
  try {
    printHelp(harnessId);
  } finally {
    console.log = original;
  }
  return text;
}

const advertises = (help, flag) => new RegExp(`^\\s+--${flag}\\b`, "m").test(help);

describe("harness help flag contract", () => {
  // `<harness> help` must not offer a FireRouter flag that harness.mjs rejects.
  it("advertises FireRouter flags only where the harness accepts them", () => {
    for (const harnessId of HARNESSES) {
      const { firerouter } = getHarness(harnessId);
      const help = helpTextFor(harnessId);
      assert.equal(
        advertises(help, "routing-preference"),
        supportsRoutingPreference(firerouter),
        `${harnessId}: --routing-preference in help must match runtime support`,
      );
      assert.equal(
        advertises(help, "anthropic-api-key"),
        supportsAnthropicApiKeyFlag(firerouter),
        `${harnessId}: --anthropic-api-key in help must match runtime support`,
      );
    }
  });

  it("keeps Codex on env-reference BYOK without a routing preference", () => {
    const help = helpTextFor("codex");
    assert.equal(getHarness("codex").firerouter.byok, "envref");
    assert.equal(advertises(help, "routing-preference"), false);
    assert.equal(advertises(help, "anthropic-api-key"), true);
  });
});
