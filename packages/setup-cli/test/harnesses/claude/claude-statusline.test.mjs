import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { userSettingsPath } from "../../../lib/harnesses/claude/core.mjs";
import {
  claudeStatusLineCommand,
  claudeStatusLineModelLabel,
  claudeStatusLineSettings,
  claudeStatusLineUsage,
  isFireconnectStatusLine,
  renderClaudeStatusLine,
  stripClaudeStatusLine,
  withClaudeStatusLine,
} from "../../../lib/harnesses/claude/statusline.mjs";
import { runFireconnect, withTempHome } from "../../helpers.mjs";

const USER_STATUS_LINE = { type: "command", command: "~/my-own-statusline.sh" };

/** Strip ANSI color sequences so assertions compare visible text. */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** One assistant call, in the shape Claude Code writes to a transcript. */
function assistantLine({ id, model, input = 0, output = 0, cacheRead = 0 }) {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

describe("claude status line", () => {
  it("resolves Fireworks model ids to their catalog label, ignoring the [1m] tag", () => {
    assert.equal(claudeStatusLineModelLabel("firerouter[1m]"), "FireRouter");
    assert.equal(claudeStatusLineModelLabel("firerouter"), "FireRouter");
    assert.equal(claudeStatusLineModelLabel("kimi-fast-latest[1m]"), "Kimi K3 Fast (Latest)");
    // No metadata for the id: the bare slug, never a crash.
    assert.equal(claudeStatusLineModelLabel("not-a-real-model"), "not-a-real-model");
    assert.equal(claudeStatusLineModelLabel(""), "unknown model");
  });

  it("invokes the helper with an absolute node and script path", () => {
    const command = claudeStatusLineCommand();
    // Claude Code spawns through a shell whose PATH need not contain our Node.
    assert.match(command, /bin\/claude-statusline\.mjs/);
    assert.ok(
      path.isAbsolute(command.split(" ").at(-1).replace(/^'|'$/g, "")),
      command,
    );
    assert.deepEqual(Object.keys(claudeStatusLineSettings()).sort(), ["command", "type"]);
  });

  it("claims only its own status line", () => {
    assert.equal(isFireconnectStatusLine(claudeStatusLineSettings()), true);
    assert.equal(isFireconnectStatusLine(USER_STATUS_LINE), false);
    assert.equal(isFireconnectStatusLine(undefined), false);
    assert.equal(isFireconnectStatusLine("statusline.sh"), false);
  });

  it("never overwrites or strips a status line the user owns", () => {
    const withUser = withClaudeStatusLine({ statusLine: USER_STATUS_LINE });
    assert.deepEqual(withUser.statusLine, USER_STATUS_LINE);

    const stripped = stripClaudeStatusLine({ statusLine: USER_STATUS_LINE });
    assert.equal(stripped.changed, false);
    assert.deepEqual(stripped.settings.statusLine, USER_STATUS_LINE);
  });

  it("replaces its own status line idempotently and strips it back off", () => {
    const once = withClaudeStatusLine({});
    const twice = withClaudeStatusLine(once);
    assert.deepEqual(twice.statusLine, once.statusLine);

    const stripped = stripClaudeStatusLine(twice);
    assert.equal(stripped.changed, true);
    assert.equal(Object.hasOwn(stripped.settings, "statusLine"), false);
  });

  it("prices a transcript at Fireworks rates, not Anthropic's", async () => {
    await withTempHome("statusline-cost", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      // deepseek-v4-flash: $0.22 in / $0.66 out per Mtok (static spec).
      // 1M input + 1M output = $0.88.
      await writeFile(transcript, [
        assistantLine({
          id: "msg_1",
          model: "accounts/fireworks/models/deepseek-v4-flash",
          input: 1_000_000,
          output: 1_000_000,
        }),
      ].join("\n"));

      const line = await renderClaudeStatusLine({
        model: { id: "deepseek-flash-latest[1m]" },
        transcript_path: transcript,
        context_window: { used_percentage: 12 },
      }, { home });

      const plain = stripAnsi(line);
      assert.match(plain, /\$0\.88/, plain);
      // Claude Code's own estimate for the same tokens would be far higher; the
      // point of the line is that it reports the Fireworks number.
      assert.doesNotMatch(plain, /\$4\.20|\$12\.00/, plain);
      // Context usage is Claude Code's own number, shown in its own UI — the
      // payload carries it, and this line deliberately does not repeat it.
      assert.doesNotMatch(plain, /ctx/, plain);
      assert.doesNotMatch(plain, /12%/, plain);
    });
  });

  it("says the cost is unavailable rather than quoting a rate it does not have", async () => {
    await withTempHome("statusline-unpriced", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      await writeFile(transcript, [
        assistantLine({
          id: "msg_1",
          model: "accounts/fireworks/models/some-unlisted-model",
          input: 1_000_000,
          output: 1_000_000,
        }),
      ].join("\n"));

      const plain = stripAnsi(await renderClaudeStatusLine({
        model: { id: "some-unlisted-model" },
        transcript_path: transcript,
      }, { home }));

      assert.match(plain, /cost n\/a/, plain);
      // Neither a reference figure nor a free-looking $0.00.
      assert.doesNotMatch(plain, /\$/, plain);
    });
  });

  it("leaves the session total unavailable when only some calls are priced", async () => {
    await withTempHome("statusline-partly-unpriced", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      await writeFile(transcript, [
        assistantLine({ id: "msg_1", model: "accounts/fireworks/models/deepseek-v4-flash", output: 1_000_000 }),
        assistantLine({ id: "msg_2", model: "accounts/fireworks/models/some-unlisted-model", output: 1_000_000 }),
      ].join("\n"));

      const plain = stripAnsi(await renderClaudeStatusLine({
        model: { id: "firerouter" },
        transcript_path: transcript,
      }, { home }));

      // $0.66 of known spend plus an unknown is not a $0.66 session, so the
      // total withholds the figure — while the legend still reports the per-model
      // cost it does know, and n/a for the one it doesn't.
      const [total, legend] = plain.split("\n");
      assert.match(total, /cost n\/a/, plain);
      assert.doesNotMatch(total, /\$/, plain);
      assert.match(legend, /DeepSeek V4 Flash \$0\.66/, plain);
      assert.match(legend, /some-unlisted-model n\/a/, plain);

      const usage = await claudeStatusLineUsage(transcript, { home });
      assert.equal(usage.models.length, 2);
      assert.equal(
        usage.models.reduce((sum, model) => sum + model.costShare, 0),
        1,
        "mixed priced/unpriced bar shares must use one denominator",
      );
      assert.deepEqual(
        usage.models.map((model) => model.costShare),
        [0.5, 0.5],
        "when spend share is unknowable, every segment uses call share",
      );
    });
  });

  it("blends per-call rates when a session spans Fireworks and Anthropic models", async () => {
    await withTempHome("statusline-mixed", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      await writeFile(transcript, [
        // $0.66 for 1M output at deepseek-v4-flash…
        assistantLine({ id: "msg_1", model: "accounts/fireworks/models/deepseek-v4-flash", output: 1_000_000 }),
        // …plus $25.00 for 1M output at Claude Opus 5 list price.
        assistantLine({ id: "msg_2", model: "claude-opus-5", output: 1_000_000 }),
      ].join("\n"));

      const line = await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
      }, { home });

      const plain = stripAnsi(line);
      assert.match(plain, /\$25\.66/, plain);
      // The legend attributes spend per model, which is the whole point: an
      // even split of calls here is a wildly uneven split of the bill.
      assert.match(plain, /DeepSeek V4 Flash \$0\.66/, plain);
      assert.match(plain, /Claude Opus 5 \$25\.00/, plain);
    });
  });

  it("draws a textless share bar so the only percentages are labeled ones", async () => {
    await withTempHome("statusline-bar-mixed", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      // 3 calls to GLM, 1 to Opus -> 75% / 25%.
      await writeFile(transcript, [
        assistantLine({ id: "m1", model: "accounts/fireworks/models/glm-5p2", input: 1, output: 1 }),
        assistantLine({ id: "m2", model: "accounts/fireworks/models/glm-5p2", input: 1, output: 1 }),
        assistantLine({ id: "m3", model: "accounts/fireworks/models/glm-5p2", input: 1, output: 1 }),
        assistantLine({ id: "m4", model: "claude-opus-5", input: 1, output: 1 }),
      ].join("\n"));

      const line = await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
      }, { home });

      const plain = stripAnsi(line);
      const [bar, legend] = plain.split("\n");
      // The bar is width-only: no digits inside it, so its share cannot be
      // confused with the labeled cache percentages in the legend.
      assert.match(bar, /^[━ ]+ ·/, bar);
      const barSegments = bar.split(" · ")[0];
      assert.doesNotMatch(barSegments, /\d/, barSegments);
      // Share is therefore never printed as a number at all.
      assert.doesNotMatch(legend, /75%/, legend);
      assert.doesNotMatch(legend, /25%/, legend);
      // EVERY percentage that is printed carries its unit.
      const unlabeled = [...legend.matchAll(/\d+%(?! cache)/g)].map((m) => m[0]);
      assert.deepEqual(unlabeled, [], `unlabeled percentages: ${legend}`);
      assert.match(legend, /GLM 5\.2 \$/, legend);
      assert.match(legend, /Claude Opus 5 \$/, legend);
      // The slot alias is not shown when there's a transcript to break down.
      assert.doesNotMatch(plain, /FireRouter/, plain);
    });
  });

  it("attributes spend per model so a cheap majority reads apart from the bill", async () => {
    await withTempHome("statusline-cost-split", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      // 3 cheap calls vs 1 expensive one: 75% of calls, but a sliver of cost.
      await writeFile(transcript, [
        assistantLine({ id: "m1", model: "accounts/fireworks/models/deepseek-v4-flash", output: 1_000_000 }),
        assistantLine({ id: "m2", model: "accounts/fireworks/models/deepseek-v4-flash", output: 1_000_000 }),
        assistantLine({ id: "m3", model: "accounts/fireworks/models/deepseek-v4-flash", output: 1_000_000 }),
        assistantLine({ id: "m4", model: "claude-opus-5", output: 1_000_000 }),
      ].join("\n"));

      const line = await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
      }, { home });

      const plain = stripAnsi(line);
      // 3 of 4 calls went to the cheap model, yet it accounts for $1.98 against
      // Opus 5's $25.00.
      assert.match(plain, /DeepSeek V4 Flash \$1\.98/, plain);
      assert.match(plain, /Claude Opus 5 \$25\.00/, plain);
      assert.match(plain, /\$26\.98/, plain);

      const [bar, legend] = plain.split("\n");
      assert.match(bar, /^[━ ]+/, bar);
      // The bar draws SPEND, not calls: Opus 5 ran a quarter of the calls and
      // leads anyway, because it is 97% of the bill. Ordering follows suit, so
      // bar and legend agree.
      assert.ok(
        legend.indexOf("Claude Opus 5") < legend.indexOf("DeepSeek V4 Flash"),
        `legend must lead with the costliest model: ${legend}`,
      );
      const segments = bar.split(" · ")[0].split(" ");
      assert.ok(
        segments[0].length > segments[1].length,
        `costliest model needs the widest segment: ${JSON.stringify(segments)}`,
      );
    });
  });

  it("sizes bar segments by spend, not by how many calls each model took", async () => {
    await withTempHome("statusline-bar-is-cost", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      // 9 cheap calls vs 1 expensive: 90% of the calls, ~3% of the money.
      const rows = [];
      for (let i = 0; i < 9; i += 1) {
        rows.push(assistantLine({
          id: `m${i}`,
          model: "accounts/fireworks/models/deepseek-v4-flash",
          output: 1_000_000,
        }));
      }
      rows.push(assistantLine({ id: "opus", model: "claude-opus-5", output: 3_000_000 }));
      await writeFile(transcript, rows.join("\n"));

      const usage = await claudeStatusLineUsage(transcript, { home });
      const opus = usage.models.find((m) => m.label === "Claude Opus 5");
      const flash = usage.models.find((m) => m.label === "DeepSeek V4 Flash");
      // Calls say the flash model dominates; spend says the opposite.
      assert.ok(flash.share > opus.share, "flash should own most calls");
      assert.ok(opus.costShare > flash.costShare, "opus should own most spend");
      assert.ok(opus.costShare > 0.9, `opus cost share was ${opus.costShare}`);

      // The bar follows spend, so opus gets the wider segment.
      const bar = stripAnsi(await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
      }, { home })).split("\n")[0];
      const [first, second] = bar.split(" · ")[0].split(" ");
      assert.ok(
        first.length > second.length,
        `spend-weighted bar expected, got ${JSON.stringify([first, second])}`,
      );
    });
  });

  it("draws a solid bar with no percentage for a single-model session", async () => {
    await withTempHome("statusline-bar-single", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      await writeFile(transcript, [
        assistantLine({ id: "m1", model: "accounts/fireworks/models/glm-5p2", input: 1, output: 1 }),
        assistantLine({ id: "m2", model: "accounts/fireworks/models/glm-5p2", input: 1, output: 1 }),
      ].join("\n"));

      const line = await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
      }, { home });

      const plain = stripAnsi(line);
      // One backend -> a solid bar with no embedded percentage: there is no
      // share to compare against.
      assert.match(plain, /^[━ ]+ ·/, plain);
      assert.doesNotMatch(plain, /\d%━/, plain);
      // The legend keeps the model's cache figure but drops the per-model cost,
      // which would only repeat the total already shown beside the bar.
      assert.match(plain, /GLM 5\.2 \d+%/, plain);
      assert.doesNotMatch(plain, /GLM 5\.2 <?\$/, plain);
    });
  });

  it("reports each model's cache-hit share the way the live meter does", async () => {
    await withTempHome("statusline-cache", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      // deepseek: 900 cache-read + 100 fresh -> 90%. opus: 500/500 -> 50%.
      // Per-model, not session-wide: pooled they would read 70%, which would
      // describe neither model.
      await writeFile(transcript, [
        assistantLine({
          id: "msg_1",
          model: "accounts/fireworks/models/deepseek-v4-flash",
          input: 100,
          cacheRead: 900,
          output: 50,
        }),
        assistantLine({
          id: "msg_2",
          model: "claude-opus-5",
          input: 500,
          cacheRead: 500,
          output: 50,
        }),
      ].join("\n"));

      const usage = await claudeStatusLineUsage(transcript, { home });
      const byLabel = new Map(usage.models.map((m) => [m.label, m.cachePct]));
      assert.equal(byLabel.get("DeepSeek V4 Flash"), "90%");
      assert.equal(byLabel.get("Claude Opus 5"), "50%");

      // Identical to the live meter's `cache%` column, from the same helpers.
      const { cachePct } = await import("../../../lib/harnesses/claude/usage/meter-layout.mjs");
      assert.equal(cachePct({ input: 100, cacheRead: 900, cacheWrite: 0 }), "90%");
      assert.equal(cachePct({ input: 500, cacheRead: 500, cacheWrite: 0 }), "50%");

      const plain = stripAnsi(await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
      }, { home }));
      // `e-` allowed: a cost below $0.0001 is quoted as an exponent.
      assert.match(plain, /DeepSeek V4 Flash \$[\d.e-]+ 90%/, plain);
      assert.match(plain, /Claude Opus 5 \$[\d.e-]+ 50%/, plain);
    });
  });

  it("does not price a transcript that exists but has no API calls yet", async () => {
    await withTempHome("statusline-fresh-transcript", async (home) => {
      // Claude Code opens the transcript with user/metadata lines before the
      // first call, so "the file exists" is not "there is something to bill".
      const transcript = path.join(home, "session.jsonl");
      await writeFile(transcript, [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "summary", summary: "new session" }),
      ].join("\n"));

      assert.equal(await claudeStatusLineUsage(transcript, { home }), null);

      const plain = stripAnsi(await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
      }, { home }));
      // A session that has not been billed must not read as a free one.
      assert.equal(plain, "FireRouter");
      assert.doesNotMatch(plain, /\$/, plain);
    });
  });

  it("expresses de-emphasis as a modifier so it survives a light theme", async () => {
    await withTempHome("statusline-theme-safe", async (home) => {
      // The suite runs under NO_COLOR, which would make every assertion here
      // vacuously true — so drive the real helper with color switched on.
      const helper = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../bin/claude-statusline.mjs",
      );
      const line = execFileSync(process.execPath, [helper], {
        input: JSON.stringify({
          model: { id: "firerouter[1m]" },
          transcript_path: path.join(home, "missing.jsonl"),
        }),
        env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "1", HOME: home },
        encoding: "utf8",
      });

      assert.match(line, /FireRouter/, line);
      // Secondary text must not pin an absolute color: the status line cannot
      // know the surface it lands on, and a fixed light grey validated for a
      // dark theme washes out on a light one. Faint + default foreground
      // de-emphasizes relative to whatever the user's theme provides.
      const seriesStripped = line.replace(/\x1b\[38;2;\d+;\d+;\d+m[━ ]*\x1b\[0m/g, "");
      assert.doesNotMatch(seriesStripped, /\x1b\[38;2;/, `text pinned a truecolor: ${JSON.stringify(line)}`);
      assert.doesNotMatch(seriesStripped, /\x1b\[38;5;/, `text pinned a 256-color: ${JSON.stringify(line)}`);
      assert.match(line, /\x1b\[2m/, `expected faint for de-emphasis: ${JSON.stringify(line)}`);
    });
  });

  it("renders the slot alias alone when there is no transcript to break down", async () => {
    await withTempHome("statusline-no-transcript", async (home) => {
      const line = await renderClaudeStatusLine({
        model: { id: "glm-fast-latest[1m]" },
        // A brand-new session: Claude Code names a transcript before writing it.
        transcript_path: path.join(home, "does-not-exist.jsonl"),
      }, { home });

      const plain = stripAnsi(line);
      assert.equal(plain, "GLM 5.2 Fast (Latest)");
      // No transcript must not read as a free session.
      assert.doesNotMatch(plain, /\$/, plain);
    });
  });

  it("names the Claude default slot rather than a Fireworks label", async () => {
    await withTempHome("statusline-native", async (home) => {
      const line = await renderClaudeStatusLine({
        model: { id: "claude-default", display_name: "Sonnet 5" },
      }, { home });
      assert.equal(stripAnsi(line), "Sonnet 5");
    });
  });

  it("labels a real Anthropic model id from the list-price table", async () => {
    await withTempHome("statusline-anthropic-id", async (home) => {
      const line = await renderClaudeStatusLine({
        model: { id: "claude-sonnet-5" },
      }, { home });
      assert.equal(stripAnsi(line), "Claude Sonnet 5");
    });
  });

  it("survives a malformed payload without throwing", async () => {
    assert.equal(typeof await renderClaudeStatusLine({}), "string");
    assert.equal(typeof await renderClaudeStatusLine({ model: {} }), "string");
    assert.equal(
      typeof await renderClaudeStatusLine({ transcript_path: "/nope/nothing.jsonl" }),
      "string",
    );
  });

  it("attributes subagent spend so the per-model costs sum to the total", async () => {
    await withTempHome("statusline-subagent-reconcile", async (home) => {
      // Claude Code lays subagent logs out as <dir>/<sessionId>/subagents/agent-*.jsonl
      const sessionId = "11111111-2222-3333-4444-555555555555";
      const transcript = path.join(home, `${sessionId}.jsonl`);
      await writeFile(transcript, [
        assistantLine({ id: "p1", model: "accounts/fireworks/models/glm-5p2", output: 1_000_000 }),
      ].join("\n"));
      const subagentDir = path.join(home, sessionId, "subagents");
      await mkdir(subagentDir, { recursive: true });
      await writeFile(path.join(subagentDir, "agent-abc.jsonl"), [
        assistantLine({ id: "s1", model: "accounts/fireworks/models/deepseek-v4-flash", output: 1_000_000 }),
      ].join("\n"));

      const usage = await claudeStatusLineUsage(transcript, { home });
      // The headline total counts subagents, so the breakdown must too —
      // otherwise the legend silently orphans their spend.
      const summed = usage.models.reduce((total, m) => total + m.cost, 0);
      assert.ok(
        Math.abs(summed - usage.cost) < 1e-9,
        `per-model costs ${summed} must reconcile with total ${usage.cost}`,
      );
      // Both the parent's model and the subagent's model appear.
      const labels = usage.models.map((m) => m.label);
      assert.ok(labels.includes("GLM 5.2"), labels.join(", "));
      assert.ok(labels.includes("DeepSeek V4 Flash"), labels.join(", "));
      // "What is serving me now" stays the main thread's model.
      assert.match(usage.lastModel, /glm-5p2/);
    });
  });

  it("terminates every ANSI sequence so no parameters leak as text", async () => {
    await withTempHome("statusline-ansi-wellformed", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      await writeFile(transcript, [
        assistantLine({ id: "m1", model: "accounts/fireworks/models/glm-5p2", input: 1, output: 1 }),
        assistantLine({ id: "m2", model: "claude-opus-5", input: 1, output: 1 }),
      ].join("\n"));

      const line = await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
        context_window: { used_percentage: 40 },
      }, { home });

      // An unterminated SGR (`\x1b[38;5;141` with no `m`) makes the terminal
      // treat the NEXT character as the CSI terminator: "GLM" loses its "G" to
      // a cursor-move, and a following "█" leaks the params as literal text.
      // Every escape here must therefore end in `m`.
      for (const esc of line.matchAll(/\x1b\[[0-9;]*./g)) {
        assert.ok(esc[0].endsWith("m"), `unterminated escape: ${JSON.stringify(esc[0])}`);
      }
      // And no bare SGR parameters may survive into the visible text.
      assert.doesNotMatch(stripAnsi(line), /\d+;\d+;\d+/, stripAnsi(line));
      // Model names keep their first character.
      assert.match(stripAnsi(line), /GLM 5\.2/, stripAnsi(line));
      assert.match(stripAnsi(line), /Claude Opus 5/, stripAnsi(line));
    });
  });

  it("never emits more than two lines", async () => {
    await withTempHome("statusline-two-lines", async (home) => {
      const transcript = path.join(home, "session.jsonl");
      // Four distinct backends — the bar/legend still fits in two lines.
      await writeFile(transcript, [
        assistantLine({ id: "m1", model: "accounts/fireworks/models/glm-5p2", input: 1, output: 1 }),
        assistantLine({ id: "m2", model: "accounts/fireworks/models/deepseek-v4-flash", input: 1, output: 1 }),
        assistantLine({ id: "m3", model: "claude-opus-5", input: 1, output: 1 }),
        assistantLine({ id: "m4", model: "accounts/fireworks/models/kimi-k3", input: 1, output: 1 }),
      ].join("\n"));

      const line = await renderClaudeStatusLine({
        model: { id: "firerouter[1m]" },
        transcript_path: transcript,
        context_window: { used_percentage: 80 },
      }, { home });

      assert.equal(line.trimEnd().split("\n").length, 2, line);
    });
  });

  it("on installs the status line and off removes it", async () => {
    await withTempHome("statusline-roundtrip", async (home) => {
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        theme: "dark",
      }));

      const on = await runFireconnect(
        ["claude", "on", "--api-key", "fw_test_key_12345", "--non-interactive"],
        { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
      );
      assert.equal(on.code, 0, on.stderr);

      const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(isFireconnectStatusLine(enabled.statusLine), true);
      assert.equal(enabled.theme, "dark", "unrelated settings must survive");

      const off = await runFireconnect(["claude", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);

      const restored = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(Object.hasOwn(restored, "statusLine"), false);
      assert.equal(restored.theme, "dark");
    });
  });

  it("leaves a user's own status line in place across on and off", async () => {
    await withTempHome("statusline-user-owned", async (home) => {
      const settingsPath = userSettingsPath(home);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        statusLine: USER_STATUS_LINE,
      }));

      const on = await runFireconnect(
        ["claude", "on", "--api-key", "fw_test_key_12345", "--non-interactive"],
        { HOME: home, FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
      );
      assert.equal(on.code, 0, on.stderr);
      assert.deepEqual(
        JSON.parse(await readFile(settingsPath, "utf8")).statusLine,
        USER_STATUS_LINE,
        "a custom status line is the user's, not ours to replace",
      );

      const off = await runFireconnect(["claude", "off"], { HOME: home });
      assert.equal(off.code, 0, off.stderr);
      assert.deepEqual(
        JSON.parse(await readFile(settingsPath, "utf8")).statusLine,
        USER_STATUS_LINE,
      );
    });
  });
});
