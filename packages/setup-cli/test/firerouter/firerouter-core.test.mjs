import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_BYOK_HEADER,
  anthropicKeyFromCustomHeaders,
  byokEnvFromHeaders,
  resolveAnthropicKey,
  buildClaudeCustomHeaders,
  normalizeRoutingPreference,
  routingPreferenceLevelName,
  routingPreferenceLevelLabel,
  routingPreferenceOptionsList,
  firerouterStatusFromEnv,
  replaceFireworksKeyInCustomHeaders,
  stripFirerouterOwnedEnv,
  stripManagedCustomHeaderLines,
} from "../../lib/firerouter/core.mjs";
import { FIREWORKS_BASE_URL } from "../../lib/fireworks/model-id.mjs";
import { providerStatusFromEnv } from "../../lib/harnesses/claude/core.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
describe("firerouter-core", () => {
  it("detects FireRouter mode from the `firerouter` model id, not base URL", () => {
    assert.equal(firerouterStatusFromEnv({ ANTHROPIC_MODEL: "firerouter" }), "firerouter");
    assert.equal(firerouterStatusFromEnv({ ANTHROPIC_MODEL: "accounts/fireworks/models/glm-5p2" }), "other");
    assert.equal(firerouterStatusFromEnv({}), "other");
  });

  it("does not infer router mode from stale headers on direct Fireworks URL", () => {
    const env = {
      ANTHROPIC_BASE_URL: FIREWORKS_BASE_URL,
      ANTHROPIC_CUSTOM_HEADERS: "X-Stale-Fireworks-Key: fw_test",
    };
    assert.equal(firerouterStatusFromEnv(env), "other");
    assert.equal(providerStatusFromEnv(env), "fireworks");
  });

  it("builds Claude custom headers", () => {
    const headers = buildClaudeCustomHeaders({
      fireworksKey: "fw_test",
    });
    assert.equal(headers, "X-Fireworks-Api-Key: fw_test");
  });

  it("swaps the Fireworks key in custom headers, preserving other lines", () => {
    const current = "X-Fireworks-Api-Key: fw_old\nx-routing-preference: 3\nX-User-Header: keep-me";
    assert.equal(
      replaceFireworksKeyInCustomHeaders(current, "fw_new"),
      "X-Fireworks-Api-Key: fw_new\nx-routing-preference: 3\nX-User-Header: keep-me",
    );
  });

  it("stripManagedCustomHeaderLines removes only FireConnect-managed lines", () => {
    const value = [
      "X-Fireworks-Api-Key: fw_test",
      "x-anthropic-api-key: sk-ant",
      "x-routing-preference: 3",
      "User-Agent: fireconnect/0.7.0",
      "X-FireRouter-Harness: claude_code/old",
      "X-User-Trace: keep-me",
      "X-Team: platform",
    ].join("\n");
    assert.equal(stripManagedCustomHeaderLines(value), "X-User-Trace: keep-me\nX-Team: platform");
    // Nothing of ours → returns only the user lines unchanged.
    assert.equal(stripManagedCustomHeaderLines("X-User-Trace: keep-me"), "X-User-Trace: keep-me");
    // Only managed lines → empty, so callers can drop the field entirely.
    assert.equal(stripManagedCustomHeaderLines("X-Fireworks-Api-Key: fw_test"), "");
  });

  it("stripFirerouterOwnedEnv keeps user custom-header lines while dropping managed ones", () => {
    const { env, changed } = stripFirerouterOwnedEnv({
      ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
      ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test\nX-User-Trace: keep-me",
    });
    assert.equal(changed, true);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "X-User-Trace: keep-me");
  });

  it("stripFirerouterOwnedEnv drops ANTHROPIC_CUSTOM_HEADERS when only managed lines remain", () => {
    const { env } = stripFirerouterOwnedEnv({
      ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test\nx-anthropic-api-key: sk-ant",
    });
    assert.equal(Object.hasOwn(env, "ANTHROPIC_CUSTOM_HEADERS"), false);
  });

  it("stripFirerouterOwnedEnv leaves a user-only custom-header block untouched", () => {
    const { env, changed } = stripFirerouterOwnedEnv({
      ANTHROPIC_CUSTOM_HEADERS: "X-User-Trace: keep-me",
    });
    assert.equal(changed, false);
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "X-User-Trace: keep-me");
  });

  it("returns non-FireRouter custom headers unchanged, by identity", () => {
    const foreign = "X-User-Header: keep-me";
    assert.equal(replaceFireworksKeyInCustomHeaders(foreign, "fw_new"), foreign);
    assert.equal(replaceFireworksKeyInCustomHeaders(undefined, "fw_new"), undefined);
    const headers = "X-Fireworks-Api-Key: fw_old";
    assert.equal(replaceFireworksKeyInCustomHeaders(headers, ""), headers);
  });

  it("adds the routing-preference header only when set (named or 1-5)", () => {
    // A named level maps to its numeric wire value.
    assert.equal(
      buildClaudeCustomHeaders({ fireworksKey: "fw_test", routingPreference: "balanced" }),
      "X-Fireworks-Api-Key: fw_test\nx-routing-preference: 3",
    );
    // Numeric aliases pass through.
    assert.equal(
      buildClaudeCustomHeaders({ fireworksKey: "fw_test", routingPreference: 1 }),
      "X-Fireworks-Api-Key: fw_test\nx-routing-preference: 1",
    );
    // Unset / out-of-range / unrecognized values are dropped, not clamped.
    assert.equal(
      buildClaudeCustomHeaders({ fireworksKey: "fw_test", routingPreference: 6 }),
      "X-Fireworks-Api-Key: fw_test",
    );
    assert.equal(
      buildClaudeCustomHeaders({ fireworksKey: "fw_test", routingPreference: "nonsense" }),
      "X-Fireworks-Api-Key: fw_test",
    );
  });

  it("normalizes routing-preference values (named + numeric, else null)", () => {
    assert.equal(normalizeRoutingPreference("max-intelligence"), 1);
    assert.equal(normalizeRoutingPreference("balanced"), 3);
    assert.equal(normalizeRoutingPreference("MAX-SAVINGS"), 5);
    assert.equal(normalizeRoutingPreference(2), 2);
    assert.equal(normalizeRoutingPreference("4"), 4);
    assert.equal(normalizeRoutingPreference(null), null);
    assert.equal(normalizeRoutingPreference(undefined), null);
    assert.equal(normalizeRoutingPreference(""), null);
    assert.equal(normalizeRoutingPreference(0), null);
    assert.equal(normalizeRoutingPreference(6), null);
    assert.equal(normalizeRoutingPreference(2.5), null);
    assert.equal(normalizeRoutingPreference("balance"), null);
  });

  it("resolves routing-preference level names for harness on output", () => {
    assert.equal(routingPreferenceLevelName(null), null);
    assert.equal(routingPreferenceLevelName("balanced"), "balanced");
    assert.equal(routingPreferenceLevelName(1), "max-intelligence");
    assert.equal(routingPreferenceLevelName("nonsense"), null);
  });

  it("formats routing-preference labels and option lists", () => {
    assert.equal(routingPreferenceLevelLabel("balanced"), "balanced (3)");
    assert.equal(routingPreferenceLevelLabel(null), "balanced (3)");
    assert.match(
      routingPreferenceOptionsList({ excludeLevel: "balanced" }),
      /max-intelligence \(1\).*max-savings \(5\)/,
    );
    assert.doesNotMatch(
      routingPreferenceOptionsList({ excludeLevel: "balanced" }),
      /balanced \(3\)/,
    );
  });

  it("resolves Anthropic key: flag beats global/env, else global, else settings", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env-12345";
    try {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-anthropic-resolve-"));
      await writeGlobalConfig(home, {
        anthropicApiKey: "sk-ant-from-global-12345",
        harnesses: {},
      });

      assert.equal(await resolveAnthropicKey({ home }), "sk-ant-from-global-12345");
      assert.equal(
        await resolveAnthropicKey({
          apiKey: "sk-ant-from-flag-12345",
          home,
        }),
        "sk-ant-from-flag-12345",
      );
      assert.equal(
        await resolveAnthropicKey({ apiKey: "sk-ant-flag-only-12345" }),
        "sk-ant-flag-only-12345",
      );
      delete process.env.ANTHROPIC_API_KEY;
      assert.equal(
        await resolveAnthropicKey({
          settingsEnv: { ANTHROPIC_AUTH_TOKEN: "sk-ant-settings" },
        }),
        "sk-ant-settings",
      );
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("extracts the Anthropic BYOK key from an ANTHROPIC_CUSTOM_HEADERS string", () => {
    const headers = `${ANTHROPIC_BYOK_HEADER}: sk-ant-hdr-123\nx-routing-preference: 2`;
    assert.equal(anthropicKeyFromCustomHeaders(headers), "sk-ant-hdr-123");
    assert.equal(anthropicKeyFromCustomHeaders(""), "");
  });

  it("byokEnvFromHeaders rebuilds a settingsEnv from the stored Anthropic header", () => {
    assert.deepEqual(
      byokEnvFromHeaders({ [ANTHROPIC_BYOK_HEADER]: "sk-ant-h" }),
      { ANTHROPIC_CUSTOM_HEADERS: `${ANTHROPIC_BYOK_HEADER}: sk-ant-h` },
    );
    assert.deepEqual(byokEnvFromHeaders({}), {});
    assert.deepEqual(byokEnvFromHeaders({ "x-other": "v" }), {});
  });

  it("recovers the Anthropic BYOK key that lives only in ANTHROPIC_CUSTOM_HEADERS (re-on)", async () => {
    const savedA = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // No flag, no global, no env — the key exists only in the header line, as
      // FireRouter mode stores it. The resolver must read it back.
      const settingsEnv = byokEnvFromHeaders({
        [ANTHROPIC_BYOK_HEADER]: "sk-ant-only-in-header-123",
      });
      assert.equal(await resolveAnthropicKey({ settingsEnv }), "sk-ant-only-in-header-123");
    } finally {
      if (savedA !== undefined) process.env.ANTHROPIC_API_KEY = savedA;
    }
  });

});
