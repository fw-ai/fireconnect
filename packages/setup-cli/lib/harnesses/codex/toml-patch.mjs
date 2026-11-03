/**
 * Surgical edits to Codex config.toml — only touches Nexus-owned keys/tables
 * so array-of-tables and other non-flat TOML is preserved.
 */

const CODEX_PROVIDER_TABLE_PATH = ["model_providers", "fireworks-ai"];
// Every table under one of these paths is Nexus-owned, sub-tables included:
// `[model_providers.fireworks-ai.http_headers]` holds the same keys `on`
// rewrites inline, so keeping it would define them twice.
const MANAGED_TABLE_PATHS = [
  CODEX_PROVIDER_TABLE_PATH,
  ["model_providers", "fireworks-azure"],
  ["profiles", "fireconnect"],
];
const LEGACY_FIRECONNECT_PROFILE_LINE = /^profile\s*=\s*["']fireconnect["']\s*$/;

const ROOT_PROFILE_LINE = /^(?:profile|"profile"|'profile')\s*=.+$/;
const ROOT_MODEL_PROVIDER_LINE = /^(?:model_provider|"model_provider"|'model_provider')\s*=.+$/;
const ROOT_MODEL_LINE = /^(?:model|"model"|'model')\s*=.+$/;
const ROOT_MODEL_CATALOG_LINE = /^(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=.+$/;
// fireconnect-owned cleanup: removes only the stale web_search = "disabled"
// override written by earlier releases so re-enabling restores defaults.
// User-set values (live, cached, …) are not fireconnect-owned and are kept.
const ROOT_WEB_SEARCH_DISABLED_LINE = /^web_search\s*=\s*["']disabled["']\s*(#.*)?$/;
const CODEX_BEARER_AUTH_LINE = /^experimental_bearer_token\s*=.+$/;
const CODEX_ENV_AUTH_LINE = /^env_key\s*=.+$/;
// `http_headers = {…}` or a dotted `http_headers.<name> = …` entry.
const CODEX_HTTP_HEADERS_LINE = /^(?:http_headers|"http_headers"|'http_headers')\s*[=.]/;
const CODEX_HEADERS_TABLE_PATH = [...CODEX_PROVIDER_TABLE_PATH, "http_headers"];

const TOML_ESCAPES = { "\\": "\\\\", "\"": "\\\"", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };

/**
 * A TOML basic string. Every value Nexus writes goes through here: quotes,
 * backslashes and all control characters are escaped, so a value can only
 * ever set its own key.
 */
export function tomlString(value) {
  return `"${String(value).replace(/[\\"\u0000-\u001f\u007f]/g, (c) =>
    TOML_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

function inlineTableLine(key, entries) {
  return `${key} = { ${Object.entries(entries)
    .map(([header, value]) => `${tomlString(header)} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function httpHeadersLine(httpHeaders) {
  return inlineTableLine("http_headers", httpHeaders);
}

/**
 * With `chatgptLogin`, Codex authenticates with its own ChatGPT sign-in
 * (`requires_openai_auth = true` sends that login as Authorization, and Codex
 * ignores env_key), so the Fireworks key rides in `http_headers` instead — see
 * CODEX_CHATGPT_FIREWORKS_KEY_HEADER. No bearer token is written: Codex prefers
 * one over the ChatGPT login.
 */
function providerAuthLines({ literal, apiKey, envKey = "FIREWORKS_API_KEY", chatgptLogin = false }) {
  if (chatgptLogin) {
    return ["requires_openai_auth = true"];
  }
  if (literal && apiKey) {
    return [
      `experimental_bearer_token = ${tomlString(apiKey)}`,
      "requires_openai_auth = false",
    ];
  }
  return [
    `env_key = ${tomlString(envKey)}`,
    "requires_openai_auth = false",
  ];
}

/**
 * The key path of a `[table]` or `[[array]]` header line, or null when the
 * line is not a header. Accepts every spelling TOML allows for the same
 * table: quoted keys, spaces around dots and brackets, a trailing comment.
 * @param {string} trimmed
 * @returns {string[] | null}
 */
function tableHeaderPath(trimmed) {
  if (!trimmed.startsWith("[")) {
    return null;
  }
  const arrayTable = trimmed.startsWith("[[");
  let rest = trimmed.slice(arrayTable ? 2 : 1);
  const path = [];
  for (;;) {
    rest = rest.trimStart();
    const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))/.exec(rest);
    if (!match) {
      return null;
    }
    path.push(match[1] !== undefined ? unescapeBasicKey(match[1]) : (match[2] ?? match[3]));
    rest = rest.slice(match[0].length).trimStart();
    if (!rest.startsWith(".")) {
      break;
    }
    rest = rest.slice(1);
  }
  const close = arrayTable ? "]]" : "]";
  if (!rest.startsWith(close)) {
    return null;
  }
  const trailing = rest.slice(close.length).trim();
  return trailing === "" || trailing.startsWith("#") ? path : null;
}

function unescapeBasicKey(body) {
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body;
  }
}

function pathStartsWith(path, prefix) {
  return path.length >= prefix.length && prefix.every((segment, i) => path[i] === segment);
}

function samePath(path, other) {
  return path.length === other.length && pathStartsWith(path, other);
}

function isAnyTableHeader(trimmed) {
  return tableHeaderPath(trimmed) !== null;
}

function isManagedTableHeader(trimmed) {
  const path = tableHeaderPath(trimmed);
  return path !== null && MANAGED_TABLE_PATHS.some((prefix) => pathStartsWith(path, prefix));
}

function ensureTrailingNewline(text) {
  if (!text) {
    return "";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function rootHasMatchingLine(raw, pattern) {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (isAnyTableHeader(trimmed)) {
      break;
    }
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} raw
 * @param {(args: { line: string, trimmed: string }) => "keep" | "drop" | string} onRootLine
 * @param {{ afterRootLine?: (args: { line: string, trimmed: string, out: string[] }) => void }} [hooks]
 */
function transformRootLines(raw, onRootLine, hooks = {}) {
  const lines = raw.split("\n");
  const out = [];
  let atRoot = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (atRoot) {
      const result = onRootLine({ line, trimmed });
      if (result === "drop") {
        // omit line
      } else if (result === "keep") {
        out.push(line);
      } else if (typeof result === "string") {
        out.push(result);
      } else {
        out.push(line);
      }
      hooks.afterRootLine?.({ line, trimmed, out });
    } else {
      out.push(line);
    }
    if (atRoot && isAnyTableHeader(trimmed)) {
      atRoot = false;
    }
  }

  return ensureTrailingNewline(out.join("\n"));
}

/**
 * Remove only the stale root override written by FireConnect 0.9.6.
 * @param {string} raw
 */
export function stripStaleCodexWebSearchDisabledRaw(raw) {
  if (!rootHasMatchingLine(raw, ROOT_WEB_SEARCH_DISABLED_LINE)) {
    return raw;
  }
  return transformRootLines(raw, ({ trimmed }) => (
    ROOT_WEB_SEARCH_DISABLED_LINE.test(trimmed) ? "drop" : "keep"
  ));
}

/**
 * @param {string} raw
 * @param {{ stripRootRouting?: boolean }} [options]
 */
export function stripFireconnectRoutingRaw(raw, { stripRootRouting = false } = {}) {
  const lines = raw.split("\n");
  const out = [];
  let skippingTable = false;
  let atRoot = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (LEGACY_FIRECONNECT_PROFILE_LINE.test(trimmed)) {
      continue;
    }
    if (atRoot && stripRootRouting) {
      if (ROOT_PROFILE_LINE.test(trimmed)
        || ROOT_MODEL_PROVIDER_LINE.test(trimmed)
        || ROOT_MODEL_CATALOG_LINE.test(trimmed)
        || ROOT_MODEL_LINE.test(trimmed)
        || ROOT_WEB_SEARCH_DISABLED_LINE.test(trimmed)) {
        continue;
      }
    }
    if (isAnyTableHeader(trimmed)) {
      atRoot = false;
    }
    if (isManagedTableHeader(trimmed)) {
      skippingTable = true;
      continue;
    }
    if (skippingTable) {
      if (isAnyTableHeader(trimmed)) {
        skippingTable = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }

  return ensureTrailingNewline(out.join("\n").replace(/\n+$/, "\n"));
}

/**
 * @param {string} raw
 * @param {{
 *   providerId: string,
 *   baseUrl: string,
 *   modelId: string,
 *   catalogPath?: string,
 *   apiKey?: string,
 *   literalAuth?: boolean,
 *   wireApi?: string,
 *   providerName?: string,
 *   authEnvKey?: string,
 *   httpHeaders?: Record<string, string>,
 *   envHttpHeaders?: Record<string, string>,
 *   chatgptLogin?: boolean,
 * }} routing
 */
export function patchFireconnectRoutingRaw(raw, {
  providerId,
  baseUrl,
  modelId,
  catalogPath = "",
  apiKey = "",
  literalAuth = false,
  wireApi = "responses",
  providerName = "Fireworks",
  authEnvKey = "FIREWORKS_API_KEY",
  httpHeaders = {},
  envHttpHeaders = {},
  chatgptLogin = false,
}) {
  // Leading blank lines are the separator a previous patch wrote after the
  // routing block; keeping them would add one more on every re-`on`.
  const base = stripFireconnectRoutingRaw(raw, { stripRootRouting: true }).replace(/^(?:[ \t]*\r?\n)+/, "");
  const routingBlock = [
    `model_provider = ${tomlString(providerId)}`,
    ...(catalogPath ? [`model_catalog_json = ${tomlString(catalogPath)}`] : []),
    `model = ${tomlString(modelId)}`,
  ].join("\n");
  const tablesBlock = [
    `[model_providers.${providerId}]`,
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `wire_api = ${tomlString(wireApi)}`,
    ...providerAuthLines({ literal: literalAuth, apiKey, envKey: authEnvKey, chatgptLogin }),
    ...(Object.keys(httpHeaders).length ? [httpHeadersLine(httpHeaders)] : []),
    ...(Object.keys(envHttpHeaders).length
      ? [inlineTableLine("env_http_headers", envHttpHeaders)]
      : []),
  ].join("\n");

  if (!base.trim()) {
    return `${routingBlock}\n\n${tablesBlock}\n`;
  }

  const separator = base.endsWith("\n") ? "" : "\n";
  return `${routingBlock}\n\n${base}${separator}\n${tablesBlock}\n`;
}

/**
 * Insert or update root `model_catalog_json` after `model_provider` when missing.
 * @param {string} raw
 * @param {string} catalogPath
 */
export function patchCodexCatalogRefRaw(raw, catalogPath) {
  if (!catalogPath) {
    return ensureTrailingNewline(raw);
  }

  const hasCatalog = rootHasMatchingLine(raw, ROOT_MODEL_CATALOG_LINE);
  let inserted = false;

  return transformRootLines(raw, ({ trimmed }) => {
    if (hasCatalog && ROOT_MODEL_CATALOG_LINE.test(trimmed)) {
      return `model_catalog_json = ${tomlString(catalogPath)}`;
    }
    return "keep";
  }, {
    afterRootLine: ({ trimmed, out }) => {
      if (!hasCatalog && !inserted && ROOT_MODEL_PROVIDER_LINE.test(trimmed)) {
        out.push(`model_catalog_json = ${tomlString(catalogPath)}`);
        inserted = true;
      }
    },
  });
}

/**
 * @param {string} raw
 * @param {string} modelId
 */
export function patchCodexModelRaw(raw, modelId) {
  return transformRootLines(raw, ({ trimmed }) => {
    if (/^model\s*=/.test(trimmed)) {
      return `model = ${tomlString(modelId)}`;
    }
    return "keep";
  });
}

/**
 * Rewrite the gateway provider's auth. With `chatgptLogin`, the key lives in
 * `http_headers`, so that line is rewritten from `httpHeaders` as well; any
 * other spelling of it (dotted keys, a `[….http_headers]` sub-table) is
 * dropped, or the inline line would define it twice.
 * @param {string} raw
 * @param {{
 *   apiKey: string,
 *   literalAuth: boolean,
 *   chatgptLogin?: boolean,
 *   httpHeaders?: Record<string, string>,
 * }} auth
 */
export function patchCodexProviderAuthRaw(raw, {
  apiKey,
  literalAuth,
  chatgptLogin = false,
  httpHeaders = {},
}) {
  const lines = raw.split("\n");
  const out = [];
  // Without the provider's own header there is nowhere to write the inline
  // line, so a headers sub-table must stay.
  const dropHeadersTable = chatgptLogin
    && lines.some((line) => samePath(tableHeaderPath(line.trim()) ?? [], CODEX_PROVIDER_TABLE_PATH));
  let inProviderTable = false;
  let skippingTable = false;
  let authPatched = false;
  const authLines = () => [
    ...providerAuthLines({ literal: literalAuth, apiKey, chatgptLogin }),
    ...(chatgptLogin && Object.keys(httpHeaders).length ? [httpHeadersLine(httpHeaders)] : []),
  ];
  // Ahead of the table's trailing blank lines, so a rewrite doesn't add one.
  const insertAuthLines = () => {
    let at = out.length;
    while (at > 0 && !out[at - 1].trim()) {
      at -= 1;
    }
    out.splice(at, 0, ...authLines());
    authPatched = true;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const header = tableHeaderPath(trimmed);
    if (header) {
      if (inProviderTable && !authPatched) {
        insertAuthLines();
      }
      inProviderTable = samePath(header, CODEX_PROVIDER_TABLE_PATH);
      skippingTable = dropHeadersTable && pathStartsWith(header, CODEX_HEADERS_TABLE_PATH);
      if (!skippingTable) {
        out.push(line);
      }
      continue;
    }
    if (skippingTable) {
      continue;
    }
    if (inProviderTable) {
      if (CODEX_BEARER_AUTH_LINE.test(trimmed)
        || CODEX_ENV_AUTH_LINE.test(trimmed)
        || /^requires_openai_auth\s*=/.test(trimmed)
        || (chatgptLogin && CODEX_HTTP_HEADERS_LINE.test(trimmed))) {
        continue;
      }
    }
    out.push(line);
  }

  if (inProviderTable && !authPatched) {
    insertAuthLines();
  }

  return ensureTrailingNewline(out.join("\n"));
}

/**
 * Repair a config an earlier key rotation broke: the gateway provider holds an
 * inline (or dotted) `http_headers` and a `[….http_headers]` sub-table at
 * once, which Codex refuses to load ("duplicate key"). The inline line is the
 * one Nexus wrote last, with the current key, so the sub-table is dropped. Any
 * other input is returned unchanged.
 * @param {string} raw
 */
export function repairDuplicateCodexHttpHeadersRaw(raw) {
  const lines = raw.split("\n");
  let inProviderTable = false;
  let hasInlineHeaders = false;
  let hasHeadersTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const header = tableHeaderPath(trimmed);
    if (header) {
      inProviderTable = samePath(header, CODEX_PROVIDER_TABLE_PATH);
      hasHeadersTable ||= pathStartsWith(header, CODEX_HEADERS_TABLE_PATH);
    } else if (inProviderTable && CODEX_HTTP_HEADERS_LINE.test(trimmed)) {
      hasInlineHeaders = true;
    }
  }
  if (!hasInlineHeaders || !hasHeadersTable) {
    return raw;
  }

  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = tableHeaderPath(line.trim());
    if (header) {
      skipping = pathStartsWith(header, CODEX_HEADERS_TABLE_PATH);
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return ensureTrailingNewline(out.join("\n"));
}
