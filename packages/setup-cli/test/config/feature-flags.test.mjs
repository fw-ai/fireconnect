import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findFeatureFlag,
  isAccountFeatureFlagEnabled,
  isFeatureFlagValueActive,
  listFeatureFlagsRest,
} from "../../lib/config/feature-flags.mjs";

const ALLOW_SEARCH_GATEWAY = "allow-search-gateway";

describe("feature-flags", () => {
  it("treats empty, false, and zero values as inactive", () => {
    assert.equal(isFeatureFlagValueActive(""), false);
    assert.equal(isFeatureFlagValueActive("false"), false);
    assert.equal(isFeatureFlagValueActive("FALSE"), false);
    assert.equal(isFeatureFlagValueActive("0"), false);
    assert.equal(isFeatureFlagValueActive("true"), true);
    assert.equal(isFeatureFlagValueActive("1"), true);
  });

  it("finds flags by resource name suffix", () => {
    const flags = [
      { name: "accounts/acme/featureFlags/allow-search-gateway", value: "true" },
      { name: "accounts/acme/featureFlags/other", value: "false" },
    ];
    assert.equal(findFeatureFlag(flags, ALLOW_SEARCH_GATEWAY)?.value, "true");
    assert.equal(findFeatureFlag(flags, "missing"), null);
  });

  it("does not match unrelated resources that share a final segment", () => {
    const flags = [
      { name: "accounts/acme/somethingElse/allow-search-gateway", value: "true" },
    ];
    assert.equal(findFeatureFlag(flags, ALLOW_SEARCH_GATEWAY), null);
  });

  it("parses REST list responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        featureFlags: [
          { name: "accounts/acme/featureFlags/allow-search-gateway", value: "true" },
        ],
      }),
      { status: 200 },
    );
    try {
      const listed = await listFeatureFlagsRest("acme", "fw_test");
      assert.equal(listed.ok, true);
      assert.equal(findFeatureFlag(listed.flags, ALLOW_SEARCH_GATEWAY)?.value, "true");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces REST 404 as not found", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    try {
      const listed = await listFeatureFlagsRest("acme", "fw_test");
      assert.equal(listed.ok, false);
      assert.equal(listed.reason, "not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses REST when gRPC lookup fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        featureFlags: [
          { name: "accounts/acme/featureFlags/allow-search-gateway", value: "true" },
        ],
      }),
      { status: 200 },
    );
    try {
      const result = await isAccountFeatureFlagEnabled("acme", "fw_test", ALLOW_SEARCH_GATEWAY, {
        grpcBaseUrl: "http://127.0.0.1:1",
        apiBaseUrl: "https://api.test",
      });
      assert.equal(result.enabled, true);
      assert.equal(result.unavailable, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
