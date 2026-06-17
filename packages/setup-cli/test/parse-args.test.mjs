import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../lib/parse-args.mjs";

describe("parseCli", () => {
  it("parses global configure", () => {
    const parsed = parseCli(["configure", "--harnesses", "claude,opencode"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "configure");
    assert.equal(parsed.ctx.harnesses, "claude,opencode");
  });

  it("parses global upgrade", () => {
    const parsed = parseCli(["upgrade"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "upgrade");
  });

  it("parses harness model list", () => {
    const parsed = parseCli(["claude", "model", "list", "--search", "glm"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.noun, "model");
    assert.equal(parsed.route.verb, "list");
    assert.equal(parsed.ctx.search, "glm");
  });

  it("parses bare harness as on", () => {
    const parsed = parseCli(["claude"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "on");
  });

  it("parses harness verb", () => {
    const parsed = parseCli(["opencode", "status", "--json"]);
    assert.equal(parsed.route.harnessId, "opencode");
    assert.equal(parsed.route.verb, "status");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses harness model select", () => {
    const parsed = parseCli(["claude", "model", "select", "--slot", "sonnet"]);
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.noun, "model");
    assert.equal(parsed.route.verb, "select");
    assert.equal(parsed.ctx.slot, "sonnet");
  });

  it("parses harness model reset", () => {
    const parsed = parseCli(["opencode", "model", "reset"]);
    assert.equal(parsed.route.harnessId, "opencode");
    assert.equal(parsed.route.noun, "model");
    assert.equal(parsed.route.verb, "reset");
  });

  it("rejects removed set verb", () => {
    assert.throws(() => parseCli(["claude", "set", "--main", "x"]), /Unknown harness command: set/);
  });

  it("routes harness help to global help with topic", () => {
    const parsed = parseCli(["claude", "help"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.helpTopic, "claude");
  });

  it("routes harness --help to that harness topic", () => {
    const parsed = parseCli(["opencode", "--help"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.helpTopic, "opencode");
  });

  it("rejects unknown top-level command", () => {
    assert.throws(() => parseCli(["on"]), /Unknown command: on/);
  });

  it("redirects bare global model commands to harness scope", () => {
    assert.throws(() => parseCli(["model", "list"]), /model commands are harness-scoped/);
    assert.throws(() => parseCli(["model", "select"]), /model commands are harness-scoped/);
  });
});
