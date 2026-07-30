import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeSavings,
  renderStatusLine,
  costAtRates,
  anthropicEquivalentSlug,
  ANTHROPIC_EQUIV,
} from "../../bin/cc-fireworks-savings.mjs";

// Build a single assistant JSONL row with the usage shape Claude Code records.
function assistantRow({ id, model, usage }) {
  return JSON.stringify({
    type: "assistant",
    message: { id, model, content: [{ type: "text", text: "ok" }] },
    usage,
  });
}

const GLM = "accounts/fireworks/models/glm-5p2";
const KIMI = "accounts/fireworks/routers/kimi-fast-latest";
const DEEPSEEK = "accounts/fireworks/models/deepseek-v4-flash";

describe("cc-fireworks-savings status line", () => {
  it("computes Fireworks spend below the Anthropic-equivalent cost", () => {
    // 1k input + 500 output on GLM 5.2 (== Opus tier).
    const transcript = [
      assistantRow({
        id: "msg-1",
        model: GLM,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0 },
      }),
    ].join("\n");

    const { fireworksCost, anthropicCost, requests, modelLabel } = computeSavings(transcript);

    assert.equal(requests, 1);
    assert.equal(modelLabel, "glm-5p2");
    // Fireworks GLM 5.2: $1.4/M in, $4.4/M out -> (1000*1.4 + 500*4.4)/1e6 = 0.0036
    assert.ok(Math.abs(fireworksCost - 0.0036) < 1e-9, `fw cost ${fireworksCost}`);
    // Anthropic Opus: $5/M in, $25/M out -> (1000*5 + 500*25)/1e6 = 0.0175
    assert.ok(Math.abs(anthropicCost - 0.0175) < 1e-9, `anth cost ${anthropicCost}`);
    assert.ok(fireworksCost < anthropicCost, "fireworks should be cheaper");
  });

  it("maps each Fireworks family to its Anthropic-equivalent tier", () => {
    assert.equal(anthropicEquivalentSlug("glm-5p2"), "claude-opus");
    assert.equal(anthropicEquivalentSlug("kimi-k3-fast"), "claude-sonnet");
    assert.equal(anthropicEquivalentSlug("deepseek-v4-flash"), "claude-haiku");
    assert.equal(anthropicEquivalentSlug("firerouter"), "claude-fable");
    // Unknown slugs fall back to Sonnet (the reference tier).
    assert.equal(anthropicEquivalentSlug("some-future-model"), "claude-sonnet");
  });

  it("prices the same token mix at Anthropic cache rates", () => {
    const row = { input: 1000, output: 200, cacheRead: 5000, cacheWrite5m: 0, cacheWrite1h: 0 };
    // Opus: in $5, out $25, cacheRead $0.5 per M.
    const cost = costAtRates(row, { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 });
    // (1000*5 + 200*25 + 5000*0.5)/1e6 = (5000 + 5000 + 2500)/1e6 = 0.0125
    assert.ok(Math.abs(cost - 0.0125) < 1e-9, `cost ${cost}`);
  });

  it("handles the firerouter case by pricing the concrete dispatched model", () => {
    // FireRouter has no static rate, but when the transcript records a concrete
    // serverless model it should be priced as Fireworks (not skipped).
    const transcript = assistantRow({
      id: "msg-fr",
      model: GLM, // a concrete model that arrived via firerouter
      usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0 },
    });
    const { fireworksCost, requests } = computeSavings(transcript);
    assert.equal(requests, 1);
    assert.ok(fireworksCost > 0, "concrete-model row should be priced");
  });

  it("deduplicates repeated assistant message ids", () => {
    const row = assistantRow({
      id: "dup-1",
      model: GLM,
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 },
    });
    const { requests } = computeSavings([row, row, row].join("\n"));
    assert.equal(requests, 1);
  });

  it("ignores non-assistant and malformed lines", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      "not json at all",
      JSON.stringify({ type: "summary", summary: "stuff" }),
      assistantRow({ id: "msg-2", model: KIMI, usage: { input_tokens: 500, output_tokens: 50 } }),
    ].join("\n");
    const { requests } = computeSavings(transcript);
    assert.equal(requests, 1);
  });

  it("returns zeros for an empty transcript and never throws on malformed input", () => {
    assert.deepEqual(computeSavings(""), { fireworksCost: 0, anthropicCost: 0, requests: 0, modelLabel: "" });
    assert.deepEqual(computeSavings(null), { fireworksCost: 0, anthropicCost: 0, requests: 0, modelLabel: "" });
    // Garbage in must not throw.
    assert.doesNotThrow(() => computeSavings("{{{not json}}}"));
  });

  it("renders a single-line status string with savings > 0", () => {
    const transcript = assistantRow({
      id: "msg-r",
      model: DEEPSEEK,
      usage: { input_tokens: 100000, output_tokens: 20000, cache_read_input_tokens: 0 },
    });
    const line = renderStatusLine({ workspace: { current_dir: "/home/me/proj" } }, transcript, { noColor: true });
    assert.equal(typeof line, "string");
    assert.ok(!line.includes("\n"), "status line must be a single line");
    assert.match(line, /🔥 Fireworks/);
    assert.match(line, /saved/);
    assert.match(line, /proj/);
  });

  it("renders a safe fallback line with no transcript data", () => {
    const line = renderStatusLine({ model: "firerouter[1m]" }, "", { noColor: true });
    assert.match(line, /🔥 Fireworks/);
    assert.match(line, /\$0/);
    assert.match(line, /firerouter\[1m\]/);
  });

  it("keeps the equivalence map covering every Fast/latest router id", () => {
    // Guard against a new router id landing in the harness without a tier
    // mapping: every mapped slug must resolve to its declared Anthropic tier.
    for (const slug of Object.keys(ANTHROPIC_EQUIV)) {
      assert.equal(
        anthropicEquivalentSlug(slug),
        ANTHROPIC_EQUIV[slug],
        `equiv mismatch for ${slug}`,
      );
    }
    // Spot-check that each Claude tier is represented.
    const tiers = new Set(Object.values(ANTHROPIC_EQUIV));
    for (const tier of ["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"]) {
      assert.ok(tiers.has(tier), `missing tier ${tier}`);
    }
  });
});
