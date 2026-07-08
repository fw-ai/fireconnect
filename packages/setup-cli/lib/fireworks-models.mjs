import { detectApiKeyType, MISSING_FIREWORKS_API_KEY_MESSAGE } from "./fireconnect-core.mjs";
import {
  FIREWORKS_API_KEY_ENV_REF,
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "./global-config.mjs";
import {
  persistApiKeyFromFlag,
  resolveFireworksApiKeyValue,
  tryReadKeychainSecret,
} from "./api-key.mjs";
import { OPENCODE_API_KEY_ENV_REF } from "./opencode-core.mjs";

export const FIREWORKS_GATEWAY_URL = "https://api.fireworks.ai";
export const PLATFORM_ACCOUNT_ID = "fireworks";
export const KIND_SERVERLESS = "serverless";
export const FIREPASS_ROUTER_ID = "accounts/fireworks/routers/glm-fast-latest";
export const FIREPASS_ROUTER_IDS = new Set([
  FIREPASS_ROUTER_ID,
  "accounts/fireworks/routers/glm-latest",
  "accounts/fireworks/routers/glm-5p2-fast",
  "accounts/fireworks/routers/kimi-fast-latest",
  "accounts/fireworks/routers/kimi-k2p7-code-fast",
]);

export const BUILTIN_ROUTERS = [
  {
    id: "accounts/fireworks/routers/glm-latest",
    shortId: "glm-latest",
    displayName: "GLM Latest via Fireworks",
    baseModelId: "accounts/fireworks/models/glm-5p2",
    kind: KIND_SERVERLESS,
  },
  {
    id: "accounts/fireworks/routers/glm-fast-latest",
    shortId: "glm-fast-latest",
    displayName: "GLM Fast Latest via Fireworks",
    baseModelId: "accounts/fireworks/models/glm-5p2",
    kind: KIND_SERVERLESS,
  },
  {
    id: "accounts/fireworks/routers/glm-5p2-fast",
    shortId: "glm-5p2-fast",
    displayName: "GLM 5.2 Fast via Fireworks",
    baseModelId: "accounts/fireworks/models/glm-5p2",
    kind: KIND_SERVERLESS,
  },
  {
    id: "accounts/fireworks/routers/kimi-fast-latest",
    shortId: "kimi-fast-latest",
    displayName: "Kimi Fast Latest via Fireworks",
    baseModelId: "accounts/fireworks/models/kimi-k2p6",
    kind: KIND_SERVERLESS,
  },
  {
    id: "accounts/fireworks/routers/kimi-k2p6-turbo",
    shortId: "kimi-k2p6-turbo",
    displayName: "Kimi K2.6 Turbo via Fireworks",
    baseModelId: "accounts/fireworks/models/kimi-k2p6",
    kind: KIND_SERVERLESS,
  },
  {
    id: "accounts/fireworks/routers/kimi-k2p7-code-fast",
    shortId: "kimi-k2p7-code-fast",
    displayName: "Kimi K2.7 Code Fast via Fireworks",
    baseModelId: "accounts/fireworks/models/kimi-k2p7-code",
    kind: KIND_SERVERLESS,
  },
  {
    id: "accounts/fireworks/routers/kimi-latest",
    shortId: "kimi-latest",
    displayName: "Kimi Latest via Fireworks",
    baseModelId: "accounts/fireworks/models/kimi-k2p6",
    kind: KIND_SERVERLESS,
  },
];

/** @typedef {{ id: string, shortId: string, displayName: string, baseModelId?: string, kind: "serverless" }} CatalogEntry */

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
 * Turn a model id into a human-readable name for display, without any network
 * call. e.g. `accounts/fireworks/models/glm-5p2` -> "GLM 5.2",
 * `accounts/fireworks/routers/glm-latest` -> "GLM Latest",
 * `kimi-k2p7-code-fast` -> "Kimi K2.7 Code Fast", `composer-2.5` -> "Composer 2.5".
 * Falls back to the last path segment if prettification yields nothing better.
 * @param {string} modelId
 * @returns {string}
 */
export function prettyModelName(modelId) {
  if (!modelId) {
    return "(unset)";
  }
  if (modelId === "default") {
    return "default";
  }
  const last = String(modelId).split("/").at(-1) ?? modelId;
  const tokens = last.split(/[-_]/).filter(Boolean);
  const pretty = tokens.map((tok) => {
    if (/^[a-z]+$/i.test(tok)) {
      // short all-letter tokens are acronyms (GLM); longer ones are names (Kimi, Qwen, Deepseek)
      return tok.length <= 3 ? tok.toUpperCase() : tok.charAt(0).toUpperCase() + tok.slice(1);
    }
    let m = tok.match(/^([a-zA-Z])(\d+)p(\d+)$/); // k2p6 -> K2.6
    if (m) {
      return `${m[1].toUpperCase()}${m[2]}.${m[3]}`;
    }
    m = tok.match(/^(\d+)p(\d+)$/); // 5p2 -> 5.2
    if (m) {
      return `${m[1]}.${m[2]}`;
    }
    m = tok.match(/^v(\d+)$/i); // v4 -> V4
    if (m) {
      return `V${m[1]}`;
    }
    // mixed alphanumeric like "2.5" or "k25" — capitalise a leading letter
    return tok.charAt(0).toUpperCase() + tok.slice(1);
  });
  return pretty.join(" ");
}

export { MISSING_FIREWORKS_API_KEY_MESSAGE } from "./fireconnect-core.mjs";

/**
 * Resolve credentials for `<harness> on`: persist flags to keychain, always return env ref for config.
 *
 * @param {{
 *   apiKey?: string,
 *   home?: string,
 *   harnessEnvRef: string,
 *   getExistingHarnessKey?: () => Promise<string>,
 * }} args
 */
export async function resolveHarnessOnApiKey({
  apiKey = "",
  home = process.env.HOME ?? "",
  harnessEnvRef,
  getExistingHarnessKey,
}) {
  if (apiKey?.trim() && home) {
    await persistApiKeyFromFlag(home, apiKey.trim());
  }

  let effectiveKey = await resolveFireworksApiKeyValue({ apiKey, home });
  let source = "env";

  if (!effectiveKey && getExistingHarnessKey) {
    const storedKey = await getExistingHarnessKey();
    const harnessKey = effectiveHarnessStoredKey(storedKey, harnessEnvRef);
    if (harnessKey) {
      effectiveKey = harnessKey;
      source = "harness-local-literal";
      if (home) {
        await persistApiKeyFromFlag(home, harnessKey);
      }
    }
  }

  // Last-resort fallback: the key may still be in the keychain even if
  // config.json lost the {keychain:fireworks-api-key} ref (deleted/corrupted/manually
  // edited) and no harness-local literal is available. Don't lose access to a
  // stored key — uses the same keychain-read helper as `exportFireworksApiKey`.
  // Skipped in env mode (config.apiKey === {env:…}): there the user manages
  // FIREWORKS_API_KEY themselves, so recovering from the keychain would write
  // {env:…} to the harness config while leaving the shell hook uninstalled —
  // the harness would be enabled but unable to authenticate at runtime.
  if (!effectiveKey && home) {
    const config = await readGlobalConfig(home);
    if (config.apiKey !== FIREWORKS_API_KEY_ENV_REF) {
      const fromKeychain = await tryReadKeychainSecret(home);
      if (fromKeychain) {
        effectiveKey = fromKeychain;
        source = "keychain-fallback";
        // Repair the config ref so the shell env hook installs for
        // Codex/OpenCode/Pi (its gate is isKeychainConfigRef(config.apiKey)) and
        // future resolves find the key directly instead of re-running this fallback.
        await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
      }
    }
  }

  if (!effectiveKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }

  if (getExistingHarnessKey) {
    const existingKey = await getExistingHarnessKey();
    if (existingKey && existingKey === harnessEnvRef) {
      return {
        apiKey: harnessEnvRef,
        apiKeyFromFlag: false,
        reusedExistingKey: true,
        // Preserve where the key actually came from (e.g. "keychain-fallback")
        // rather than overwriting it — the harness config having the env ref
        // only means we're reusing the ref, not that the key came from there.
        source,
        effectiveKey,
      };
    }
  }

  if (apiKey?.trim()) {
    source = "flag";
  } else if (source !== "harness-local-literal" && home) {
    const storedKey = (await readGlobalConfig(home)).apiKey;
    if (storedKey === FIREWORKS_API_KEY_KEYCHAIN_REF) {
      source = "global-keychain";
    } else if (storedKey === FIREWORKS_API_KEY_ENV_REF) {
      source = "global-env-ref";
    } else if (storedKey) {
      source = "global-legacy-literal";
    }
  }

  return {
    apiKey: harnessEnvRef,
    apiKeyFromFlag: false,
    reusedExistingKey: false,
    source,
    effectiveKey,
  };
}

/**
 * Resolve a harness-stored credential ref to a usable API key value.
 * @param {string} stored
 * @param {string} harnessEnvRef
 */
function effectiveHarnessStoredKey(stored, harnessEnvRef) {
  if (!stored?.trim()) {
    return "";
  }
  const trimmed = stored.trim();
  if (trimmed === harnessEnvRef || trimmed.startsWith("{env:")) {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
  }
  if (trimmed === "${FIREWORKS_API_KEY}") {
    return process.env.FIREWORKS_API_KEY?.trim() ?? "";
  }
  return isFireworksKey(trimmed) ? trimmed : "";
}

/**
 * Resolve a Fireworks API key in the documented order.
 *
 * @param {{ apiKey?: string, resolveKey?: () => Promise<string>, home?: string }} args
 */
export async function resolveFireworksApiKey({
  apiKey = "",
  resolveKey,
  home = process.env.HOME ?? "",
}) {
  const fromStored = await resolveFireworksApiKeyValue({ apiKey, home });
  if (fromStored) {
    return fromStored;
  }

  if (resolveKey) {
    const harnessKey = await resolveKey();
    if (harnessKey && harnessKey !== OPENCODE_API_KEY_ENV_REF) {
      const trimmed = harnessKey.trim();
      if (isFireworksKey(trimmed)) {
        return trimmed;
      }
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
  const models = await fetchServerlessCatalogRaw(apiKey);
  return {
    catalog: buildPickerCatalogFromApiModels(models),
    routersUnavailable: false,
  };
}

export function buildPickerCatalogFromApiModels(apiModels) {
  const modelEntries = apiModels.map(normalizeModelEntry).filter(Boolean);
  return dedupeCatalog([...modelEntries, ...BUILTIN_ROUTERS]);
}

export async function fetchServerlessCatalogRaw(apiKey) {
  return fetchAllPages(
    `/v1/accounts/${PLATFORM_ACCOUNT_ID}/models?filter=${encodeURIComponent("supports_serverless=true")}&pageSize=200`,
    apiKey,
    "models",
  );
}

export function filterCatalogForKeyType(catalog, keyType) {
  if (keyType !== "firepass") {
    return catalog;
  }
  return catalog.filter((entry) => FIREPASS_ROUTER_IDS.has(entry.id));
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
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
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
