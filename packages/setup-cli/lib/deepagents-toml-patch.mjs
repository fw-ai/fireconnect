/**
 * Surgical edits to Deep Agents config.toml — only touches FireConnect-owned keys.
 */

import {
  ensureTrailingNewline,
  findTomlSection,
  isAnyTableHeader,
  parseTomlSections,
  removeTomlSection,
  serializeTomlSections,
  upsertSectionKeyLine,
} from "./toml-section-utils.mjs";

const MODELS_TABLE_HEADER = "[models]";
const FIREWORKS_PROVIDER_TABLE_HEADER = "[models.providers.fireworks]";

const MODELS_DEFAULT_LINE = /^default\s*=.+$/;
const MODELS_KV_LINE = /^([A-Za-z0-9_.-]+)\s*=/;
const DEEPAGENTS_API_KEY_ENV_NAME = "FIREWORKS_API_KEY";

/**
 * @param {string} raw
 * @param {(sections: import("./toml-section-utils.mjs").TomlSection[]) => void} mutate
 */
function mutateDeepagentsToml(raw, mutate) {
  const normalized = raw.trim() ? normalizeDeepagentsToml(raw) : "";
  const sections = normalized ? parseTomlSections(normalized) : [];
  mutate(sections);
  return serializeTomlSections(sections);
}

/**
 * @param {string} raw
 */
export function normalizeDeepagentsToml(raw) {
  return mergeDuplicateModelsSections(raw);
}

/**
 * Last line index (inclusive) consumed by a provider `models` assignment,
 * including multiline arrays and orphaned tail lines from a prior bad patch.
 *
 * @param {string[]} lines
 * @param {number} index
 */
function consumeProviderModelsBlock(lines, index) {
  const trimmed = lines[index].trim();
  if (!/^models\s*=/.test(trimmed)) {
    return index;
  }

  let end = index;
  const openBracket = trimmed.indexOf("[");
  if (openBracket !== -1 && trimmed.indexOf("]", openBracket) === -1) {
    let i = index + 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (next === "]" || next === "],") {
        end = i;
        break;
      }
      i += 1;
    }
  }

  let i = end + 1;
  while (i < lines.length) {
    const next = lines[i].trim();
    if (isAnyTableHeader(next)) {
      break;
    }
    if (next === "]" || next === "]," || /^"[^"]*",?$/.test(next)) {
      end = i;
      i += 1;
      continue;
    }
    break;
  }

  return end;
}

/**
 * @param {import("./toml-section-utils.mjs").TomlSection} section
 * @param {string} modelId
 */
function setProviderModelsInSection(section, modelId) {
  const lines = section.lines;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^models\s*=/.test(lines[i].trim())) {
      continue;
    }
    const end = consumeProviderModelsBlock(lines, i);
    section.lines = [
      ...lines.slice(0, i),
      `models = ["${modelId}"]`,
      ...lines.slice(end + 1),
    ];
    return;
  }
  section.lines.push(`models = ["${modelId}"]`);
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
export function deepagentsProviderModelIdsFromRaw(raw) {
  const provider = findTomlSection(parseTomlSections(normalizeDeepagentsToml(raw)), FIREWORKS_PROVIDER_TABLE_HEADER);
  if (!provider) {
    return [];
  }

  for (let i = 0; i < provider.lines.length; i += 1) {
    if (!/^models\s*=/.test(provider.lines[i].trim())) {
      continue;
    }
    /** @type {string[]} */
    const ids = [];
    const end = consumeProviderModelsBlock(provider.lines, i);
    for (let j = i; j <= end; j += 1) {
      for (const match of provider.lines[j].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
        ids.push(match[1]);
      }
    }
    return ids;
  }

  return [];
}

/**
 * Deep Agents uses stdlib tomllib, which rejects duplicate [models] headers.
 * Merge multiple [models] sections (last key wins) into one table.
 *
 * @param {string} raw
 */
export function mergeDuplicateModelsSections(raw) {
  if (!raw.trim()) {
    return raw;
  }

  const sections = parseTomlSections(raw);
  const modelsSections = sections.filter((section) => section.header === MODELS_TABLE_HEADER);
  if (modelsSections.length <= 1) {
    return ensureTrailingNewline(raw);
  }

  /** @type {Map<string, string>} */
  const mergedKeys = new Map();
  for (const section of modelsSections) {
    for (const line of section.lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(MODELS_KV_LINE);
      if (match) {
        mergedKeys.set(match[1], line);
      }
    }
  }

  const out = [];
  let mergedModelsEmitted = false;
  for (const section of sections) {
    if (section.header === MODELS_TABLE_HEADER) {
      if (!mergedModelsEmitted) {
        out.push({
          header: MODELS_TABLE_HEADER,
          lines: [
            ...mergedKeys.values(),
            ...(mergedKeys.size > 0 ? [""] : []),
          ],
        });
        mergedModelsEmitted = true;
      }
      continue;
    }
    out.push(section);
  }

  return serializeTomlSections(out);
}

/**
 * @param {string} raw
 * @param {string} modelSpec
 */
export function upsertModelsDefaultRaw(raw, modelSpec) {
  return mutateDeepagentsToml(raw, (sections) => {
    let models = findTomlSection(sections, MODELS_TABLE_HEADER);
    if (!models) {
      sections.push({
        header: MODELS_TABLE_HEADER,
        lines: [`default = "${modelSpec}"`, ""],
      });
      return;
    }
    upsertSectionKeyLine(models, "default", `default = "${modelSpec}"`);
  });
}

/**
 * @param {string} raw
 * @param {{ stripModelsDefault?: boolean }} [options]
 */
export function stripFireconnectRoutingRaw(raw, { stripModelsDefault = false } = {}) {
  return mutateDeepagentsToml(raw, (sections) => {
    removeTomlSection(sections, FIREWORKS_PROVIDER_TABLE_HEADER);
    if (stripModelsDefault) {
      const models = findTomlSection(sections, MODELS_TABLE_HEADER);
      if (models) {
        models.lines = models.lines.filter((line) => !MODELS_DEFAULT_LINE.test(line.trim()));
      }
    }
  });
}

/**
 * @param {string} raw
 * @param {{
 *   modelSpec: string,
 *   modelId: string,
 *   baseUrl: string,
 *   authMode: import("./deepagents-auth.mjs").DeepagentsAuthMode,
 * }} patch
 */
export function patchFireconnectRoutingRaw(raw, patch) {
  const stripped = stripFireconnectRoutingRaw(raw, { stripModelsDefault: true });
  const withDefault = upsertModelsDefaultRaw(stripped, patch.modelSpec);

  const providerLines = [
    `base_url = "${patch.baseUrl}"`,
    "enabled = true",
    `models = ["${patch.modelId}"]`,
  ];
  if (patch.authMode === "env-reference") {
    providerLines.push(`api_key_env = "${DEEPAGENTS_API_KEY_ENV_NAME}"`);
  }

  const prefix = withDefault.trimEnd();
  return ensureTrailingNewline(`${prefix}\n${[
    FIREWORKS_PROVIDER_TABLE_HEADER,
    ...providerLines,
    "",
  ].join("\n")}`);
}

/**
 * @param {string} raw
 * @param {string} modelSpec
 */
export function patchDeepagentsModelRaw(raw, modelSpec) {
  return upsertModelsDefaultRaw(raw, modelSpec);
}

/**
 * @param {string} raw
 * @param {string} modelId
 * @param {import("./deepagents-auth.mjs").DeepagentsAuthMode} [authMode="literal"]
 */
export function patchDeepagentsProviderModelsRaw(raw, modelId, authMode = "literal") {
  const normalized = normalizeDeepagentsToml(raw);
  const sections = parseTomlSections(normalized);
  const provider = findTomlSection(sections, FIREWORKS_PROVIDER_TABLE_HEADER);
  if (!provider) {
    return patchFireconnectRoutingRaw(normalized, {
      modelSpec: `fireworks:${modelId}`,
      modelId,
      baseUrl: "https://api.fireworks.ai/inference",
      authMode,
    });
  }

  setProviderModelsInSection(provider, modelId);
  return serializeTomlSections(sections);
}
