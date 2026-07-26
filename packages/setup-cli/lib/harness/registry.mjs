import claude from "../harnesses/claude/index.mjs";
import codex from "../harnesses/codex/index.mjs";
import cursor from "../harnesses/cursor/index.mjs";
import deepagents from "../harnesses/deepagents/index.mjs";
import opencode from "../harnesses/opencode/index.mjs";
import pi from "../harnesses/pi/index.mjs";
import vscode from "../harnesses/vscode/index.mjs";
import { HARNESSES } from "./id.mjs";

/** @typedef {import("./types.mjs").HarnessAdapter} HarnessAdapter */

const REGISTRY = new Map(
  [claude, opencode, codex, pi, cursor, vscode, deepagents].map((adapter) => [adapter.id, adapter]),
);

/**
 * @param {string} id
 * @returns {HarnessAdapter}
 */
export function getHarness(id) {
  const adapter = REGISTRY.get(id);
  if (!adapter) {
    throw new Error(`Unknown harness: ${id}. Choose one of: ${HARNESSES.join(", ")}`);
  }
  return adapter;
}

/**
 * @returns {HarnessAdapter[]}
 */
export function listHarnesses() {
  return [...REGISTRY.values()];
}
