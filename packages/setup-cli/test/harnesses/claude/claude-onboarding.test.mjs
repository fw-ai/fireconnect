import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  printClaudeModelMapping,
  runClaudeMappingEditor,
  runClaudeModelOnboarding,
  standardClaudeModelMapping,
} from "../../../lib/harnesses/claude/onboarding.mjs";
import {
  mergeClaudeModelMappings,
} from "../../../lib/harnesses/claude/model-profile.mjs";

const FAST = {
  main: "kimi-fast-latest",
  opus: "glm-fast-latest",
  sonnet: "glm-fast-latest",
  haiku: "deepseek-v4-flash",
  fable: "kimi-fast-latest",
  subagent: "deepseek-v4-flash",
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
        assert.equal(initialIndex, 6);
        assert.ok(choices[0].name.includes("Fable"));
        for (const model of Object.values(FAST)) {
          assert.ok(choices.some((choice) => choice.name.includes(model)));
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

  it("prints one Fable-first final mapping", () => {
    const output = outputBuffer();
    printClaudeModelMapping(FAST, output);
    const text = output.text();
    assert.equal((text.match(/Model mapping/g) ?? []).length, 1);
    assert.ok(text.indexOf("Fable") < text.indexOf("Main"));
    for (const model of Object.values(FAST)) {
      assert.ok(text.includes(model));
    }
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
          assert.ok(choices.some((choice) => choice.name.includes(model)));
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
    const shown = { ...FAST, main: "firerouter" };
    let overviewVisits = 0;
    const mapping = await runClaudeMappingEditor({
      initialMapping: shown,
      recommended: FAST,
      nonFastMapping: standardClaudeModelMapping(),
      catalog: CATALOG,
      output: outputBuffer(),
      select: async ({ message, choices }) => {
        if (message.startsWith("Main ·")) {
          return choices.find((choice) => choice.value.model?.slug === "glm-latest").value;
        }
        overviewVisits += 1;
        if (overviewVisits === 1) {
          return choices.find((choice) => choice.value.slot === "main").value;
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
            assert.equal(initialIndex, 6);
            return choices.find((choice) => choice.value.slot === "main").value;
          }
          if (overviewVisits === 2) {
            assert.equal(initialIndex, 2);
            return choices.find((choice) => choice.value.slot === "haiku").value;
          }
          return choices.find((choice) => choice.value.action === "save").value;
        }
        if (message.startsWith("Main ·")) {
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
      main: "glm-latest",
      opus: "glm-fast-latest",
      sonnet: "glm-fast-latest",
      haiku: "deepseek-v4-pro",
      fable: "kimi-fast-latest",
      subagent: "deepseek-v4-flash",
    });
    assert.equal(overviewVisits, 3);
    assert.equal(catalogLoads, 1);
  });
});
