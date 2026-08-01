import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FIREROUTER_MODEL_ID,
  FIREROUTER_ROUTER_ID,
  isFirerouterModel,
  normalizeModelId,
} from "../../lib/fireworks/model-id.mjs";
import {
  anthropicKeyPromptCopy,
  buildClaudeCustomHeaders,
  evaluateAnthropicKeyPrompt,
  firerouterByokHeaders,
  firerouterStatusFromEnv,
  resolveFirerouterByokKeys,
} from "../../lib/firerouter/core.mjs";
import {
  preferLatestAliases,
  registerableModelIds,
} from "../../lib/fireworks/models.mjs";
import { globalListIncludesFirerouter } from "../../lib/fireworks/model-list.mjs";
import {
  FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE,
  assertFirerouterWorkspaceByok,
  assertFirerouterKeyType,
  firerouterByokEnvRefHeaders,
  firerouterCredentialsApplyOnGateway,
  firerouterCredentialsRequiredMessage,
  firerouterCredentialsSatisfied,
  resolveExplicitFirerouterCredential,
  resolveFirerouterAvailability,
  resolveFirerouterByokHeaders,
  resolveFirerouterPlan,
  resolveWorkspaceByok,
  resolveWorkspaceByokStatus,
  shouldAutoIncludeFirerouter,
  supportsRoutingPreference,
} from "../../lib/firerouter/flag.mjs";

describe("firerouter model recognition", () => {
  it("global model list includes FireRouter only for standard keys", () => {
    assert.equal(globalListIncludesFirerouter("fireworks"), true);
    assert.equal(globalListIncludesFirerouter("firepass"), false);
  });

  it("recognizes firerouter regardless of prefix or context suffix", () => {
    for (const id of ["firerouter", "FireRouter", "firerouter[1m]", "fireworks-ai/firerouter", "fireworks/firerouter"]) {
      assert.equal(isFirerouterModel(id), true, id);
    }
    for (const id of ["glm-fast-latest", "accounts/fireworks/models/deepseek-v4-flash", "", null, undefined]) {
      assert.equal(isFirerouterModel(id), false, String(id));
    }
  });

  it("normalizeModelId keeps gateway slugs short (no accounts/fireworks expansion)", () => {
    assert.equal(normalizeModelId("firerouter"), FIREROUTER_MODEL_ID);
    assert.equal(normalizeModelId("firerouter[1m]"), FIREROUTER_MODEL_ID);
    assert.equal(normalizeModelId("fireworks-ai/firerouter"), FIREROUTER_MODEL_ID);
    assert.equal(normalizeModelId("accounts/fireworks/routers/firerouter"), FIREROUTER_MODEL_ID);
    assert.equal(FIREROUTER_MODEL_ID, "firerouter");
    assert.equal(normalizeModelId("glm-fast-latest"), "glm-fast-latest");
    assert.equal(normalizeModelId("deepseek-v4-flash"), "deepseek-v4-flash");
  });

  it("status detects firerouter in any Claude slot", () => {
    assert.equal(
      firerouterStatusFromEnv({
        ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "firerouter",
      }),
      "firerouter",
    );
    // Direct mode on the same gateway is not firerouter.
    assert.equal(
      firerouterStatusFromEnv({
        ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
        ANTHROPIC_MODEL: "accounts/fireworks/routers/glm-fast-latest",
      }),
      "other",
    );
  });

  it("buildClaudeCustomHeaders adds the Anthropic BYOK header only when a key is present", () => {
    const withByok = buildClaudeCustomHeaders({ fireworksKey: "fw_key", anthropicKey: "sk-ant-byok" });
    assert.match(withByok, /X-Fireworks-Api-Key: fw_key/);
    assert.match(withByok, /x-anthropic-api-key: sk-ant-byok/);

    const noByok = buildClaudeCustomHeaders({ fireworksKey: "fw_key" });
    assert.match(noByok, /X-Fireworks-Api-Key: fw_key/);
    assert.equal(/x-anthropic-api-key/.test(noByok), false);
  });
});

describe("firerouter routing plan", () => {
  it("resolveFirerouterPlan selects firerouter only for --model firerouter", () => {
    assert.deepEqual(resolveFirerouterPlan({ main: "firerouter" }), {
      mainModel: "firerouter",
      isFirerouter: true,
    });
    assert.deepEqual(resolveFirerouterPlan({ main: "accounts/fireworks/routers/firerouter" }), {
      mainModel: "accounts/fireworks/routers/firerouter",
      isFirerouter: true,
    });
  });

  it("resolveFirerouterPlan keeps an explicit non-firerouter model", () => {
    assert.deepEqual(resolveFirerouterPlan({ main: "glm-fast-latest" }), {
      mainModel: "glm-fast-latest",
      isFirerouter: false,
    });
  });

  it("resolveFirerouterPlan never auto-defaults to firerouter (no --model → harness default)", () => {
    assert.deepEqual(resolveFirerouterPlan({ main: "" }), { mainModel: "", isFirerouter: false });
    assert.deepEqual(resolveFirerouterPlan({}), { mainModel: "", isFirerouter: false });
  });

  it("resolveFirerouterPlan: Fire Pass with no model is fine (returns the harness default)", () => {
    assert.deepEqual(resolveFirerouterPlan({ main: "" }, { keyType: "firepass" }), {
      mainModel: "",
      isFirerouter: false,
    });
  });

  it("resolveFirerouterPlan: explicit firerouter with a Fire Pass key throws", () => {
    assert.throws(
      () => resolveFirerouterPlan({ main: "firerouter" }, { keyType: "firepass" }),
      new RegExp(FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE.slice(0, 20)),
    );
  });

  it("assertFirerouterKeyType throws for firerouter + Fire Pass, allows otherwise", () => {
    assert.throws(
      () => assertFirerouterKeyType(FIREROUTER_MODEL_ID, "firepass"),
      new RegExp(FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE.slice(0, 20)),
    );
    // firerouter with a standard key is fine.
    assertFirerouterKeyType(FIREROUTER_MODEL_ID, "fireworks");
    // a non-firerouter model with a Fire Pass key is fine.
    assertFirerouterKeyType("accounts/fireworks/routers/glm-fast-latest", "firepass");
  });

  it("firerouterCredentialsApplyOnGateway is true only for standard Fireworks keys", () => {
    assert.equal(firerouterCredentialsApplyOnGateway("fireworks"), true);
    assert.equal(firerouterCredentialsApplyOnGateway("firepass"), false);
  });

  it("assertFirerouterWorkspaceByok requires workspace BYOK for byok:none harnesses", () => {
    assert.doesNotThrow(() => assertFirerouterWorkspaceByok({
      availability: { include: true },
    }));
    assert.throws(
      () => assertFirerouterWorkspaceByok({ availability: { include: false } }),
      /Ask the Fireworks team to enable FireRouter/,
    );
    assert.doesNotThrow(() => assertFirerouterWorkspaceByok({
      availability: {
        include: false,
        workspaceByokLookup: { enabled: false, unavailable: true, reason: "network down" },
      },
    }));
  });

  it("firerouterCredentialsRequiredMessage matches harness BYOK mode", () => {
    assert.match(
      firerouterCredentialsRequiredMessage({ byok: "value" }),
      /Anthropic API key/,
    );
    assert.match(
      firerouterCredentialsRequiredMessage({ byok: "envref" }),
      /ANTHROPIC_API_KEY/,
    );
    assert.match(
      firerouterCredentialsRequiredMessage({ byok: "none" }),
      /Ask the Fireworks team to enable FireRouter/,
    );
  });

  it("distinguishes required Claude auth copy from optional BYOK copy", () => {
    const required = anthropicKeyPromptCopy({ explicit: true, allowSkip: false });
    assert.match(required.intro, /requires an Anthropic API key/);
    assert.match(required.prompt, /required/);
    assert.doesNotMatch(`${required.intro} ${required.prompt} ${required.invalid}`, /skip/i);

    const optional = anthropicKeyPromptCopy({ explicit: true, allowSkip: true });
    assert.match(optional.prompt, /Enter to skip/);
  });

  it("retries empty and malformed required Anthropic keys", () => {
    assert.deepEqual(
      evaluateAnthropicKeyPrompt("", { allowSkip: false }),
      { key: "", retry: true },
    );
    assert.deepEqual(
      evaluateAnthropicKeyPrompt("not-a-key", { allowSkip: false }),
      { key: "", retry: true },
    );
    assert.deepEqual(
      evaluateAnthropicKeyPrompt("", { allowSkip: true }),
      { key: "", retry: false },
    );
    assert.deepEqual(
      evaluateAnthropicKeyPrompt("sk-ant-valid", { allowSkip: false }),
      { key: "sk-ant-valid", retry: false },
    );
  });

  it("firerouterCredentialsSatisfied treats unavailable workspace lookup as satisfied", () => {
    assert.equal(firerouterCredentialsSatisfied({ include: true }), true);
    assert.equal(firerouterCredentialsSatisfied({ include: false }), false);
    assert.equal(firerouterCredentialsSatisfied({
      include: false,
      workspaceByokLookup: { enabled: false, unavailable: true, reason: "offline" },
    }), true);
  });

  it("preferLatestAliases keeps aliases or only the newest concrete family version", () => {
    const catalog = [
      { shortId: "deepseek-v3", id: "accounts/fireworks/models/deepseek-v3" },
      { shortId: "deepseek-v4-flash", id: "accounts/fireworks/models/deepseek-v4-flash" },
      { shortId: "deepseek-v4-pro", id: "accounts/fireworks/models/deepseek-v4-pro" },
      { shortId: "gpt-oss-120b", id: "accounts/fireworks/models/gpt-oss-120b" },
      { shortId: "glm-5p1", id: "accounts/fireworks/models/glm-5p1" },
      { shortId: "glm-5p1-fast", id: "accounts/fireworks/routers/glm-5p1-fast", baseModelId: "accounts/fireworks/models/glm-5p1" },
      { shortId: "glm-5p2", id: "accounts/fireworks/models/glm-5p2" },
      { shortId: "glm-5p2-fast", id: "accounts/fireworks/routers/glm-5p2-fast", baseModelId: "accounts/fireworks/models/glm-5p2" },
      { shortId: "glm-fast-latest", id: "accounts/fireworks/routers/glm-fast-latest", baseModelId: "accounts/fireworks/models/glm-5p2" },
      { shortId: "glm-latest", id: "accounts/fireworks/routers/glm-latest", baseModelId: "accounts/fireworks/models/glm-5p2" },
      { shortId: "kimi-k2p7-code", id: "accounts/fireworks/models/kimi-k2p7-code" },
      { shortId: "kimi-latest", id: "accounts/fireworks/routers/kimi-latest", baseModelId: "accounts/fireworks/models/kimi-k2p7-code" },
      { shortId: "minimax-m2p7", id: "accounts/fireworks/models/minimax-m2p7" },
      { shortId: "minimax-m3", id: "accounts/fireworks/models/minimax-m3" },
      { shortId: "minimax-latest", id: "accounts/fireworks/routers/minimax-latest", baseModelId: "accounts/fireworks/models/minimax-m3" },
      { shortId: "qwen3p6-plus", id: "accounts/fireworks/models/qwen3p6-plus" },
      { shortId: "qwen3p7-plus", id: "accounts/fireworks/models/qwen3p7-plus" },
      { shortId: "qwen-plus-latest", id: "accounts/fireworks/routers/qwen-plus-latest", baseModelId: "accounts/fireworks/models/qwen3p7-plus" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gpt-oss-120b",
      "glm-fast-latest",
      "glm-latest",
      "kimi-latest",
      "minimax-latest",
      "qwen-plus-latest",
    ]);
  });

  it("registerableModelIds includes firerouter only when requested and supported", () => {
    const catalog = [
      {
        shortId: "glm-latest",
        id: "accounts/fireworks/routers/glm-latest",
      },
    ];
    assert.deepEqual(
      registerableModelIds(catalog, "fireworks"),
      ["accounts/fireworks/routers/glm-latest"],
    );
    assert.deepEqual(
      registerableModelIds(catalog, "fireworks", { includeFirerouter: true }),
      [
        FIREROUTER_ROUTER_ID,
        "accounts/fireworks/routers/glm-latest",
      ],
    );
    assert.deepEqual(
      registerableModelIds(catalog, "firepass", { includeFirerouter: true }),
      ["accounts/fireworks/routers/glm-latest"],
    );
    assert.deepEqual(
      registerableModelIds(
        [{ shortId: "firerouter", id: FIREROUTER_ROUTER_ID }, ...catalog],
        "fireworks",
      ),
      ["accounts/fireworks/routers/glm-latest"],
    );
  });

  it("also auto-registers for a valid Anthropic env key on forwarding harnesses", () => {
    const base = { autoFirerouter: true, keyType: "fireworks" };
    assert.equal(shouldAutoIncludeFirerouter({
      ...base,
      byok: "value",
      anthropicApiKey: "sk-ant-valid",
    }), true);
    assert.equal(shouldAutoIncludeFirerouter({
      ...base,
      byok: "envref",
      anthropicApiKey: "sk-ant-valid",
    }), true);
    assert.equal(shouldAutoIncludeFirerouter({
      ...base,
      byok: "none",
      anthropicApiKey: "sk-ant-valid",
    }), false);
    assert.equal(shouldAutoIncludeFirerouter({
      ...base,
      byok: "value",
      anthropicApiKey: "not-an-anthropic-key",
    }), false);
    assert.equal(shouldAutoIncludeFirerouter({
      ...base,
      byok: "value",
      anthropicApiKey: "sk-ant-valid",
      keyType: "firepass",
      workspaceByok: true,
    }), false);
    assert.equal(shouldAutoIncludeFirerouter({
      ...base,
      byok: "none",
      workspaceByok: true,
    }), true);
    assert.equal(shouldAutoIncludeFirerouter({
      ...base,
      autoFirerouter: false,
      byok: "value",
      anthropicApiKey: "sk-ant-valid",
      workspaceByok: true,
    }), false);
  });

  it("limits routing-preference hints to custom-header BYOK harnesses", () => {
    assert.equal(supportsRoutingPreference({ byok: "value", autoCatalog: true }), true);
    assert.equal(supportsRoutingPreference({ byok: "envref", autoCatalog: true }), false);
    assert.equal(supportsRoutingPreference({ byok: "none", autoCatalog: true }), false);
    assert.equal(supportsRoutingPreference(null), false);
  });

  it("resolves automatic availability from local BYOK before workspace BYOK", async () => {
    let workspaceLookups = 0;
    const local = await resolveFirerouterAvailability({
      firerouter: { byok: "envref", autoCatalog: true },
      keyType: "fireworks",
      workspaceApiKey: "fw_test",
      home: "/tmp/test",
    }, {
      resolveAnthropic: async () => "sk-ant-stored",
      resolveWorkspace: async () => {
        workspaceLookups += 1;
        return true;
      },
    });
    assert.deepEqual(local, {
      include: true,
      workspaceByok: false,
    });
    assert.equal(workspaceLookups, 0);

    const workspace = await resolveFirerouterAvailability({
      firerouter: { byok: "envref", autoCatalog: true },
      keyType: "fireworks",
      workspaceApiKey: "fw_test",
    }, {
      resolveAnthropic: async () => "",
      resolveWorkspace: async (key) => key === "fw_test",
    });
    assert.deepEqual(workspace, {
      include: true,
      workspaceByok: true,
      workspaceByokLookup: {
        enabled: true,
        unavailable: false,
        reason: "",
      },
    });

    const unavailable = await resolveFirerouterAvailability({
      firerouter: { byok: "value", autoCatalog: true },
      keyType: "fireworks",
      workspaceApiKey: "fw_test",
    }, {
      resolveAnthropic: async () => "",
      resolveWorkspace: async () => ({
        enabled: false,
        unavailable: true,
        reason: "network down",
      }),
    });
    assert.deepEqual(unavailable, {
      include: false,
      workspaceByok: false,
      workspaceByokLookup: {
        enabled: false,
        unavailable: true,
        reason: "network down",
      },
    });
  });

});

describe("firerouter BYOK", () => {
  const withoutProviderEnv = async (fn) => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
  };

  it("firerouterByokHeaders includes the Anthropic key when present", () => {
    assert.deepEqual(firerouterByokHeaders({ anthropicKey: "sk-ant-a" }), { "x-anthropic-api-key": "sk-ant-a" });
    assert.deepEqual(firerouterByokHeaders({}), {});
  });

  it("resolveFirerouterByokKeys uses a provided key without prompting", async () => {
    await withoutProviderEnv(async () => {
      const keys = await resolveFirerouterByokKeys({ anthropicFlag: "sk-ant-flag" });
      assert.equal(keys.anthropicKey, "sk-ant-flag");
    });
  });

  it("resolveFirerouterByokKeys returns empty when none available on a non-TTY (prompt is a no-op)", async () => {
    await withoutProviderEnv(async () => {
      const keys = await resolveFirerouterByokKeys({});
      assert.equal(keys.anthropicKey, "");
    });
  });

  it("resolveFirerouterByokKeys skips the prompt when workspace BYOK is provisioned", async () => {
    await withoutProviderEnv(async () => {
      let probed = 0;
      const keys = await resolveFirerouterByokKeys({ resolveWorkspaceByok: async () => { probed += 1; return true; } });
      assert.equal(keys.anthropicKey, "");
      assert.equal(probed, 1, "workspace BYOK is checked before prompting");
    });
  });

  it("resolveFirerouterByokKeys never probes workspace BYOK when a key is already supplied", async () => {
    await withoutProviderEnv(async () => {
      let probed = 0;
      const keys = await resolveFirerouterByokKeys({
        anthropicFlag: "sk-ant-x",
        resolveWorkspaceByok: async () => { probed += 1; return true; },
      });
      assert.equal(keys.anthropicKey, "sk-ant-x");
      assert.equal(probed, 0, "no lookup when a BYOK key is present");
    });
  });

  const planFor = ({ isFirerouter = false } = {}) => ({
    mainModel: isFirerouter ? FIREROUTER_MODEL_ID : "accounts/fireworks/routers/glm-fast-latest",
    isFirerouter,
  });

  it("resolveFirerouterByokHeaders returns {} for a non-firerouter plan", async () => {
    const headers = await resolveFirerouterByokHeaders({ plan: planFor({ isFirerouter: false }), ctx: {} });
    assert.deepEqual(headers, {});
  });

  it("resolveFirerouterByokHeaders resolves BYOK for auto-cataloged firerouter", async () => {
    await withoutProviderEnv(async () => {
      const headers = await resolveFirerouterByokHeaders({
        plan: planFor({ isFirerouter: false }),
        catalogFirerouter: true,
        ctx: { anthropicKey: "sk-ant-catalog", anthropicKeyFromFlag: true },
      });
      assert.deepEqual(headers, { "x-anthropic-api-key": "sk-ant-catalog" });
    });
  });

  it("resolveFirerouterByokHeaders forwards a flagged Anthropic key for a firerouter plan", async () => {
    await withoutProviderEnv(async () => {
      const headers = await resolveFirerouterByokHeaders({
        plan: planFor({ isFirerouter: true }),
        ctx: { anthropicKey: "sk-ant-flag", anthropicKeyFromFlag: true },
      });
      assert.deepEqual(headers, { "x-anthropic-api-key": "sk-ant-flag" });
    });
  });

  it("resolveFirerouterByokHeaders returns {} for a firerouter plan with no key available (non-TTY)", async () => {
    await withoutProviderEnv(async () => {
      const headers = await resolveFirerouterByokHeaders({ plan: planFor({ isFirerouter: true }), ctx: {} });
      assert.deepEqual(headers, {});
    });
  });

  it("firerouterByokEnvRefHeaders returns the Anthropic env ref only for a firerouter plan", () => {
    assert.deepEqual(firerouterByokEnvRefHeaders(planFor({ isFirerouter: false })), {});
    assert.deepEqual(
      firerouterByokEnvRefHeaders(planFor({ isFirerouter: true })),
      { "x-anthropic-api-key": "ANTHROPIC_API_KEY" },
    );
    assert.deepEqual(
      firerouterByokEnvRefHeaders(planFor({ isFirerouter: false }), { catalogFirerouter: true }),
      { "x-anthropic-api-key": "ANTHROPIC_API_KEY" },
    );
  });
});

describe("resolveWorkspaceByok", () => {
  const verifyOk = async () => ({ ok: true, accountId: "acct-1" });
  const lookup = (result) => async () => result;

  it("true when enable-workspace-byok is active", async () => {
    const on = await resolveWorkspaceByok("fw_k", {
      verifyKey: verifyOk,
      lookupFlag: lookup({ enabled: true, unavailable: false, reason: "" }),
    });
    assert.equal(on, true);
  });

  it("false when the flag is absent", async () => {
    const off = await resolveWorkspaceByok("fw_k", {
      verifyKey: verifyOk,
      lookupFlag: lookup({ enabled: false, unavailable: false, reason: "" }),
    });
    assert.equal(off, false);
  });

  it("preserves unavailable lookup details while the boolean view fails open", async () => {
    const status = await resolveWorkspaceByokStatus("fw_k", {
      verifyKey: verifyOk,
      lookupFlag: lookup({ enabled: false, unavailable: true, reason: "network down" }),
    });
    assert.deepEqual(status, {
      enabled: false,
      unavailable: true,
      reason: "network down",
    });
    assert.equal(await resolveWorkspaceByok("fw_k", {
      verifyKey: verifyOk,
      lookupFlag: lookup(status),
    }), false);
  });

  it("reports verification failures, missing account IDs, throws, and empty keys distinctly", async () => {
    assert.deepEqual(
      await resolveWorkspaceByokStatus("fw_k", {
        verifyKey: async () => ({ ok: false, reason: "rejected" }),
      }),
      { enabled: false, unavailable: true, reason: "rejected" },
    );
    assert.deepEqual(
      await resolveWorkspaceByokStatus("fw_k", {
        verifyKey: async () => ({ ok: true, accountId: "" }),
      }),
      {
        enabled: false,
        unavailable: true,
        reason: "API key verification returned no account ID",
      },
    );
    assert.deepEqual(
      await resolveWorkspaceByokStatus("fw_k", {
        verifyKey: async () => { throw new Error("timeout"); },
      }),
      { enabled: false, unavailable: true, reason: "timeout" },
    );
    let verified = false;
    assert.deepEqual(
      await resolveWorkspaceByokStatus("", {
        verifyKey: async () => {
          verified = true;
          return { ok: true, accountId: "a" };
        },
      }),
      { enabled: false, unavailable: false, reason: "" },
    );
    assert.equal(verified, false, "no network for an empty key");
  });
});
