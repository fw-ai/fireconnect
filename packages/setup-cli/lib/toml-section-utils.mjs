/**
 * Section-oriented TOML helpers for harness config patchers (flat tables only).
 */

/** @typedef {{ header: string | null, lines: string[] }} TomlSection */

export function isAnyTableHeader(trimmed) {
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

export function ensureTrailingNewline(text) {
  if (!text) {
    return "";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * @param {string} raw
 * @returns {TomlSection[]}
 */
export function parseTomlSections(raw) {
  /** @type {TomlSection[]} */
  const sections = [];
  /** @type {TomlSection | null} */
  let current = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (isAnyTableHeader(trimmed)) {
      current = { header: trimmed, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else {
      sections.push({ header: null, lines: [line] });
    }
  }

  return sections;
}

/**
 * @param {TomlSection[]} sections
 */
export function serializeTomlSections(sections) {
  const out = [];
  for (const section of sections) {
    if (section.header) {
      out.push(section.header);
    }
    out.push(...section.lines);
  }
  return ensureTrailingNewline(out.join("\n"));
}

/**
 * @param {TomlSection[]} sections
 * @param {string} header
 */
export function findTomlSection(sections, header) {
  return sections.find((section) => section.header === header);
}

/**
 * @param {TomlSection} section
 * @param {string} key
 * @param {string} line
 */
export function upsertSectionKeyLine(section, key, line) {
  const pattern = new RegExp(`^${key}\\s*=`);
  section.lines = section.lines.filter((entry) => !pattern.test(entry.trim()));
  section.lines.push(line);
}

/**
 * @param {TomlSection[]} sections
 * @param {string} header
 */
export function removeTomlSection(sections, header) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i].header === header) {
      sections.splice(i, 1);
    }
  }
}
