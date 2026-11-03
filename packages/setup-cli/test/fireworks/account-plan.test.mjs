import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { planLimitsCatalogToAuto } from "../../lib/fireworks/account-plan.mjs";

/** Run `fn` with the real lookup (NEXUS_TEST off) against a stubbed gateway. */
async function withGateway({ plans, plansStatus = 200, verifyStatus = 200, onRequest }, fn) {
  const previous = { fetch: globalThis.fetch, test: process.env.NEXUS_TEST, gateway: process.env.NEXUS_GATEWAY_URL };
  const requests = [];
  process.env.NEXUS_TEST = "0";
  process.env.NEXUS_GATEWAY_URL = "https://gateway.example";
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init?.headers?.Authorization });
    onRequest?.(String(url), init);
    if (String(url).endsWith("/verifyApiKey")) {
      return new Response("", { status: verifyStatus, headers: { "x-fireworks-account-id": "example-account" } });
    }
    return new Response(JSON.stringify({ nexusPlans: plans }), { status: plansStatus });
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [["NEXUS_TEST", previous.test], ["NEXUS_GATEWAY_URL", previous.gateway]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("planLimitsCatalogToAuto", () => {
  const cases = [
    ["an active Pro plan", [{ tier: "PRO", state: "ACTIVE" }], true],
    ["a Teams plan waiting for payment", [{ tier: "TEAMS", state: "PENDING_PAYMENT" }], true],
    ["an ended Pro plan with nothing newer", [{ tier: "PRO", state: "ENDED" }], true],
    ["an Enterprise plan", [{ tier: "ENTERPRISE", state: "ACTIVE" }], false],
    ["no plan", [], false],
    ["a current Enterprise plan over an ended Pro plan", [{ tier: "PRO", state: "ENDED" }, { tier: "ENTERPRISE", state: "ACTIVE" }], false],
    ["a current Pro plan over an ended Enterprise plan", [{ tier: "ENTERPRISE", state: "ENDED" }, { tier: "PRO", state: "CANCELING" }], true],
  ];
  for (const [name, plans, limited] of cases) {
    test(`${limited ? "limits" : "does not limit"} ${name}`, async () => {
      await withGateway({ plans }, async (requests) => {
        assert.equal(await planLimitsCatalogToAuto("fw_test_key"), limited);
        assert.equal(requests.at(-1).url, "https://gateway.example/v1/accounts/example-account/nexusPlans");
        assert.equal(requests.at(-1).authorization, "Bearer fw_test_key");
      });
    });
  }

  test("does not limit when the gateway rejects the key or the plan request", async () => {
    await withGateway({ plans: [{ tier: "PRO", state: "ACTIVE" }], verifyStatus: 401 }, async () => {
      assert.equal(await planLimitsCatalogToAuto("fw_test_key"), false);
    });
    await withGateway({ plans: [{ tier: "PRO", state: "ACTIVE" }], plansStatus: 403 }, async () => {
      assert.equal(await planLimitsCatalogToAuto("fw_test_key"), false);
    });
  });

  test("answers null when the lookup gets no answer", async () => {
    for (const statuses of [{ verifyStatus: 503 }, { plansStatus: 503 }, { plansStatus: 429 }]) {
      await withGateway({ plans: [{ tier: "PRO", state: "ACTIVE" }], ...statuses }, async () => {
        assert.equal(await planLimitsCatalogToAuto("fw_test_key"), null, JSON.stringify(statuses));
      });
    }
  });

  test("shares one timeout budget between key verification and the plan request", async () => {
    const previousNow = Date.now;
    const previousTimeout = AbortSignal.timeout;
    let now = 1_000;
    const timeouts = [];
    Date.now = () => now;
    AbortSignal.timeout = (milliseconds) => {
      timeouts.push(milliseconds);
      return new AbortController().signal;
    };
    try {
      await withGateway({
        plans: [{ tier: "PRO", state: "ACTIVE" }],
        onRequest: (url) => {
          if (url.endsWith("/verifyApiKey")) {
            now += 40;
          }
        },
      }, async () => {
        assert.equal(await planLimitsCatalogToAuto("fw_test_key", { timeoutMs: 100 }), true);
        assert.deepEqual(timeouts, [100, 60]);
      });
    } finally {
      Date.now = previousNow;
      AbortSignal.timeout = previousTimeout;
    }
  });

  test("NEXUS_PLAN_CATALOG_FILTER=0 turns the check off", async () => {
    process.env.NEXUS_PLAN_CATALOG_FILTER = "0";
    try {
      await withGateway({ plans: [{ tier: "PRO", state: "ACTIVE" }] }, async (requests) => {
        assert.equal(await planLimitsCatalogToAuto("fw_test_key"), false);
        assert.equal(requests.length, 0);
      });
    } finally {
      delete process.env.NEXUS_PLAN_CATALOG_FILTER;
    }
  });
});
