import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withFireconnectRequestHeaders } from "../../../lib/harnesses/vscode/request-headers.mjs";

describe("vscode request headers", () => {
  it("writes anthropic_api_key on firerouter models when BYOK is present", () => {
    const model = withFireconnectRequestHeaders(
      { id: "firerouter", name: "FireRouter", url: "https://api.fireworks.ai/inference" },
      { byokHeaders: { "x-anthropic-api-key": "sk-ant-byok" } },
    );
    assert.equal(model.anthropic_api_key, "sk-ant-byok");
    assert.equal(model.requestHeaders["x-anthropic-api-key"], "sk-ant-byok");
  });

  it("drops anthropic_api_key from non-firerouter models", () => {
    const model = withFireconnectRequestHeaders(
      {
        id: "glm-fast-latest",
        anthropic_api_key: "sk-ant-stale",
        requestHeaders: { "x-anthropic-api-key": "sk-ant-stale" },
      },
      { byokHeaders: { "x-anthropic-api-key": "sk-ant-byok" } },
    );
    assert.equal(model.anthropic_api_key, undefined);
    assert.equal(model.requestHeaders?.["x-anthropic-api-key"], undefined);
  });

  it("attaches routing-preference for a pure-Fireworks firerouter selection, without Anthropic BYOK", () => {
    // A pure-Fireworks selection (firerouter/kimi-k3) needs no Anthropic key, so
    // the BYOK header/body field must be dropped — but the routing-preference
    // header still attaches because it applies to any FireRouter route.
    const model = withFireconnectRequestHeaders(
      { id: "firerouter/kimi-k3", name: "FireRouter · Kimi K3", url: "https://api.fireworks.ai/inference" },
      { byokHeaders: { "x-routing-preference": "3", "x-anthropic-api-key": "sk-ant-byok" } },
    );
    assert.equal(model.requestHeaders["x-routing-preference"], "3");
    assert.equal(model.requestHeaders?.["x-anthropic-api-key"], undefined);
    assert.equal(model.anthropic_api_key, undefined);
  });
});
