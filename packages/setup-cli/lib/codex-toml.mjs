/**
 * Minimal TOML parse for Codex config.toml (flat tables only).
 * Writes use codex-toml-patch.mjs; this covers the subset FireConnect reads.
 */

function parseTomlValue(raw) {
  const value = raw.trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if ((value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

/**
 * @param {string} text
 * @returns {{ root: Record<string, unknown>, tables: Record<string, Record<string, unknown>> }}
 */
export function parseToml(text) {
  /** @type {Record<string, unknown>} */
  const root = {};
  /** @type {Record<string, Record<string, unknown>>} */
  const tables = {};
  let currentTable = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const tableMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      currentTable = tableMatch[1];
      if (!tables[currentTable]) {
        tables[currentTable] = {};
      }
      continue;
    }

    const kvMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) {
      continue;
    }

    const key = kvMatch[1];
    const value = parseTomlValue(kvMatch[2]);
    if (currentTable) {
      tables[currentTable][key] = value;
    } else {
      root[key] = value;
    }
  }

  return { root, tables };
}
