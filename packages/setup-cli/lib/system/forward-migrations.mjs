import {
  migrateClaudeAutoModeServerOnUpgrade,
  migrateClaudeExploreInheritCapOnUpgrade,
  migrateClaudeModelPickerOnUpgrade,
  migrateClaudeNativeWebSearchOnUpgrade,
  migrateClaudeToolSearchOnUpgrade,
} from "../harnesses/claude/upgrade-migrations.mjs";
import { migrateCodexWebSearchOnUpgrade } from "../harnesses/codex/upgrade-migrations.mjs";
import { migrateVscodeResponsesApiType } from "../harnesses/vscode/upgrade-migrations.mjs";
import { HARNESS } from "../harness/id.mjs";
import { ensureAutoCatalogEntry } from "../harness/auto-catalog.mjs";

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
/**
 * Auto backfills share one implementation; the upgrade step reports them as
 * one combined note. Each row is [harnessId, label, failure hint].
 */
const AUTO_CATALOG_MIGRATIONS = [
  [HARNESS.OPENCODE, "OpenCode", "re-run fireconnect opencode on"],
  [HARNESS.CODEX, "Codex", "re-run fireconnect codex on"],
  [HARNESS.PI, "Pi", "re-run fireconnect pi on"],
  [HARNESS.CURSOR, "Cursor", "quit Cursor, then re-run fireconnect upgrade"],
  [HARNESS.VSCODE, "VS Code", "quit VS Code, then re-run fireconnect upgrade"],
  [HARNESS.COPILOT_APP, "the Copilot app", "quit it, then re-run fireconnect upgrade"],
  [HARNESS.COPILOT_CLI, "the Copilot CLI", "re-run fireconnect copilot-cli on"],
];

/** "A", "A and B", "A, B and C". */
function joinLabels(labels) {
  if (labels.length <= 2) {
    return labels.join(" and ");
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * One upgrade step for every auto backfill: a single success note naming each
 * migrated harness, plus one failure note per harness that errored (recovery
 * differs, so failures stay separate). Best-effort throughout — a failure
 * never skips the remaining harnesses.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
async function migrateAutoCatalogNotes(home) {
  const added = [];
  const notes = [];
  for (const [harnessId, label, hint] of AUTO_CATALOG_MIGRATIONS) {
    try {
      if (await ensureAutoCatalogEntry(harnessId, home)) {
        added.push(label);
      }
    } catch {
      notes.push(`Couldn't add the auto model to ${label} — ${hint}.`);
    }
  }
  if (added.length > 0) {
    notes.unshift(
      `Added the auto model to ${joinLabels(added)} — restart ${added.length > 1 ? "them" : "it"} to pick it up.`,
    );
  }
  return notes;
}

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
  {
    run: migrateClaudeAutoModeServerOnUpgrade,
    success: "Pinned Claude Code auto mode to its local classifier (CLAUDE_CODE_AUTO_MODE_SERVER=0) until the gateway supports server-side checks — restart Claude Code to pick it up.",
    failure: "Couldn't pin Claude Code auto mode to its local classifier — re-run fireconnect claude on.",
  },
  {
    run: migrateClaudeExploreInheritCapOnUpgrade,
    success: "Let the Explore agent inherit the session model (CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1) so exploration stays on Fireworks rates — restart Claude Code to pick it up.",
    failure: "Couldn't set Explore model inheritance for Claude Code — re-run fireconnect claude on.",
  },
  {
    run: migrateClaudeNativeWebSearchOnUpgrade,
    success: "Enabled native Claude web search and removed the retired Fireworks WebSearch MCP — restart Claude Code.",
    failure: "Couldn't migrate Claude to native web search — re-run fireconnect claude on.",
  },
  {
    run: migrateCodexWebSearchOnUpgrade,
    success: "Enabled Codex web search — restart Codex to pick it up.",
    failure: "Couldn't enable Codex web search — re-run fireconnect codex on.",
  },
  {
    run: migrateClaudeModelPickerOnUpgrade,
    success: "Refreshed Claude Code's /model picker from the live catalog — restart Claude Code to pick it up.",
    failure: "Couldn't refresh Claude Code's /model picker — re-run fireconnect claude on.",
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
  notes.push(...await migrateAutoCatalogNotes(home));
  return notes;
}
