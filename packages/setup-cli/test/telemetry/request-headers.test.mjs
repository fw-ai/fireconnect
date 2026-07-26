import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFireconnectTelemetryHeaders,
  mergeFireconnectTelemetryHeaderLines,
  mergeFireconnectTelemetryHeaders,
  stripFireconnectTelemetryHeaderLines,
} from "../../lib/telemetry/request-headers.mjs";

describe("FireConnect request telemetry", () => {
  it("builds a harness title and versioned FireConnect referrer", () => {
    assert.deepEqual(
      buildFireconnectTelemetryHeaders("claude", {
        fireconnectVersion: "0.8.0+build.host-derived",
      }),
      {
        "X-Title": "Claude Code",
        "HTTP-Referer": "fireconnect/v0.8.0",
      },
    );
  });

  it("uses canonical harness titles and bounds invalid version data", () => {
    assert.deepEqual(
      buildFireconnectTelemetryHeaders("codex", {
        fireconnectVersion: "host-derived-value",
      }),
      {
        "X-Title": "Codex",
        "HTTP-Referer": "fireconnect/unknown",
      },
    );
  });

  it("preserves a native User-Agent while updating managed object headers", () => {
    const merged = mergeFireconnectTelemetryHeaders({
      "X-User-Trace": "keep",
      "User-Agent": "opencode/1.2.3 ai-sdk/5",
      "X-Title": "old",
      "HTTP-Referer": "https://example.com/old",
    }, {
      "X-Title": "OpenCode",
      "HTTP-Referer": "fireconnect/v0.8.0",
    });
    assert.deepEqual(merged, {
      "X-User-Trace": "keep",
      "User-Agent": "opencode/1.2.3 ai-sdk/5",
      "X-Title": "OpenCode",
      "HTTP-Referer": "fireconnect/v0.8.0",
    });
  });

  it("preserves native User-Agent lines and removes the legacy FireConnect override", () => {
    const current = [
      "X-User-Trace: keep",
      "User-Agent: claude-cli/2.1.19",
      "X-Title: old",
      "X-FireRouter-Harness: claude_code/old",
      "Fireworks-Use-Case: coding",
      "HTTP-Referer: https://example.com/old",
    ].join("\n");
    const merged = mergeFireconnectTelemetryHeaderLines(current, {
      "X-Title": "Claude Code",
      "HTTP-Referer": "fireconnect/v0.8.0",
    });
    assert.equal(
      merged,
      "X-Title: Claude Code\nHTTP-Referer: fireconnect/v0.8.0\nX-User-Trace: keep\nUser-Agent: claude-cli/2.1.19",
    );
    assert.equal(
      stripFireconnectTelemetryHeaderLines(merged),
      "X-User-Trace: keep\nUser-Agent: claude-cli/2.1.19",
    );
    assert.equal(
      stripFireconnectTelemetryHeaderLines(
        "User-Agent: fireconnect/0.8.0\nX-User-Trace: keep",
      ),
      "X-User-Trace: keep",
    );
    assert.equal(
      stripFireconnectTelemetryHeaderLines(
        "User-Agent: fireconnect/9.8.7-custom-native\nX-User-Trace: keep",
      ),
      "User-Agent: fireconnect/9.8.7-custom-native\nX-User-Trace: keep",
    );
  });
});
