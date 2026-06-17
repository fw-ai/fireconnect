import { detectApiKeyType } from "./fireconnect-core.mjs";
import { resolveStoredApiKey } from "./global-config.mjs";
import { OPENCODE_API_KEY_ENV_REF } from "./opencode-core.mjs";

export const FIREWORKS_GATEWAY_URL = "https://api.fireworks.ai";
export const PLATFORM_ACCOUNT_ID = "fireworks";
export const KIND_SERVERLESS = "serverless";
export const FIREPASS_ROUTER_ID = "accounts/fireworks/routers/kimi-k2p7-code-fast";

const BUILTIN_ROUTERS = [
  {
    id: "accounts/fireworks/routers/kimi-k2p6-turbo",
    shortId: "kimi-k2p6-turbo",
    displayName: "Kimi K2.6 Turbo via Fireworks",
    kind: KIND_SERVERLESS,
  },
  {
    id: "accounts/fireworks/routers/kimi-k2p7-code-fast",
    shortId: "kimi-k2p7-code-fast",
    displayName: "Kimi K2.7 Code Fast via Fireworks",
    kind: KIND_SERVERLESS,
  },
];

/** @typedef {{ id: string, shortId: string, displayName: string, kind: "serverless" }} CatalogEntry */

export function shortIdFromResourceName(name) {
  if (typeof name !== "string" || !name) {
    return "";
  }
  const segments = name.split("/");
  return segments.at(-1) ?? name;
}

export function isTruthy(value) {
  return value === true || value === "true";
}

export function effectiveOpencodeApiKey(storedKey) {
  if (!storedKey) {
    return "";
  }
  if (storedKey === OPENCODE_API_KEY_ENV_REF) {
    return process.env.FIREWORKS_API_KEY ?? "";
  }
  return storedKey;
}

export function isFireworksKey(key) {
  return typeof key === "string" && (key.startsWith("fw_") || key.startsWith("fpk_"));
}

/**
 * Resolve a Fireworks API key in the documented order:
 *   1. explicit `--api-key`
 *   2. `FIREWORKS_API_KEY` environment variable (env override wins over stored keys)
 *   3. harness-local stored key (via the harness adapter's `resolveKey`)
 *   4. global `~/.fireconnect/config.json`
 *
 * @param {{ apiKey?: string, resolveKey?: () => Promise<string>, home?: string }} args
 */
export async function resolveFireworksApiKey({
  apiKey = "",
  resolveKey,
  home = process.env.HOME ?? "",
}) {
  if (apiKey) {
    return apiKey.trim();
  }

  if (process.env.FIREWORKS_API_KEY) {
    return process.env.FIREWORKS_API_KEY.trim();
  }

  if (resolveKey) {
    const harnessKey = await resolveKey();
    if (harnessKey) {
      return harnessKey.trim();
    }
  }

  if (home) {
    const { readGlobalConfig } = await import("./global-config.mjs");
    const globalConfig = await readGlobalConfig(home);
    const globalKey = resolveStoredApiKey(globalConfig.apiKey);
    if (globalKey) {
      return globalKey;
    }
  }

  return "";
}

async function fetchGatewayPage(path, apiKey) {
  const response = await fetch(`${FIREWORKS_GATEWAY_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 200)}` : "";
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Fireworks API rejected the API key (${response.status}). `
        + "Check FIREWORKS_API_KEY and ensure the key can access account model listings.",
      );
    }
    throw new Error(`Fireworks API ${response.status} ${response.statusText}${detail}`);
  }

  return response.json();
}

async function fetchAllPages(path, apiKey, collectionKey) {
  const items = [];
  let pageToken = "";

  do {
    const separator = path.includes("?") ? "&" : "?";
    const tokenQuery = pageToken ? `${separator}pageToken=${encodeURIComponent(pageToken)}` : "";
    const page = await fetchGatewayPage(`${path}${tokenQuery}`, apiKey);
    items.push(...(page[collectionKey] ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);

  return items;
}

function normalizeModelEntry(model) {
  const supportsServerless = isTruthy(model.supportsServerless ?? model.supports_serverless);
  if (!supportsServerless) {
    return null;
  }

  const name = model.name ?? "";
  if (!name.includes("/models/")) {
    return null;
  }

  return {
    id: name,
    shortId: shortIdFromResourceName(name),
    displayName: model.displayName ?? model.display_name ?? shortIdFromResourceName(name),
    kind: KIND_SERVERLESS,
  };
}

function dedupeCatalog(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (entry?.id) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.shortId.localeCompare(b.shortId));
}

export async function fetchServerlessCatalog(apiKey) {
  const models = await fetchAllPages(
    `/v1/accounts/${PLATFORM_ACCOUNT_ID}/models?filter=${encodeURIComponent("supports_serverless=true")}&pageSize=200`,
    apiKey,
    "models",
  );

  const modelEntries = models.map(normalizeModelEntry).filter(Boolean);

  return {
    catalog: dedupeCatalog([...modelEntries, ...BUILTIN_ROUTERS]),
    routersUnavailable: false,
  };
}

export function filterCatalogForKeyType(catalog, keyType) {
  if (keyType !== "firepass") {
    return catalog;
  }
  return catalog.filter((entry) => entry.id === FIREPASS_ROUTER_ID);
}

export function filterCatalogBySearch(catalog, search = "") {
  const query = search.trim().toLowerCase();
  if (!query) {
    return catalog;
  }

  return catalog.filter((entry) => (
    entry.shortId.toLowerCase().includes(query)
    || entry.displayName.toLowerCase().includes(query)
    || entry.id.toLowerCase().includes(query)
  ));
}

export async function loadServerlessCatalog({ apiKey, keyType = "" }) {
  const resolvedKey = apiKey;
  if (!resolvedKey) {
    throw new Error("No Fireworks API key found. Pass --api-key or set FIREWORKS_API_KEY.");
  }

  const resolvedKeyType = keyType || detectApiKeyType(resolvedKey);

  // Fire Pass keys cannot list the account catalog, so return the known
  // Fire Pass router directly without hitting the API.
  if (resolvedKeyType === "firepass") {
    return {
      apiKey: resolvedKey,
      keyType: resolvedKeyType,
      catalog: filterCatalogForKeyType(BUILTIN_ROUTERS, "firepass"),
      routersUnavailable: false,
    };
  }

  const { catalog, routersUnavailable } = await fetchServerlessCatalog(resolvedKey);
  const filteredCatalog = filterCatalogForKeyType(catalog, resolvedKeyType);

  return {
    apiKey: resolvedKey,
    keyType: resolvedKeyType,
    catalog: filteredCatalog,
    routersUnavailable,
  };
}
