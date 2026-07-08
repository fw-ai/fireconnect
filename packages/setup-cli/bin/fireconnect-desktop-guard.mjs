#!/usr/bin/env node
// Installed as a Claude Code SessionStart hook by `fireconnect claude on`.
// Detects the Claude Desktop half-applied-env failure (see
// lib/claude-desktop-guard.mjs) and surfaces a warning via additionalContext.
import { buildHookOutput } from "../lib/claude-desktop-guard.mjs";

const output = buildHookOutput(process.env);
if (output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
