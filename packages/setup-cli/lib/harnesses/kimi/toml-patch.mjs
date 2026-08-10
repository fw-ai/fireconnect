import {
  findTomlSection,
  isAnyTableHeader,
  parseTomlSections,
  removeTomlSection,
  serializeTomlSections,
} from "../../io/toml-section-utils.mjs";

const FIREWORKS_PROVIDER_TABLE_HEADER = "[providers.fireworks]";
const FIREWORKS_AZURE_PROVIDER_TABLE_HEADER = "[providers.fireworks-azure]";
const MANAGED_MODEL_HEADER_PREFIXES = ['[models."fireworks/', '[models."fireworks-azure/'];
const ANY_DEFAULT_MODEL_LINE = /^default_model\s*=/;
const MANAGED_DEFAULT_MODEL_LINE = /^default_model\s*=\s*"fireworks(?:-azure)?\//;

function mutateKimiToml(raw, mutate) {
  const sections = raw.trim() ? parseTomlSections(raw) : [];
  mutate(sections);
  return serializeTomlSections(sections);
}

function removeManagedModelSections(sections) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const header = sections[i].header ?? "";
    if (MANAGED_MODEL_HEADER_PREFIXES.some((prefix) => header.startsWith(prefix))) {
      sections.splice(i, 1);
    }
  }
}

function scanRootLine(line, state) {
  for (let i = 0; i < line.length; ) {
    if (state.stringDelim) {
      const close = line.indexOf(state.stringDelim, i);
      if (close === -1) {
        return;
      }
      i = close + state.stringDelim.length;
      state.stringDelim = "";
      continue;
    }
    const ch = line[i];
    if (ch === "#") {
      return;
    }
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (line.startsWith(triple, i)) {
        const close = line.indexOf(triple, i + 3);
        if (close === -1) {
          state.stringDelim = triple;
          return;
        }
        i = close + 3;
        continue;
      }
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        j += ch === '"' && line[j] === "\\" ? 2 : 1;
      }
      if (j >= line.length) {
        return;
      }
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      state.arrayDepth += 1;
    } else if (ch === "]" && state.arrayDepth > 0) {
      state.arrayDepth -= 1;
    }
    i += 1;
  }
}

function stripRootDefaultModelLines(raw, pattern) {
  const out = [];
  const state = { stringDelim: "", arrayDepth: 0 };
  let atRoot = true;
  let removingValue = false;
  for (const line of raw.split("\n")) {
    if (removingValue) {
      scanRootLine(line, state);
      removingValue = Boolean(state.stringDelim) || state.arrayDepth > 0;
      continue;
    }
    if (atRoot && !state.stringDelim && state.arrayDepth === 0) {
      const trimmed = line.trim();
      if (isAnyTableHeader(trimmed)) {
        atRoot = false;
      } else if (pattern.test(trimmed)) {
        scanRootLine(line, state);
        removingValue = Boolean(state.stringDelim) || state.arrayDepth > 0;
        continue;
      }
    }
    if (atRoot) {
      scanRootLine(line, state);
    }
    out.push(line);
  }
  return out.join("\n");
}

function stripRoutingSections(sections) {
  removeTomlSection(sections, FIREWORKS_PROVIDER_TABLE_HEADER);
  removeTomlSection(sections, FIREWORKS_AZURE_PROVIDER_TABLE_HEADER);
  removeManagedModelSections(sections);
}

export function stripFireconnectRoutingRaw(raw) {
  return mutateKimiToml(
    stripRootDefaultModelLines(raw, MANAGED_DEFAULT_MODEL_LINE),
    stripRoutingSections,
  );
}

export function upsertProviderApiKeyRaw(raw, apiKey) {
  return mutateKimiToml(raw, (sections) => {
    const provider = findTomlSection(sections, FIREWORKS_PROVIDER_TABLE_HEADER);
    if (!provider) {
      return;
    }
    const line = `api_key = "${apiKey}"`;
    const index = provider.lines.findIndex((entry) => /^api_key\s*=/.test(entry.trim()));
    if (index === -1) {
      provider.lines.push(line);
    } else {
      provider.lines[index] = line;
    }
  });
}

function patchRoutingRaw(raw, providerId, tableHeader, patch) {
  const base = mutateKimiToml(
    stripRootDefaultModelLines(raw, ANY_DEFAULT_MODEL_LINE),
    stripRoutingSections,
  ).replace(/^\n+/, "");
  const rootLine = `default_model = "${patch.alias}"`;
  const tablesBlock = [
    tableHeader,
    'type = "openai"',
    `base_url = "${patch.baseUrl}"`,
    `api_key = "${patch.apiKey}"`,
    "",
    `[models."${patch.alias}"]`,
    `provider = "${providerId}"`,
    `model = "${patch.modelId}"`,
    `max_context_size = ${patch.maxContextSize}`,
    `capabilities = [${patch.capabilities.map((cap) => `"${cap}"`).join(", ")}]`,
  ].join("\n");

  if (!base.trim()) {
    return `${rootLine}\n\n${tablesBlock}\n`;
  }
  const separator = base.endsWith("\n") ? "" : "\n";
  return `${rootLine}\n\n${base}${separator}\n${tablesBlock}\n`;
}

export function patchFireconnectRoutingRaw(raw, patch) {
  return patchRoutingRaw(raw, "fireworks", FIREWORKS_PROVIDER_TABLE_HEADER, patch);
}

export function patchFireconnectAzureRoutingRaw(raw, patch) {
  return patchRoutingRaw(raw, "fireworks-azure", FIREWORKS_AZURE_PROVIDER_TABLE_HEADER, patch);
}
