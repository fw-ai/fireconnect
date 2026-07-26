import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../../lib/cli/parse-args.mjs";

describe("parseCli", () => {
  it("routes bare invocation to the launcher", () => {
    const parsed = parseCli([]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "launcher");
  });

  it("keeps explicit help as help, not the launcher", () => {
    const parsed = parseCli(["help"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
  });

  it("parses global configure", () => {
    const parsed = parseCli(["configure", "--provider", "azure", "--base-url", "https://x.example.com"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "configure");
    assert.equal(parsed.ctx.provider, "azure");
  });

  it("parses global upgrade", () => {
    const parsed = parseCli(["upgrade"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "upgrade");
  });

  it("parses --version flag", () => {
    const parsed = parseCli(["--version"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
  });

  it("parses -V flag", () => {
    const parsed = parseCli(["-V"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
  });

  it("parses --version with trailing --json", () => {
    const parsed = parseCli(["--version", "--json"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses -V with trailing --json", () => {
    const parsed = parseCli(["-V", "--json"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses --json before --version", () => {
    const parsed = parseCli(["--json", "--version"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "version");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses global model list", () => {
    const parsed = parseCli(["model", "list", "--search", "glm"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "model");
    assert.equal(parsed.modelSubcommand, "list");
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

  it("parses harness usage with session selector", () => {
    const parsed = parseCli(["claude", "usage", "--session", "9b86", "--json"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "usage");
    assert.equal(parsed.ctx.session, "9b86");
    assert.equal(parsed.ctx.json, true);
  });

  it("parses harness usage with last-n selector", () => {
    const parsed = parseCli(["claude", "usage", "--last-n", "3", "-v"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "usage");
    assert.equal(parsed.ctx.lastN, "3");
    assert.equal(parsed.ctx.verbose, true);
  });

  it("parses harness usage with plain summary flag", () => {
    const parsed = parseCli(["claude", "usage", "--last-n", "3", "--plain"]);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.route.verb, "usage");
    assert.equal(parsed.ctx.lastN, "3");
    assert.equal(parsed.ctx.plain, true);
  });

  it("parses --model firerouter and the anthropic key flag", () => {
    const parsed = parseCli([
      "claude", "on", "--model", "firerouter",
      "--anthropic-api-key", "sk-ant-test",
    ]);
    assert.equal(parsed.route.harnessId, "claude");
    assert.equal(parsed.ctx.main, "firerouter");
    assert.equal(parsed.ctx.anthropicKey, "sk-ant-test");
  });

  it("rejects retired flags and points at the current spelling", () => {
    const renamed = [
      ["--main", "--model"],
      ["--router", "--model firerouter"],
      ["--anthropic-key", "--anthropic-api-key"],
      ["--last_n", "--last-n"],
    ];
    for (const [flag, replacement] of renamed) {
      assert.throws(
        () => parseCli(["claude", "on", flag, "x"]),
        new RegExp(`Unknown argument: ${flag.replace(/[-]/g, "\\-")}\\. Use ${replacement.replace(/[-]/g, "\\-")} instead`),
      );
    }
  });

  it("explains that retired OpenAI BYOK has no API-key replacement", () => {
    assert.throws(
      () => parseCli(["codex", "on", "--openai-api-key", "sk-old"]),
      /no longer supported.*Anthropic BYOK only.*--anthropic-api-key/,
    );
  });

  it("parses --routing-preference named levels into their numeric value", () => {
    const parsed = parseCli(["claude", "on", "--model", "firerouter", "--routing-preference", "balanced"]);
    assert.equal(parsed.ctx.routingPreference, 3);
    assert.equal(parseCli(["claude", "on", "--routing-preference", "max-intelligence"]).ctx.routingPreference, 1);
    assert.equal(parseCli(["claude", "on", "--routing-preference", "MAX-SAVINGS"]).ctx.routingPreference, 5);
  });

  it("accepts numeric aliases 1-5 for --routing-preference", () => {
    assert.equal(parseCli(["claude", "on", "--routing-preference", "1"]).ctx.routingPreference, 1);
    assert.equal(parseCli(["claude", "on", "--routing-preference", "5"]).ctx.routingPreference, 5);
  });

  it("leaves routing-preference unset (null) when omitted", () => {
    assert.equal(parseCli(["claude", "on", "--model", "firerouter"]).ctx.routingPreference, null);
    assert.equal(parseCli(["claude", "on"]).ctx.routingPreference, null);
  });

  it("rejects unknown names or out-of-range routing-preference", () => {
    assert.throws(() => parseCli(["claude", "on", "--routing-preference", "0"]), /must be one of/);
    assert.throws(() => parseCli(["claude", "on", "--routing-preference", "6"]), /must be one of/);
    assert.throws(() => parseCli(["claude", "on", "--routing-preference", "3.5"]), /must be one of/);
    assert.throws(() => parseCli(["claude", "on", "--routing-preference", "smart"]), /must be one of/);
    assert.throws(() => parseCli(["claude", "on", "--routing-preference"]), /requires a value/);
  });

  it("parses login flags (--force, --with-token, --paste)", () => {
    const parsed = parseCli(["login", "--paste", "--force"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "login");
    assert.equal(parsed.ctx.paste, true);
    assert.equal(parsed.ctx.force, true);
    assert.equal(parsed.ctx.withToken, false);
  });

  it("parses login --account for enterprise SSO", () => {
    const parsed = parseCli(["login", "--account", "my-company"]);
    assert.equal(parsed.ctx.account, "my-company");
    assert.throws(() => parseCli(["login", "--account"]), /requires a value/);
  });

  it("parses Anthropic key export flags", () => {
    const parsed = parseCli(["key", "export", "--anthropic", "--stored-only"]);
    assert.equal(parsed.ctx.anthropic, true);
    assert.equal(parsed.ctx.storedOnly, true);
  });

  it("rejects every harness-level model subcommand", () => {
    for (const subcommand of ["list", "select", "reset", "add"]) {
      assert.throws(
        () => parseCli(["claude", "model", subcommand]),
        /Unknown harness command.*Run: fireconnect claude help/,
      );
    }
  });

  it("rejects removed set verb", () => {
    assert.throws(() => parseCli(["claude", "set", "--model", "x"]), /Unknown harness command: set/);
  });

  it("routes harness help to global help with topic", () => {
    const parsed = parseCli(["claude", "help"]);
    assert.equal(parsed.kind, "global");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.helpTopic, "claude");
  });

  it("routes fireconnect help <harness> to the same harness topic", () => {
    const parsed = parseCli(["help", "claude"]);
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

  it("rejects unsupported global model subcommands", () => {
    assert.throws(
      () => parseCli(["model", "select"]),
      /Unexpected model subcommand: select.*Run: fireconnect help/,
    );
  });
});

describe("parseCli typo suggestions", () => {
  it("suggests the nearest command", () => {
    assert.throws(() => parseCli(["cluade", "on"]), /Did you mean: claude\?/);
    assert.throws(() => parseCli(["confgure"]), /Did you mean: configure\?/);
  });

  it("suggests the nearest flag", () => {
    assert.throws(() => parseCli(["claude", "on", "--serach", "x"]), /Did you mean: --search\?/);
  });

  it("suggests the nearest harness verb", () => {
    assert.throws(() => parseCli(["claude", "statsu"]), /Did you mean: status\?/);
    assert.throws(() => parseCli(["modle", "list"]), /Did you mean: model\?/);
  });

  it("stays quiet when nothing is close", () => {
    assert.throws(() => parseCli(["zzzzzzzz"]), (error) => {
      assert.match(error.message, /Unknown command: zzzzzzzz/);
      assert.ok(!error.message.includes("Did you mean"));
      return true;
    });
  });
});

describe("parseCli contextual help guidance", () => {
  it("points harness-scoped command and option errors to harness help", () => {
    for (const argv of [
      ["claude", "statsu"],
      ["claude", "on", "unexpected"],
      ["claude", "model", "unknown"],
      ["claude", "on", "--serach", "glm"],
      ["claude", "on", "--model"],
    ]) {
      assert.throws(
        () => parseCli(argv),
        /Run: fireconnect claude help/,
      );
    }
  });

  it("points unresolved and global errors to global help", () => {
    for (const argv of [
      ["not-a-command"],
      ["login", "unexpected"],
      ["--not-a-flag"],
      ["--home"],
      ["model", "unknown"],
      ["demo", "--not-a-demo-flag"],
    ]) {
      assert.throws(
        () => parseCli(argv),
        /Run: fireconnect help/,
      );
    }
  });
});
