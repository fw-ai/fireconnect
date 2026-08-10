/**
 * Claude Code subagent discovery + labeling for the live usage agent picker.
 * Kept out of usage.mjs so the billing/report module stays under 1k lines.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { sanitize } from "../../../ui/sanitize.mjs";
import { formatUsageCachePct } from "./format.mjs";
import {
  findSubagentLogs,
  usageReportFromText,
} from "./report.mjs";

function cleanLabelPart(value) {
  if (typeof value !== "string") {
    return "";
  }
  // Fold whitespace after stripping CSI/OSC — labels render on a TTY.
  return sanitize(value).replace(/\s+/g, " ").trim();
}

function textFromMessageContent(content) {
  if (typeof content === "string") {
    return cleanLabelPart(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      const text = cleanLabelPart(block);
      if (text) parts.push(text);
      continue;
    }
    if (block && typeof block === "object" && typeof block.text === "string") {
      const text = cleanLabelPart(block.text);
      if (text) parts.push(text);
    }
  }
  return cleanLabelPart(parts.join(" "));
}

/**
 * Display label for a subagent: prefer type/name (+ short description) over id.
 *
 * @param {string} id
 * @param {{ name?: string, description?: string }} [meta]
 */
export function formatSubagentLabel(id, meta = {}) {
  const name = cleanLabelPart(meta.name ?? "");
  const description = cleanLabelPart(meta.description ?? "");
  if (name && description) {
    const desc = description.length > 32 ? `${description.slice(0, 31)}…` : description;
    return `${name} · ${desc}`;
  }
  if (name) return name;
  if (description) {
    return description.length > 40 ? `${description.slice(0, 39)}…` : description;
  }
  const short = String(id ?? "");
  return `sub-agent ${short.length > 12 ? `${short.slice(0, 8)}…` : short}`;
}

/**
 * Read the `agent-<id>.meta.json` sidecar Claude Code writes next to each
 * subagent log.
 *
 * This is the authoritative source: it carries the spawn's `agentType`
 * ("Explore"), its `description` ("Confirm efficiency hotspots in diff"), and
 * for skill-backed agents a `name` ("code-review"). Without it the label falls
 * back to the first user prompt, which is the whole system prompt — labels came
 * out as unreadable prompt fragments.
 *
 * Absent or malformed sidecars are not an error: older logs predate them, and a
 * partially-written file is normal while an agent is still spawning.
 *
 * @param {string} subagentPath absolute `agent-<id>.jsonl` path
 * @returns {Promise<{ name: string, description: string, parentId: string, depth: number }>}
 */
export async function readSubagentMeta(subagentPath) {
  const empty = { name: "", description: "", parentId: "", depth: 0 };
  const metaPath = subagentPath.replace(/\.jsonl$/, ".meta.json");
  let raw;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch {
    return empty;
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!meta || typeof meta !== "object") {
    return empty;
  }
  const depth = Number(meta.spawnDepth);
  return {
    // `name` is the skill/agent name when one exists; `agentType` is the
    // registered type. Either is a better label than a prompt excerpt.
    name: cleanLabelPart(meta.name || meta.agentType),
    description: cleanLabelPart(meta.description),
    parentId: cleanLabelPart(meta.parentAgentId),
    depth: Number.isFinite(depth) && depth > 0 ? depth : 0,
  };
}

/**
 * Name/description hints from a subagent JSONL (attributionAgent, agent-name, first prompt).
 *
 * @param {string} text
 * @returns {{ name: string, description: string }}
 */
export function parseClaudeSubagentMeta(text) {
  let name = "";
  let description = "";
  let firstUserText = "";

  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    const attribution = cleanLabelPart(entry.attributionAgent);
    if (attribution) name = attribution;

    const agentName = cleanLabelPart(entry.agentName || entry.agentType);
    if (agentName && !name) name = agentName;

    if (entry.type === "agent-name" || entry.type === "agent-setting") {
      const titled = cleanLabelPart(
        entry.name || entry.agentName || entry.agentType || entry.title,
      );
      if (titled) name = titled;
    }

    if (!firstUserText && entry.type === "user") {
      const message = entry.message && typeof entry.message === "object" ? entry.message : {};
      const textContent = textFromMessageContent(message.content ?? entry.content);
      if (textContent && !textContent.startsWith("<") && textContent.toLowerCase() !== "warmstart") {
        firstUserText = textContent;
      }
    }
  }

  if (!description && firstUserText) {
    description = firstUserText;
  }
  return { name, description };
}

/**
 * Map subagent id → { name, description } from parent session Agent/Task spawns.
 *
 * @param {string} text parent session JSONL
 * @returns {Map<string, { name: string, description: string }>}
 */
export function parseParentSubagentSpawnMeta(text) {
  /** @type {Map<string, { name: string, description: string }>} */
  const byToolUseId = new Map();
  /** @type {Map<string, { name: string, description: string }>} */
  const byAgentId = new Map();

  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    const message = entry.message && typeof entry.message === "object" ? entry.message : {};
    const content = message.content;

    if (entry.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
        const toolName = block.name;
        if (toolName !== "Agent" && toolName !== "Task") continue;
        const input = block.input && typeof block.input === "object" ? block.input : {};
        const meta = {
          name: cleanLabelPart(input.subagent_type || input.agent_type || input.type),
          description: cleanLabelPart(input.description),
        };
        if (typeof block.id === "string" && block.id) {
          byToolUseId.set(block.id, meta);
        }
        const earlyId = cleanLabelPart(input.agentId || input.agent_id);
        if (earlyId) {
          byAgentId.set(earlyId, meta);
        }
      }
    }

    const tur = entry.toolUseResult && typeof entry.toolUseResult === "object"
      ? entry.toolUseResult
      : null;
    if (tur) {
      const agentId = cleanLabelPart(tur.agentId || tur.agent_id);
      const toolUseId = typeof tur.tool_use_id === "string"
        ? tur.tool_use_id
        : (typeof entry.tool_use_id === "string" ? entry.tool_use_id : "");
      if (agentId) {
        const meta = (toolUseId && byToolUseId.get(toolUseId)) || byAgentId.get(agentId) || {
          name: cleanLabelPart(tur.agentType || tur.subagent_type || tur.name),
          description: cleanLabelPart(tur.description),
        };
        byAgentId.set(agentId, {
          name: meta.name || cleanLabelPart(tur.agentType || tur.subagent_type || tur.name),
          description: meta.description || cleanLabelPart(tur.description),
        });
      }
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
        const agentId = cleanLabelPart(block.agentId || block.agent_id);
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        if (!agentId) continue;
        const meta = (toolUseId && byToolUseId.get(toolUseId)) || byAgentId.get(agentId) || {
          name: "",
          description: "",
        };
        byAgentId.set(agentId, meta);
      }
    }
  }

  return byAgentId;
}

function mergeSubagentMeta(a = {}, b = {}) {
  return {
    name: cleanLabelPart(a.name) || cleanLabelPart(b.name),
    description: cleanLabelPart(a.description) || cleanLabelPart(b.description),
  };
}

/**
 * Main + subagent entries for one parent session log (for live agent picker).
 * Empty subagent logs are still listed so the user can live-track as they spawn.
 *
 * @param {string} sessionPath absolute parent session .jsonl path
 */
export async function listSessionAgents(sessionPath) {
  if (!sessionPath) {
    throw new Error("sessionPath is required");
  }
  const parentText = await readFile(sessionPath, "utf8");
  const main = usageReportFromText(sessionPath, parentText, { includeSessionName: true });
  const spawnMeta = parseParentSubagentSpawnMeta(parentText);
  const agents = [{
    kind: "main",
    id: "main",
    label: "Main",
    filePath: sessionPath,
    report: main,
  }];
  for (const subPath of await findSubagentLogs(sessionPath)) {
    const id = path.basename(subPath, ".jsonl").replace(/^agent-/, "");
    const subText = await readFile(subPath, "utf8");
    const report = usageReportFromText(subPath, subText);
    // Sidecar first: it holds the spawn's real type and description. The parent
    // transcript and the log's own contents are fallbacks for older logs.
    const sidecar = await readSubagentMeta(subPath);
    const meta = mergeSubagentMeta(
      sidecar,
      mergeSubagentMeta(spawnMeta.get(id), parseClaudeSubagentMeta(subText)),
    );
    agents.push({
      kind: "subagent",
      id,
      name: meta.name,
      description: meta.description,
      parentId: sidecar.parentId,
      depth: sidecar.depth,
      label: formatSubagentLabel(id, meta),
      filePath: subPath,
      report,
    });
  }
  return agents;
}

export { formatUsageCachePct };
