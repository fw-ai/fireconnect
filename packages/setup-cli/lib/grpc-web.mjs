import { Buffer } from "node:buffer";

/**
 * Minimal gRPC-web client for the handful of control-plane calls the CLI
 * makes (mint/delete an API key after browser sign-in). Hand-rolled to
 * preserve the zero-dependency posture: the messages involved are a few
 * string and sub-message fields, which is the easy corner of protobuf.
 *
 * Wire format notes:
 * - protobuf: each field is a varint tag ((field << 3) | wireType) followed
 *   by the payload; everything we send/read is wire type 2 (length-delimited).
 * - gRPC-web: each HTTP body is a sequence of frames — 1 flag byte,
 *   4-byte big-endian length, payload. Flag 0x00 is a message, 0x80 trailers.
 */

/** @param {number} n */
function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

/**
 * Encode a length-delimited protobuf field (string, bytes, or sub-message).
 * @param {number} field
 * @param {Buffer} payload
 */
export function pbField(field, payload) {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

/**
 * @param {number} field
 * @param {string} value
 */
export function pbString(field, value) {
  return pbField(field, Buffer.from(value, "utf8"));
}

/**
 * Decode one protobuf message level into field number → payload list.
 * Length-delimited fields yield Buffers (decode nested messages by calling
 * again); varint fields yield numbers. Unknown wire types throw.
 * @param {Buffer} buf
 * @returns {Map<number, Array<Buffer|number>>}
 */
export function pbDecode(buf) {
  /** @type {Map<number, Array<Buffer|number>>} */
  const fields = new Map();
  let i = 0;
  const readVarint = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const byte = buf[i];
      i += 1;
      n += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) {
        return n;
      }
    }
  };
  while (i < buf.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wireType = tag & 7;
    let value;
    if (wireType === 0) {
      value = readVarint();
    } else if (wireType === 2) {
      const length = readVarint();
      value = buf.subarray(i, i + length);
      i += length;
    } else if (wireType === 5) {
      value = buf.subarray(i, i + 4);
      i += 4;
    } else if (wireType === 1) {
      value = buf.subarray(i, i + 8);
      i += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
    if (!fields.has(field)) {
      fields.set(field, []);
    }
    fields.get(field).push(value);
  }
  return fields;
}

/**
 * First occurrence of a length-delimited field, as a UTF-8 string ("" if absent).
 * @param {Map<number, Array<Buffer|number>>} fields
 * @param {number} field
 */
export function pbStringAt(fields, field) {
  const value = fields.get(field)?.[0];
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

/**
 * @typedef {Object} GrpcWebResult
 * @property {number} status   gRPC status code (0 = OK; -1 when unparsable).
 * @property {string} detail   grpc-message (or HTTP error text) when not OK.
 * @property {Buffer|null} message  Decoded response message bytes.
 */

/**
 * One unary gRPC-web call. Never throws on RPC failure — callers branch on
 * `status` (network errors do throw; callers already handle those).
 * @param {string} baseUrl  e.g. https://gateway.fireworks.ai/web/gateway.Gateway
 * @param {string} method   e.g. CreateApiKey
 * @param {Buffer} requestBytes
 * @param {string | { apiKey: string }} auth
 *   A string is a bearer token (session JWT / Cognito id_token). An fw_ API
 *   key must go in `x-api-key` instead — the gateway's bearer path only
 *   understands JWTs (authn.go Authenticate) — so pass `{ apiKey }` for keys.
 * @returns {Promise<GrpcWebResult>}
 */
export async function grpcWebCall(baseUrl, method, requestBytes, auth) {
  const authHeader = typeof auth === "string"
    ? { authorization: `bearer ${auth}` }
    : { "x-api-key": auth.apiKey };
  const header = Buffer.alloc(5);
  header.writeUInt32BE(requestBytes.length, 1);
  const response = await fetch(`${baseUrl}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "X-Grpc-Web": "1",
      ...authHeader,
    },
    body: Buffer.concat([header, requestBytes]),
  });

  const body = Buffer.from(await response.arrayBuffer());
  let message = null;
  let trailers = "";
  let i = 0;
  while (i + 5 <= body.length) {
    const flag = body[i];
    const length = body.readUInt32BE(i + 1);
    const payload = body.subarray(i + 5, i + 5 + length);
    if (flag & 0x80) {
      trailers = payload.toString("utf8");
    } else {
      message = payload;
    }
    i += 5 + length;
  }

  const statusText = response.headers.get("grpc-status")
    ?? /grpc-status:\s*(\d+)/i.exec(trailers)?.[1]
    ?? (message !== null ? "0" : "");
  if (statusText === "") {
    return { status: -1, detail: `HTTP ${response.status}`, message: null };
  }
  const detailRaw = /grpc-message:\s*([^\r\n]*)/i.exec(trailers)?.[1]
    ?? response.headers.get("grpc-message")
    ?? "";
  let detail = detailRaw;
  try {
    detail = decodeURIComponent(detailRaw);
  } catch {
    // grpc-message is percent-encoded per spec, but tolerate raw text
  }
  return { status: Number(statusText), detail, message };
}
