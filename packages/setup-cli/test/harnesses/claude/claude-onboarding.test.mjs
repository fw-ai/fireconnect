import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  printClaudeModelMapping,
  runClaudeMappingEditor,
  runClaudeModelOnboarding,
  standardClaudeModelMapping,
} from "../../../lib/harnesses/claude/onboarding.mjs";
import {
  defaultClaudeModelMapping,
  mergeClaudeModelMappings,
} from "../../../lib/harnesses/claude/model-profile.mjs";

// Mirrors defaultClaudeModelMapping(): main is never pinned and Sonnet stays
// native, so neither is written by `claude on`.
const FAST = {
  main: "claude-default",
  opus: "deepseek-pro-latest",
  sonnet: "claude-default",
  haiku: "deepseek-flash-latest",
  fable: "kimi-fast-latest",
  subagent: "deepseek-flash-latest",
};

function catalogModel(slug, overrides = {}) {
  return {
    id: `accounts/fireworks/routers/${slug}`,
    slug,
    label: slug,
    fast: slug.includes("fast") || slug.includes("flash"),
    contextWindow: 1_000_000,
    vision: slug.includes("kimi"),
    tools: true,
    pricing: { display: "$1 in / $2 out" },
    router: true,
    firerouter: slug === "firerouter",
    ...overrides,
  };
}

const CATALOG = [
  catalogModel("kimi-fast-latest"),
  catalogModel("glm-fast-latest"),
  catalogModel("glm-latest", { fast: false }),
  catalogModel("deepseek-v4-flash"),
  catalogModel("deepseek-v4-pro", { fast: false }),
  catalogModel("gpt-oss-120b", { fast: false }),
  catalogModel("qwen-plus-latest", { fast: false, vision: true }),
  catalogModel("minimax-latest", { fast: false, vision: true }),
  catalogModel("kimi-latest", { fast: false, vision: true }),
];

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
        FAST,
        { opus: "stored-opus", sonnet: "stored-sonnet" },
        { sonnet: "live-sonnet", haiku: "live-haiku" },
        { opus: "flag-opus", subagent: "" },
      ),
      {
        ...FAST,
        opus: "flag-opus",
        sonnet: "live-sonnet",
        haiku: "live-haiku",
      },
    );
  });

  it("keeps the recommended mapping on the one-step default path", async () => {
    const output = outputBuffer();
    const mapping = await runClaudeModelOnboarding({
      recommended: FAST,
      fastDefaults: FAST,
      output,
      select: async ({ message, choices, initialIndex }) => {
        assert.match(message, /Claude model mapping/);
        // Five editable rows: main has no row because it is never pinned.
        assert.equal(initialIndex, 5);
        assert.ok(choices[0].name.includes("Fable"));
        assert.ok(!choices.some((choice) => choice.value.slot === "main"));
        for (const model of Object.values(FAST)) {
          // Native slots are rendered as the "Claude default" label, not the slug.
          const label = model === "claude-default" ? "Claude default" : model;
          assert.ok(choices.some((choice) => choice.name.includes(label)));
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.deepEqual(mapping, FAST);
    assert.match(output.text(), /Set Claude Code model defaults/);
  });

  it("returns an explicit cancellation instead of the baseline mapping", async () => {
    const mapping = await runClaudeModelOnboarding({
      recommended: FAST,
      fastDefaults: FAST,
      output: outputBuffer(),
      select: async () => null,
    });
    assert.equal(mapping, null);
  });

  it("prints one Fable-first final mapping without an unpinned Main", () => {
    const output = outputBuffer();
    printClaudeModelMapping(FAST, output);
    const text = output.text();
    assert.equal((text.match(/Model mapping/g) ?? []).length, 1);
    assert.ok(text.indexOf("Fable") < text.indexOf("Opus"));
    // Main is unpinned here, so it has nothing to report.
    assert.ok(!text.includes("Main"));
    for (const [slot, model] of Object.entries(FAST)) {
      if (slot === "main") continue;
      // Native slots are rendered as the "Claude default" label, not the slug.
      assert.ok(text.includes(model === "claude-default" ? "Claude default" : model));
    }
  });

  it("prints a pinned Main row when one is set", () => {
    const output = outputBuffer();
    printClaudeModelMapping({ ...FAST, main: "glm-latest" }, output);
    const text = output.text();
    assert.ok(text.includes("Main"));
    assert.ok(text.indexOf("Main") < text.indexOf("Fable"));
  });

  it("shows a pinned Main row in the editor and preserves it across mode toggles", async () => {
    const pinned = { ...FAST, main: "glm-latest" };
    let visits = 0;
    const mapping = await runClaudeModelOnboarding({
      recommended: pinned,
      fastDefaults: FAST,
      mappingLabel: "Current",
      output: outputBuffer(),
      select: async ({ message, choices, initialIndex }) => {
        visits += 1;
        if (visits === 1) {
          assert.equal(initialIndex, 6);
          assert.ok(choices.some((choice) => choice.value.slot === "main"));
          assert.ok(choices[0].name.includes("Main"));
          return choices.find((choice) => choice.value.action === "non-fast").value;
        }
        if (visits === 2) {
          assert.match(message, /Non-fast mode/);
          assert.ok(choices.some((choice) => choice.name.includes("Main")));
          assert.ok(choices.some((choice) => choice.name.includes("glm-latest")));
          return choices.find((choice) => choice.value.action === "save").value;
        }
        throw new Error("unexpected select");
      },
    });

    assert.deepEqual(mapping, {
      ...standardClaudeModelMapping(),
      main: "glm-latest",
    });
    assert.equal(visits, 2);
  });

  it("lets the mode toggle update Main on Fire Pass, where it is a normal slot", async () => {
    // Fire Pass has no Anthropic fallback, so both mode mappings pin main and it
    // is an editable row. The toggle must move it like every other slot instead
    // of treating the previous value as a deliberate --model pin.
    const fastFirepass = defaultClaudeModelMapping("firepass");
    const nonFastFirepass = standardClaudeModelMapping("firepass");
    assert.notEqual(fastFirepass.main, nonFastFirepass.main);
    let visits = 0;
    const mapping = await runClaudeModelOnboarding({
      recommended: fastFirepass,
      fastDefaults: fastFirepass,
      keyType: "firepass",
      output: outputBuffer(),
      select: async ({ choices }) => {
        visits += 1;
        if (visits === 1) {
          assert.ok(choices.some((choice) => choice.value.slot === "main"));
          return choices.find((choice) => choice.value.action === "non-fast").value;
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.deepEqual(mapping, nonFastFirepass);
    assert.equal(mapping.main, nonFastFirepass.main);
  });

  it("reports non-fast mode when a preserved Main pin is the only difference", async () => {
    // The toggle keeps a pinned main, so a saved mapping that is otherwise the
    // non-fast set is already in non-fast mode — the header must say so instead
    // of offering a switch that would change nothing visible.
    const nonFast = standardClaudeModelMapping();
    const saved = { ...nonFast, main: "kimi-latest" };
    let seen = null;
    await runClaudeModelOnboarding({
      recommended: saved,
      fastDefaults: FAST,
      mappingLabel: "Current",
      output: outputBuffer(),
      select: async ({ message, choices }) => {
        seen ??= message;
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });
    assert.match(seen, /Non-fast mode/);
  });

  it("uses the shared brand styles for the mapping and profile choices", async () => {
    const previousForceColor = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const output = outputBuffer();
      await runClaudeModelOnboarding({
        recommended: FAST,
        fastDefaults: FAST,
        output,
        select: async ({ choices }) => {
          assert.match(choices[0].name, /\x1b\[1mFable/);
          assert.match(choices[0].name, /\x1b\[36mkimi-fast-latest/);
          const save = choices.find((choice) => choice.value.action === "save");
          assert.match(save.name, /\x1b\[1mSave mapping/);
          assert.match(save.name, /\x1b\[90m· Recommended/);
          return save.value;
        },
      });
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
    }
  });

  it("maps every class to non-fast aliases with the standard profile", async () => {
    let visits = 0;
    const mapping = await runClaudeModelOnboarding({
      recommended: FAST,
      fastDefaults: FAST,
      output: outputBuffer(),
      loadCatalog: async () => CATALOG,
      select: async ({ message, choices }) => {
        if (message.startsWith("Opus ·")) {
          const models = choices
            .map((choice) => choice.value.model)
            .filter(Boolean);
          assert.ok(models.length > 0);
          assert.ok(models.every((model) => !model.fast && !model.firerouter));
          assert.ok(models.every((model) => !/(?:fast|flash|turbo)/i.test(model.slug)));
          return choices.find((choice) => choice.value.action === "search").value;
        }
        visits += 1;
        if (visits === 1) {
          return choices.find((choice) => choice.value.action === "non-fast").value;
        }
        if (visits === 2) {
          assert.match(message, /Non-fast mode/);
          assert.ok(choices.some((choice) => (
            choice.value.action === "fast"
            && choice.name.includes("Use fast models")
          )));
          return choices.find((choice) => choice.value.slot === "opus").value;
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
      search: async ({ items }) => {
        assert.ok(items.length > 5);
        assert.ok(items.every((model) => !model.fast && !model.firerouter));
        return items.find((model) => model.slug === "glm-latest");
      },
    });

    assert.deepEqual(mapping, standardClaudeModelMapping());
    assert.equal(visits, 3);
  });

  it("switches a saved non-fast mapping back to fast defaults", async () => {
    const nonFast = standardClaudeModelMapping();
    let visits = 0;
    const mapping = await runClaudeModelOnboarding({
      recommended: nonFast,
      fastDefaults: FAST,
      mappingLabel: "Current",
      output: outputBuffer(),
      select: async ({ message, choices }) => {
        visits += 1;
        if (visits === 1) {
          assert.match(message, /Non-fast mode/);
          const toggle = choices.find((choice) => choice.value.action === "fast");
          assert.ok(toggle.name.includes("Use fast models"));
          return toggle.value;
        }
        assert.doesNotMatch(message, /Non-fast mode/);
        for (const model of Object.values(FAST)) {
          // Native slots are rendered as the "Claude default" label, not the slug.
          const label = model === "claude-default" ? "Claude default" : model;
          assert.ok(choices.some((choice) => choice.name.includes(label)));
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.equal(visits, 2);
    assert.deepEqual(mapping, FAST);
  });

  it("returns to the mapping editor when no compatible models are available", async () => {
    let overviewVisits = 0;
    const mapping = await runClaudeMappingEditor({
      initialMapping: FAST,
      recommended: FAST,
      nonFastMapping: standardClaudeModelMapping(),
      catalog: [],
      output: outputBuffer(),
      select: async ({ message, choices }) => {
        assert.match(message, /Claude model mapping/);
        overviewVisits += 1;
        if (overviewVisits === 1) {
          return choices.find((choice) => choice.value.action === "non-fast").value;
        }
        if (overviewVisits === 2) {
          return choices.find((choice) => choice.value.slot === "opus").value;
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.equal(overviewVisits, 3);
    assert.deepEqual(mapping, standardClaudeModelMapping());
  });

  it("reset restores the exact mapping shown before customization", async () => {
    const shown = { ...FAST, opus: "firerouter" };
    let overviewVisits = 0;
    const mapping = await runClaudeMappingEditor({
      initialMapping: shown,
      recommended: FAST,
      nonFastMapping: standardClaudeModelMapping(),
      catalog: CATALOG,
      output: outputBuffer(),
      select: async ({ message, choices }) => {
        if (message.startsWith("Opus ·")) {
          return choices.find((choice) => choice.value.model?.slug === "glm-latest").value;
        }
        overviewVisits += 1;
        if (overviewVisits === 1) {
          return choices.find((choice) => choice.value.slot === "opus").value;
        }
        if (overviewVisits === 2) {
          return choices.find((choice) => choice.value.action === "reset").value;
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });
    assert.deepEqual(mapping, shown);
    assert.equal(overviewVisits, 3);
  });

  it("labels reconfiguration as current rather than recommended", async () => {
    const output = outputBuffer();
    await runClaudeModelOnboarding({
      recommended: FAST,
      fastDefaults: FAST,
      mappingLabel: "Current",
      output,
      select: async ({ choices }) => {
        const save = choices.find((choice) => choice.value.action === "save");
        assert.ok(save.name.includes("Current"));
        return save.value;
      },
    });
    assert.match(output.text(), /Set Claude Code model defaults/);
  });

  it("edits only selected slots and exposes full-catalog search on demand", async () => {
    let overviewVisits = 0;
    let catalogLoads = 0;
    const mapping = await runClaudeModelOnboarding({
      recommended: FAST,
      fastDefaults: FAST,
      output: outputBuffer(),
      loadCatalog: async () => {
        catalogLoads += 1;
        return CATALOG;
      },
      select: async ({ message, choices, initialIndex }) => {
        if (message.startsWith("Claude model mapping")) {
          overviewVisits += 1;
          if (overviewVisits === 1) {
            assert.equal(initialIndex, 5);
            return choices.find((choice) => choice.value.slot === "opus").value;
          }
          if (overviewVisits === 2) {
            assert.equal(initialIndex, 2);
            return choices.find((choice) => choice.value.slot === "haiku").value;
          }
          return choices.find((choice) => choice.value.action === "save").value;
        }
        if (message.startsWith("Opus ·")) {
          const choice = choices.find((entry) => entry.value.model?.slug === "glm-latest");
          assert.ok(choice.name.includes("glm-latest"));
          return choice.value;
        }
        assert.ok(message.startsWith("Haiku ·"));
        return choices.find((choice) => choice.value.action === "search").value;
      },
      search: async ({ items, filter, toChoice }) => {
        assert.ok(items.length > 5);
        assert.deepEqual(
          filter(items, "deepseek-v4-pro").map((model) => model.slug),
          ["deepseek-v4-pro"],
        );
        const selected = items.find((model) => model.slug === "deepseek-v4-pro");
        assert.ok(toChoice(selected).name.includes("deepseek-v4-pro"));
        return selected;
      },
    });

    assert.deepEqual(mapping, {
      ...FAST,
      opus: "glm-latest",
      haiku: "deepseek-v4-pro",
    });
    assert.equal(overviewVisits, 3);
    assert.equal(catalogLoads, 1);
  });
});
