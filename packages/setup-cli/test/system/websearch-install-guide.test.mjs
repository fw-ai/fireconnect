import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WEBSEARCH_MCP_SERVER_NAME } from "../../lib/system/websearch-state.mjs";
import { printWebsearchOnStep } from "../../lib/system/websearch-install-guide.mjs";

describe("websearch-install-guide", () => {
  it("prints an explicit on-step line without redundant restart copy", async () => {
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      await printWebsearchOnStep({
        installed: true,
        changed: true,
        filePath: "/tmp/home/.claude.json",
      }, "/tmp/home");
    } finally {
      console.log = originalLog;
    }
    const output = lines.join("\n");
    assert.match(output, new RegExp(WEBSEARCH_MCP_SERVER_NAME));
    assert.match(output, /installed/i);
    assert.match(output, /\.claude\.json/i);
    assert.doesNotMatch(output, /search the web/i);
    assert.doesNotMatch(output, /Restart Claude Code, then run \/mcp/i);
  });
});
