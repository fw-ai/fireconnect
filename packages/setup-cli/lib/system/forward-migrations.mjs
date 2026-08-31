import { migrateClaudeToolSearchOnUpgrade } from "../harnesses/claude/upgrade-migrations.mjs";
import { migrateVscodeResponsesApiType } from "../harnesses/vscode/upgrade-migrations.mjs";

/**
 * Key-independent harness config migrations for install/upgrade finalize.
 *
 * Kept out of `keys/sync.mjs` so key rebake stays a key path. Each step is
 * best-effort: a failed migration never skips the rest or aborts finalize.
 *
 * @type {Array<{
 *   run: (home: string) => Promise<boolean>,
 *   success: string,
 *   failure: string,
 * }>}
 */
const HARNESS_FORWARD_MIGRATIONS = [
  {
    run: migrateVscodeResponsesApiType,
    success: "Updated VS Code's Fireworks provider to the chat-completions API — restart VS Code to pick it up.",
    failure: "Couldn't migrate VS Code's Fireworks provider — restart VS Code, then re-run fireconnect upgrade.",
  },
  {
    run: migrateClaudeToolSearchOnUpgrade,
    success: "Enabled MCP tool search for Claude Code (ENABLE_TOOL_SEARCH) — restart Claude Code to pick it up.",
    failure: "Couldn't enable MCP tool search for Claude Code — re-run fireconnect claude on.",
  },
];

async function migrationNote({ run, success, failure }, home) {
  try {
    return await run(home) ? success : "";
  } catch {
    return failure;
  }
}

/**
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function runHarnessForwardMigrations(home) {
  if (!home) {
    return [];
  }
  const notes = [];
  for (const migrate of HARNESS_FORWARD_MIGRATIONS) {
    const note = await migrationNote(migrate, home);
    if (note) {
      notes.push(note);
    }
  }
  return notes;
}
