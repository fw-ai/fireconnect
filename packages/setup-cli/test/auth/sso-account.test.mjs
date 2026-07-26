import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { pbDecode, pbString, pbStringAt } from "../../lib/auth/grpc-web.mjs";
import { createUserJit, getOAuthArgumentsForAccount } from "../../lib/auth/sso-account.mjs";

const ID_TOKEN = "header.payload.sig";

/** @param {(req, res, body: Buffer) => void} handle */
function startServer(handle) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Frame a protobuf message (+ trailers) the way a gRPC-web server does. */
function grpcWebFrames(message, { status = 0 } = {}) {
  const frame = (flag, payload) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const trailers = Buffer.from(`grpc-status: ${status}\r\n`);
  return message === null
    ? frame(0x80, trailers)
    : Buffer.concat([frame(0, message), frame(0x80, trailers)]);
}

describe("getOAuthArgumentsForAccount", () => {
  it("resolves tenant OAuth args unauthenticated, normalizing the domain", async () => {
    const { server, url } = await startServer((req, res, body) => {
      // GetOAuthArguments is an unauthenticated RPC — no auth header at all.
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["x-api-key"], undefined);
      const request = pbDecode(body.subarray(5));
      assert.equal(pbStringAt(request, 1), "uber");
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(Buffer.concat([
        pbString(1, "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_abc"),
        pbString(2, "tenant-client-id"),
        // No scheme — the normalizer must add https://
        pbString(3, "uber.auth.us-west-2.amazoncognito.com/"),
      ])));
    });
    const result = await getOAuthArgumentsForAccount("uber", { baseUrl: url });
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.clientId, "tenant-client-id");
    assert.equal(result.cognitoDomain, "https://uber.auth.us-west-2.amazoncognito.com");
    assert.equal(result.issuerUrl, "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_abc");
    server.close();
  });

  it("maps an unknown account (PERMISSION_DENIED) to a check-your-id line", async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(null, { status: 7 }));
    });
    const result = await getOAuthArgumentsForAccount("nope", { baseUrl: url });
    assert.equal(result.ok, false);
    assert.match(result.failure, /Check the account ID/);
    assert.match(result.failure, /--paste/);
    server.close();
  });

  it("treats an account without SSO config as a friendly failure", async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      // Empty client/domain — the account exists but has no SSO sign-in.
      res.end(grpcWebFrames(Buffer.concat([pbString(1, ""), pbString(2, ""), pbString(3, "")])));
    });
    const result = await getOAuthArgumentsForAccount("plain-account", { baseUrl: url });
    assert.equal(result.ok, false);
    assert.match(result.failure, /no SSO sign-in configured/);
    server.close();
  });

  it("fails softly on network errors and empty input", async () => {
    const unreachable = await getOAuthArgumentsForAccount("uber", { baseUrl: "http://127.0.0.1:1" });
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.failure, /Couldn't reach/);
    assert.equal((await getOAuthArgumentsForAccount("  ")).ok, false);
  });
});

describe("createUserJit", () => {
  /** Gateway mock answering CreateUser with a scripted status. */
  function startJitGateway(status) {
    return startServer((req, res, body) => {
      assert.equal(req.headers.authorization, `bearer ${ID_TOKEN}`);
      const request = pbDecode(body.subarray(5));
      assert.equal(pbStringAt(request, 1), "accounts/uber");
      assert.ok(request.get(2), "carries an (empty) user message");
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(null, { status }));
    });
  }

  it("treats created and AlreadyExists as membership", async () => {
    for (const status of [0, 6]) {
      const { server, url } = await startJitGateway(status);
      const result = await createUserJit(ID_TOKEN, "uber", { baseUrl: url });
      assert.equal(result.ok, true, `status ${status}: ${result.failure}`);
      server.close();
    }
  });

  it("maps PermissionDenied to an ask-your-admin line", async () => {
    const { server, url } = await startJitGateway(7);
    const result = await createUserJit(ID_TOKEN, "uber", { baseUrl: url });
    assert.equal(result.ok, false);
    assert.match(result.failure, /ask your account admin/);
    server.close();
  });

  it("fails softly when the control plane is unreachable", async () => {
    const result = await createUserJit(ID_TOKEN, "uber", { baseUrl: "http://127.0.0.1:1" });
    assert.equal(result.ok, false);
    assert.match(result.failure, /Couldn't reach/);
  });
});
