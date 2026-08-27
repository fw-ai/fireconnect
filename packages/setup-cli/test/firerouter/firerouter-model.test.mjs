import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FIREROUTER_MODEL_ID,
  FIREROUTER_ROUTER_ID,
  isFirerouterGatewayPattern,
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

  it("matches firerouter* gateway patterns on any path segment", () => {
    for (const id of ["firerouter", "firerouter[1m]", "firerouter/x", "FireRouter/x", "firerouterx", "accounts/fireworks/routers/firerouter"]) {
      assert.equal(isFirerouterGatewayPattern(id), true, id);
    }
    for (const id of ["glm-fast-latest", "accounts/fireworks/routers/glm-latest", "", null, undefined]) {
      assert.equal(isFirerouterGatewayPattern(id), false, String(id));
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
    // The compound gateway form (firerouter/<primary>/<fallback>) is FireRouter
    // too: isFirerouter must be true, and mainModel preserved verbatim (not
    // collapsed to bare `firerouter`, which would drop the primary/fallback spec).
    assert.deepEqual(resolveFirerouterPlan({ main: "firerouter/claude-opus-5/glm-5p2" }), {
      mainModel: "firerouter/claude-opus-5/glm-5p2",
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
      { shortId: "deepseek-v4-flash-0731", id: "accounts/fireworks/models/deepseek-v4-flash-0731" },
      { shortId: "deepseek-v4-pro", id: "accounts/fireworks/models/deepseek-v4-pro" },
      { shortId: "deepseek-v4-pro-0813", id: "accounts/fireworks/models/deepseek-v4-pro-0813" },
      { shortId: "deepseek-flash-latest", id: "accounts/fireworks/routers/deepseek-flash-latest", baseModelId: "accounts/fireworks/models/deepseek-v4-flash-0731" },
      { shortId: "deepseek-pro-latest", id: "accounts/fireworks/routers/deepseek-pro-latest", baseModelId: "accounts/fireworks/models/deepseek-v4-pro-0813" },
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
      "deepseek-v3",
      "deepseek-flash-latest",
      "deepseek-pro-latest",
      "gpt-oss-120b",
      "glm-fast-latest",
      "glm-latest",
      "kimi-latest",
      "minimax-latest",
      "qwen-plus-latest",
    ]);
  });

  it("preferLatestAliases collapses pure-digit kimi fast models into kimi-fast-latest", () => {
    // kimi-k3-fast (no `p\d`) used to fall through to the per-shortId
    // fallback, so it landed in its own family and wasn't collapsed into the
    // kimi-fast-latest alias. It must share the "kimi" family.
    const catalog = [
      { shortId: "kimi-fast-latest", id: "accounts/fireworks/routers/kimi-fast-latest" },
      { shortId: "kimi-k3-fast", id: "accounts/fireworks/routers/kimi-k3-fast" },
      { shortId: "glm-fast-latest", id: "accounts/fireworks/routers/glm-fast-latest" },
      { shortId: "glm-5p2-fast", id: "accounts/fireworks/routers/glm-5p2-fast" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["kimi-fast-latest", "glm-fast-latest"]);
  });

  it("preferLatestAliases collapses the kimi-k3 base model into the kimi aliases", () => {
    // kimi-k3 (no `p\d`, no `-fast`) matched none of the vendor patterns and
    // leaked into registered catalogs next to kimi-latest/kimi-fast-latest.
    const catalog = [
      { shortId: "kimi-latest", id: "accounts/fireworks/routers/kimi-latest" },
      { shortId: "kimi-fast-latest", id: "accounts/fireworks/routers/kimi-fast-latest" },
      { shortId: "kimi-k3", id: "accounts/fireworks/models/kimi-k3" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["kimi-latest", "kimi-fast-latest"]);
  });

  it("preferLatestAliases collapses unseen families into their own -latest alias", () => {
    // A family the CLI has no vendor rule for: the base slug equals the alias
    // family (possibly with digits/dashes), so it must collapse without a
    // hand-written pattern.
    const catalog = [
      { shortId: "modelfamily-a1b2-abvc-latest", id: "accounts/fireworks/routers/modelfamily-a1b2-abvc-latest" },
      { shortId: "modelfamily-a1b2-abvc", id: "accounts/fireworks/models/modelfamily-a1b2-abvc" },
      { shortId: "newmodel-1p2", id: "accounts/fireworks/models/newmodel-1p2" },
      { shortId: "newmodel-latest", id: "accounts/fireworks/routers/newmodel-latest" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["modelfamily-a1b2-abvc-latest", "newmodel-latest"]);
  });

  it("preferLatestAliases keeps only the newest version of an aliaseless family", () => {
    // No -latest alias for the family: generic version extraction must still
    // group the variants and keep only the newest — whatever the version
    // shape (p-versions, dotted versions, multi-part versions).
    const catalog = [
      { shortId: "acme-1p2", id: "accounts/fireworks/models/acme-1p2" },
      { shortId: "acme-1p3", id: "accounts/fireworks/models/acme-1p3" },
      { shortId: "acme-1p3-fast", id: "accounts/fireworks/routers/acme-1p3-fast" },
      { shortId: "dotco-1.5", id: "accounts/fireworks/models/dotco-1.5" },
      { shortId: "dotco-1.6", id: "accounts/fireworks/models/dotco-1.6" },
      { shortId: "multi-1p2p3", id: "accounts/fireworks/models/multi-1p2p3" },
      { shortId: "multi-1p2p4", id: "accounts/fireworks/models/multi-1p2p4" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["acme-1p3", "acme-1p3-fast", "dotco-1.6", "multi-1p2p4"]);
  });

  it("preferLatestAliases keeps distinct parameter sizes separate", () => {
    // "120b"-style size suffixes are not versions: every size stays visible.
    const catalog = [
      { shortId: "gpt-oss-20b", id: "accounts/fireworks/models/gpt-oss-20b" },
      { shortId: "gpt-oss-120b", id: "accounts/fireworks/models/gpt-oss-120b" },
    ];
    const kept = preferLatestAliases(catalog).map((e) => e.shortId);
    assert.deepEqual(kept, ["gpt-oss-20b", "gpt-oss-120b"]);
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
