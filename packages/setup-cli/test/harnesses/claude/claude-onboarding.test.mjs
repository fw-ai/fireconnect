import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  printClaudeModelMapping,
  runClaudeMappingEditor,
  runClaudeModelOnboarding,
} from "../../../lib/harnesses/claude/onboarding.mjs";
import {
  defaultClaudeModelMapping,
  mergeClaudeModelMappings,
} from "../../../lib/harnesses/claude/model-profile.mjs";

// Baseline mapping from defaultClaudeModelMapping() for wizard tests.
const DEFAULTS = defaultClaudeModelMapping();

function catalogModel(slug, overrides = {}) {
  return {
    id: `accounts/fireworks/routers/${slug}`,
    slug,
    label: slug,
    fast: slug.includes("fast") || slug.includes("turbo"),
    contextWindow: 1_000_000,
    vision: slug.includes("kimi"),
    tools: true,
    pricing: { display: "$1 in / $2 out", tier: slug.includes("fast") ? "fast" : "standard" },
    router: true,
    firerouter: slug === "firerouter",
    ...overrides,
  };
}

const CATALOG = [
  catalogModel("kimi-fast-latest"),
  catalogModel("glm-fast-latest"),
  catalogModel("glm-flash-latest", { fast: false, vision: true }),
  catalogModel("glm-latest", { fast: false }),
  catalogModel("deepseek-v4-flash"),
  catalogModel("deepseek-v4-pro", { fast: false }),
  catalogModel("deepseek-pro-latest", { fast: false }),
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

  it("keeps the recommended mapping on the one-step default path", async () => {
    const output = outputBuffer();
    const mapping = await runClaudeModelOnboarding({
      shownMapping: DEFAULTS,
      output,
      select: async ({ message, choices, initialIndex }) => {
        assert.match(message, /Claude model mapping/);
        // Five editable rows: main has no row because it is never pinned.
        assert.equal(initialIndex, 5);
        assert.ok(choices[0].name.includes("Fable"));
        assert.ok(!choices.some((choice) => choice.value.slot === "main"));
        assert.ok(!choices.some((choice) => choice.value.action === "non-fast"));
        assert.ok(!choices.some((choice) => choice.value.action === "fast"));
        for (const model of Object.values(DEFAULTS)) {
          if (model === "claude-default") continue;
          assert.ok(choices.some((choice) => choice.name.includes(model)));
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.deepEqual(mapping, DEFAULTS);
    assert.match(output.text(), /Set Claude Code model defaults/);
  });

  it("returns an explicit cancellation instead of the baseline mapping", async () => {
    const mapping = await runClaudeModelOnboarding({
      shownMapping: DEFAULTS,
      output: outputBuffer(),
      select: async () => null,
    });
    assert.equal(mapping, null);
  });

  it("prints one Fable-first final mapping without an unpinned Main", () => {
    const output = outputBuffer();
    printClaudeModelMapping(DEFAULTS, output);
    const text = output.text();
    assert.equal((text.match(/Model mapping/g) ?? []).length, 1);
    assert.ok(text.indexOf("Fable") < text.indexOf("Opus"));
    // Main is unpinned here, so it has nothing to report.
    assert.ok(!text.includes("Main"));
    for (const [slot, model] of Object.entries(DEFAULTS)) {
      if (slot === "main" || model === "claude-default") continue;
      assert.ok(text.includes(model));
    }
  });

  it("prints a pinned Main row when one is set", () => {
    const output = outputBuffer();
    printClaudeModelMapping({ ...DEFAULTS, main: "glm-latest" }, output);
    const text = output.text();
    assert.ok(text.includes("Main"));
    assert.ok(text.indexOf("Main") < text.indexOf("Fable"));
  });

  it("shows a pinned Main row in the editor", async () => {
    const pinned = { ...DEFAULTS, main: "glm-latest" };
    const mapping = await runClaudeModelOnboarding({
      shownMapping: pinned,
      badgeMapping: DEFAULTS,
      mappingLabel: "Current",
      output: outputBuffer(),
      select: async ({ choices, initialIndex }) => {
        assert.equal(initialIndex, 6);
        assert.ok(choices.some((choice) => choice.value.slot === "main"));
        assert.ok(choices[0].name.includes("Main"));
        assert.ok(choices.some((choice) => choice.name.includes("glm-latest")));
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.deepEqual(mapping, pinned);
  });

  it("includes Main as an editable row on Fire Pass", async () => {
    const firepass = defaultClaudeModelMapping("firepass");
    const mapping = await runClaudeModelOnboarding({
      shownMapping: firepass,
      keyType: "firepass",
      output: outputBuffer(),
      select: async ({ choices }) => {
        assert.ok(choices.some((choice) => choice.value.slot === "main"));
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.deepEqual(mapping, firepass);
  });

  it("uses the shared brand styles for the mapping and profile choices", async () => {
    const previousForceColor = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const output = outputBuffer();
      await runClaudeModelOnboarding({
        shownMapping: DEFAULTS,
        output,
        select: async ({ choices }) => {
          assert.match(choices[0].name, /\x1b\[1mFable/);
          assert.match(choices[0].name, /\x1b\[36mglm-flash-latest/);
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

  it("returns to the mapping editor when no compatible models are available", async () => {
    let overviewVisits = 0;
    const mapping = await runClaudeMappingEditor({
      initialMapping: DEFAULTS,
      recommended: DEFAULTS,
      catalog: [],
      output: outputBuffer(),
      select: async ({ message, choices }) => {
        assert.match(message, /Claude model mapping/);
        overviewVisits += 1;
        if (overviewVisits === 1) {
          return choices.find((choice) => choice.value.slot === "opus").value;
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
    });

    assert.equal(overviewVisits, 2);
    assert.deepEqual(mapping, DEFAULTS);
  });

  it("reset restores the exact mapping shown before customization", async () => {
    const shown = { ...DEFAULTS, opus: "firerouter" };
    let overviewVisits = 0;
    const mapping = await runClaudeMappingEditor({
      initialMapping: shown,
      recommended: DEFAULTS,
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
      shownMapping: DEFAULTS,
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
      shownMapping: DEFAULTS,
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
      ...DEFAULTS,
      opus: "glm-latest",
      haiku: "deepseek-v4-pro",
    });
    assert.equal(overviewVisits, 3);
    assert.equal(catalogLoads, 1);
  });

  it("shows flash models in the picker alongside standard-tier models", async () => {
    let visits = 0;
    await runClaudeModelOnboarding({
      shownMapping: DEFAULTS,
      output: outputBuffer(),
      loadCatalog: async () => CATALOG,
      select: async ({ message, choices }) => {
        if (message.startsWith("Fable ·")) {
          const models = choices
            .map((choice) => choice.value.model)
            .filter(Boolean);
          assert.ok(models.some((model) => model.slug === "glm-flash-latest"));
          assert.ok(models.some((model) => model.slug === "kimi-latest"));
          return choices.find((choice) => choice.value.action === "search").value;
        }
        visits += 1;
        if (visits === 1) {
          return choices.find((choice) => choice.value.slot === "fable").value;
        }
        return choices.find((choice) => choice.value.action === "save").value;
      },
      search: async ({ items }) => items.find((model) => model.slug === "kimi-latest"),
    });
  });
});
