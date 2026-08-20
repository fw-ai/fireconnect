import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import {
  USER_SETTINGS_RELATIVE_PATH,
} from "../../../lib/harnesses/claude/core.mjs";
import { FIREWORKS_BASE_URL } from "../../../lib/fireworks/model-id.mjs";
import { FIRECONNECT_REFERER, runFireconnect, withTempHome, assertClaudeMainModel } from "../../helpers.mjs";

const FIREWORKS_KEY = "fw_claude_matrix_key_000000000000";
const ANTHROPIC_KEY = "sk-ant-claude-matrix-byok";
const KIMI_FABLE_MODEL = "kimi-fast-latest[1m]";
const FIREROUTER_MODEL = "firerouter[1m]";
const SUBSCRIPTION_SETTINGS = `${JSON.stringify({
  model: "sonnet",
  theme: "dark",
}, null, 2)}\n`;
const SUBSCRIPTION_CREDENTIALS = `${JSON.stringify({
  claudeAiOauth: {
    accessToken: "oauth-test-token",
    refreshToken: "oauth-test-refresh",
  },
}, null, 2)}\n`;

async function startWorkspaceByokGateway({ unavailable = false } = {}) {
  const server = createServer((request, response) => {
    if (request.url === "/verifyApiKey") {
      if (unavailable) {
        response.writeHead(503);
        response.end("temporarily unavailable");
        return;
      }
      response.writeHead(200, {
        "x-fireworks-account-id": "acct-workspace-byok",
      });
      response.end();
      return;
    }
    if (request.url === "/v1/accounts/acct-workspace-byok/featureFlags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        featureFlags: [{
          name: "accounts/acct-workspace-byok/featureFlags/enable-workspace-byok",
          value: "true",
        }],
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

async function pathExists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

const scenarios = [];
for (const subscription of [true, false]) {
  for (const byok of [true, false]) {
    for (const firerouter of [true, false]) {
      scenarios.push({ subscription, byok, firerouter });
    }
  }
}

describe("Claude subscription, BYOK, and FireRouter matrix", () => {
  for (const scenario of scenarios) {
    const subscriptionLabel = scenario.subscription ? "subscription" : "no subscription";
    const byokLabel = scenario.byok ? "BYOK" : "no BYOK";
    const modeLabel = scenario.firerouter ? "explicit Opus FireRouter" : "fresh defaults";

    it(`${subscriptionLabel}, ${byokLabel}, ${modeLabel}`, async () => {
      await withTempHome("claude-auth-matrix-", async (home) => {
        const claudeDir = path.join(home, ".claude");
        const settingsPath = path.join(home, USER_SETTINGS_RELATIVE_PATH);
        const credentialsPath = path.join(claudeDir, ".credentials.json");
        await mkdir(claudeDir, { recursive: true });

        if (scenario.subscription) {
          await writeFile(settingsPath, SUBSCRIPTION_SETTINGS);
          await writeFile(credentialsPath, SUBSCRIPTION_CREDENTIALS);
        }
        if (scenario.byok) {
          await writeGlobalConfig(home, { anthropicApiKey: ANTHROPIC_KEY });
        }

        const args = [
          "claude",
          "on",
          "--api-key",
          FIREWORKS_KEY,
          ...(scenario.firerouter ? ["--opus", "firerouter"] : []),
        ];
        const env = {
          HOME: home,
          FIREWORKS_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        };
        const enabled = await runFireconnect(args, env);
        assert.equal(enabled.code, 0, enabled.stderr);

        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        const headers = settings.env.ANTHROPIC_CUSTOM_HEADERS;
        assert.equal(settings.env.ANTHROPIC_BASE_URL, FIREWORKS_BASE_URL);
        assert.equal(
          settings.env.ANTHROPIC_API_KEY,
          scenario.byok ? ANTHROPIC_KEY : undefined,
        );
        assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
        // Main stays native (unpinned) in every scenario; FireRouter is Opus-tier
        // so it lands on Opus (explicitly or via the fresh-default auto-pin), not Main.
        const expectedMain = undefined;
        // Opus is firerouter whenever the slot is requested or auto-pinned for
        // fw_ keys (no longer gated on detecting OAuth/BYOK up front).
        const expectedOpus = FIREROUTER_MODEL;
        assertClaudeMainModel(settings, expectedMain);
        assert.equal(
          settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
          expectedOpus,
        );
        // Sonnet is native by default, so its alias env key is never written.
        assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
        // Fable carries the vision model in every scenario now, so the old
        // firerouter-only shift is gone.
        assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, KIMI_FABLE_MODEL);
        assert.equal(settings.apiKeyHelper, undefined);
        assert.match(headers, new RegExp(`X-Fireworks-Api-Key: ${FIREWORKS_KEY}`));
        assert.match(headers, /X-Title: Claude Code/);
        assert.ok(headers.includes(`HTTP-Referer: ${FIRECONNECT_REFERER}`), headers);
        assert.doesNotMatch(headers, /x-anthropic-api-key:/i);
        assert.doesNotMatch(enabled.stdout, /FireRouter off/);
        assert.doesNotMatch(enabled.stdout, /Sign in to Claude/);

        if (scenario.subscription) {
          assert.equal(await readFile(credentialsPath, "utf8"), SUBSCRIPTION_CREDENTIALS);
        } else {
          assert.equal(await pathExists(credentialsPath), false);
        }

        const disabled = await runFireconnect(["claude", "off"], env);
        assert.equal(disabled.code, 0, disabled.stderr);
        if (scenario.subscription) {
          assert.equal(await readFile(settingsPath, "utf8"), SUBSCRIPTION_SETTINGS);
          assert.equal(await readFile(credentialsPath, "utf8"), SUBSCRIPTION_CREDENTIALS);
        } else {
          assert.equal(await pathExists(settingsPath), false);
          assert.equal(await pathExists(credentialsPath), false);
        }
      });
    });
  }

  it("uses workspace BYOK for the fresh FireRouter default without a local Anthropic key", async () => {
    const gateway = await startWorkspaceByokGateway();
    try {
      await withTempHome("claude-workspace-byok-", async (home) => {
        const result = await runFireconnect(
          ["claude", "on", "--api-key", FIREWORKS_KEY],
          {
            HOME: home,
            FIREWORKS_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            FIRECONNECT_GATEWAY_URL: gateway.url,
            FIRECONNECT_GATEWAY_GRPC_WEB_URL: `${gateway.url}/grpc`,
          },
        );
        assert.equal(result.code, 0, result.stderr);

        const settings = JSON.parse(
          await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"),
        );
        assert.equal(settings.model, undefined);
        assert.equal(settings.env?.ANTHROPIC_MODEL, undefined);
        assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREROUTER_MODEL);
        // Sonnet is native by default, so its alias env key is never written.
        assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
        assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, KIMI_FABLE_MODEL);
        assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
        assert.doesNotMatch(settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anthropic-api-key/i);
      });
    } finally {
      gateway.server.close();
    }
  });

  it("keeps explicit FireRouter usable when workspace BYOK verification is unavailable", async () => {
    const gateway = await startWorkspaceByokGateway({ unavailable: true });
    try {
      await withTempHome("claude-workspace-byok-unavailable-", async (home) => {
        const result = await runFireconnect(
          ["claude", "on", "--non-interactive", "--opus", "firerouter"],
          {
            HOME: home,
            FIREWORKS_API_KEY: FIREWORKS_KEY,
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            FIRECONNECT_GATEWAY_URL: gateway.url,
            FIRECONNECT_GATEWAY_GRPC_WEB_URL: `${gateway.url}/grpc`,
          },
        );
        assert.equal(result.code, 0, result.stderr);

        const settings = JSON.parse(
          await readFile(path.join(home, USER_SETTINGS_RELATIVE_PATH), "utf8"),
        );
        assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, FIREROUTER_MODEL);
        assert.match(result.stdout, /FireRouter is on/);
        assert.match(result.stdout, /Couldn't verify workspace BYOK/);
      });
    } finally {
      gateway.server.close();
    }
  });
});
