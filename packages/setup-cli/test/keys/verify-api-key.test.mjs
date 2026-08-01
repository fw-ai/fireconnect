import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { identityLabel, verifyFireworksApiKey } from "../../lib/keys/verify-api-key.mjs";

/** Minimal /verifyApiKey mock: replies with a fixed status + headers. */
function startMock({ status = 200, headers = {} } = {}) {
  const server = createServer((_req, res) => {
    res.writeHead(status, headers);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe("verifyFireworksApiKey", () => {
  it("ok with email + accountId from response headers", async () => {
    const g = await startMock({
      status: 200,
      headers: { "x-fireworks-developer-email": "dev@example.com", "x-fireworks-account-id": "acct-1" },
    });
    try {
      const r = await verifyFireworksApiKey("fw_any", { gatewayUrl: g.url });
      assert.equal(r.ok, true);
      assert.equal(r.reason, "");
      assert.equal(r.email, "dev@example.com");
      assert.equal(r.accountId, "acct-1");
      assert.equal(r.status, 200);
    } finally {
      g.server.close();
    }
  });

  it("ok even when the email header is absent (accountId only)", async () => {
    const g = await startMock({ status: 200, headers: { "x-fireworks-account-id": "acct-1" } });
    try {
      const r = await verifyFireworksApiKey("fw_any", { gatewayUrl: g.url });
      assert.equal(r.ok, true);
      assert.equal(r.email, "");
      assert.equal(r.accountId, "acct-1");
    } finally {
      g.server.close();
    }
  });

  it("401 -> rejected", async () => {
    const g = await startMock({ status: 401 });
    try {
      const r = await verifyFireworksApiKey("fw_bad", { gatewayUrl: g.url });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "rejected");
      assert.equal(r.status, 401);
    } finally {
      g.server.close();
    }
  });

  it("403 -> rejected", async () => {
    const g = await startMock({ status: 403 });
    try {
      const r = await verifyFireworksApiKey("fw_bad", { gatewayUrl: g.url });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "rejected");
    } finally {
      g.server.close();
    }
  });

  it("500 -> http (not rejected)", async () => {
    const g = await startMock({ status: 500 });
    try {
      const r = await verifyFireworksApiKey("fw_any", { gatewayUrl: g.url });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "http");
      assert.equal(r.status, 500);
    } finally {
      g.server.close();
    }
  });

  it("unreachable host -> network with detail", async () => {
    const r = await verifyFireworksApiKey("fw_any", { gatewayUrl: "http://127.0.0.1:1" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "network");
    assert.equal(r.status, 0);
    assert.ok(r.detail, "network failures must carry a detail message");
    assert.notEqual(r.detail, "fetch failed", "surface the underlying network cause");
  });
});

describe("identityLabel", () => {
  it("prefers email over accountId", () => {
    assert.equal(identityLabel({ email: "dev@example.com", accountId: "acct-1" }), "dev@example.com");
  });

  it("falls back to accountId when email is empty", () => {
    assert.equal(identityLabel({ email: "", accountId: "acct-1" }), "acct-1");
  });

  it("is empty when neither is present", () => {
    assert.equal(identityLabel({ email: "", accountId: "" }), "");
  });
});
