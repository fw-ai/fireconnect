import { parse } from "smol-toml";

function isRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && !(value instanceof Date);
}

function collectTables(value, path, tables) {
  if (!isRecord(value)) {
    return;
  }
  const table = {};
  for (const [key, entry] of Object.entries(value)) {
    table[key] = entry;
    if (isRecord(entry)) {
      collectTables(entry, [...path, key], tables);
    }
  }
  if (path.length > 0) {
    tables[path.join(".")] = table;
  }
}

/**
 * Parse TOML with the complete TOML grammar, then expose the flat `{root,
 * tables}` view expected by existing harness adapters.
 */
export function parseToml(text) {
  if (!text.trim()) {
    return { root: {}, tables: {} };
  }
  const parsed = parse(text);
  const root = {};
  const tables = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isRecord(value)) {
      collectTables(value, [key], tables);
    } else {
      root[key] = value;
    }
  }
  return { root, tables };
}
