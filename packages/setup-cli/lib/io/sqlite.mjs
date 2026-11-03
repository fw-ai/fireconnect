/**
 * Shared pieces of the zero-dependency SQLite access used by the VS Code
 * state DB and the Copilot app DB: node:sqlite when this Node has it, and
 * SQL text literals that are safe for the sqlite3-CLI fallback too.
 */

let NodeSqlite = null;
let nodeSqliteChecked = false;

/** node:sqlite's DatabaseSync, or null when this Node doesn't ship it. */
export async function loadNodeSqlite() {
  if (nodeSqliteChecked) {
    return NodeSqlite;
  }
  nodeSqliteChecked = true;
  try {
    // `node:sqlite` emits an ExperimentalWarning on import. It is filtered by
    // the persistent handler installed in bin/nexus.mjs — suppressing it
    // around this import does not work, because `process.emitWarning` defers
    // to `process.nextTick`, so the warning fires after any local window here
    // would have closed.
    const mod = await import("node:sqlite");
    NodeSqlite = mod.DatabaseSync;
  } catch {
    NodeSqlite = null;
  }
  return NodeSqlite;
}

/**
 * A JS string as a SQL text literal: quoted with single quotes doubled, as
 * always. A value holding a control character (newline, NUL) is written as
 * a hex blob cast to TEXT instead, so nothing in it can end the literal or
 * start a line of its own for the sqlite3 shell to interpret.
 * @param {unknown} s
 */
export function sqlText(s) {
  const text = String(s);
  if (!/[\u0000-\u001f\u007f]/.test(text)) return `'${text.replace(/'/g, "''")}'`;
  return `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
}
