/**
 * Structural guards for `lib/harnesses/claude/usage/`.
 *
 * The usage-tracking code was twelve files scattered among the Claude harness's
 * auth, onboarding and model-picker modules, one of them a 1191-line meter mixing
 * colour codes, column arithmetic, billing state, rendering and a tail loop. It
 * now lives in its own folder with a one-way dependency chain.
 *
 * These tests protect the properties that make that worth anything: the layering
 * stays acyclic, the renderers stay pure, the folder keeps one entry point, and
 * cost is computed in exactly one place.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, it } from "node:test";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const dir = path.join(here, "../../../../lib/harnesses/claude/usage");

const read = (name) => fs.readFileSync(path.join(dir, `${name}.mjs`), "utf8");
const localImports = (name) => [...read(name).matchAll(/from "\.\/([a-z-]+)\.mjs"/g)]
  .map((m) => m[1]);

/** Every module in the folder, without extensions. */
const MODULES = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => path.basename(f, ".mjs"))
  .sort();

describe("usage folder layout", () => {
  it("contains exactly the modules we expect", () => {
    // A new file here should be a deliberate decision, not a drive-by addition.
    assert.deepEqual(MODULES, [
      "agent-picker",
      "agents",
      "cost",
      "display",
      "format",
      "live",
      "meter-layout",
      "meter-model",
      "meter-render",
      "meter-style",
      "meter",
      "pricing",
      "report",
      "session-picker",
    ].sort());
  });

  it("is reached from the harness through `live` and `report` only", () => {
    // index.mjs is the harness entry point. It should talk to the usage folder
    // through its top-level surface, not reach into the meter's internals.
    const index = fs.readFileSync(path.join(dir, "../index.mjs"), "utf8");
    const reached = [...index.matchAll(/from "\.\/usage\/([a-z-]+)\.mjs"/g)]
      .map((m) => m[1])
      .sort();
    for (const mod of reached) {
      assert.ok(
        ["report", "display", "live", "session-picker"].includes(mod),
        `index.mjs should not import usage/${mod}.mjs directly`,
      );
    }
    assert.ok(reached.includes("live"), "index.mjs should drive the live meter");
    assert.ok(reached.includes("report"), "index.mjs should drive the snapshot report");
  });
});

describe("cost meter module layering", () => {
  // Lower may not import higher. Written out rather than derived, so an import
  // that inverts the chain fails here instead of quietly working.
  const ALLOWED = {
    cost: [],
    pricing: [],
    "meter-style": [],
    "meter-layout": ["cost", "format"],
    "meter-model": ["pricing"],
    "meter-render": ["cost", "meter-style", "meter-layout", "meter-model", "format"],
    meter: ["meter-style", "meter-layout", "meter-model", "meter-render", "report"],
  };

  for (const [name, allowed] of Object.entries(ALLOWED)) {
    it(`${name} imports only from its own layer or below`, () => {
      for (const dep of localImports(name)) {
        assert.ok(
          allowed.includes(dep),
          `${name}.mjs must not import ${dep}.mjs — that inverts the layering`,
        );
      }
    });
  }

  it("has no import cycles anywhere in the folder", () => {
    const state = {};
    const visit = (n, trail) => {
      if (state[n] === "done") return;
      assert.notEqual(
        state[n],
        "open",
        `cycle: ${trail.slice(trail.indexOf(n)).concat(n).join(" -> ")}`,
      );
      state[n] = "open";
      for (const dep of localImports(n)) {
        if (MODULES.includes(dep)) visit(dep, trail.concat(n));
      }
      state[n] = "done";
    };
    for (const m of MODULES) visit(m, []);
  });

  it("keeps meter-style free of in-folder imports", () => {
    // It is the bottom of the chain; anything it pulls in every other module
    // inherits.
    assert.deepEqual(localImports("meter-style"), []);
  });

  it("keeps the renderers free of accumulation", () => {
    // The renderers read state and return text. A Tally or Turn constructed in
    // there would mean the split leaked back.
    const src = read("meter-render");
    assert.doesNotMatch(src, /new Tally\b/, "renderers must not accumulate");
    assert.doesNotMatch(src, /new Turn\b/, "renderers must not build turns");
    assert.doesNotMatch(src, /\.add\(|\.remove\(/, "renderers must not mutate tallies");
  });

  it("prices in exactly one place", () => {
    // The definition is isolated in pricing; live and snapshot consumers call
    // it rather than implementing their own rate math. The demo imports the same
    // module from outside this folder.
    const callers = MODULES.filter((m) => /computeClaudeUsageCost/.test(read(m)));
    assert.deepEqual(
      callers.sort(),
      ["meter-model", "pricing", "report"],
      "only the canonical module and its live/snapshot consumers may price calls",
    );
  });

  it("still exports everything its importers use", async () => {
    // The move has to be invisible to callers: live.mjs, agent-picker.mjs and
    // three test files import from meter.mjs by name.
    const meter = await import(path.join(dir, "meter.mjs"));
    for (const name of [
      "Dashboard",
      "ModelIndex",
      "agentPaneWorthShowing",
      "applyMeterStyle",
      "labelFor",
      "priceCall",
      "runUsageMeter",
      "sanitize",
      "syncAgentPane",
    ]) {
      assert.ok(name in meter, `meter.mjs must keep exporting ${name}`);
    }
  });

  it("keeps every module small enough to read in one sitting", () => {
    // The whole point of the split. `meter` keeps the Dashboard and the tail loop;
    // `report` and `display` predate it and are budgeted where they stand.
    const limits = {
      "meter-style": 150,
      "meter-layout": 200,
      "meter-model": 300,
      "meter-render": 350,
      meter: 700,
      cost: 80,
      pricing: 220,
      format: 150,
      live: 400,
      agents: 350,
      "agent-picker": 420,
      "session-picker": 220,
    };
    for (const [name, max] of Object.entries(limits)) {
      const lines = read(name).split("\n").length;
      assert.ok(lines <= max, `${name}.mjs is ${lines} lines, over its ${max}-line budget`);
    }
  });
});
