import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SQLITE_URL = new URL("../../../lib/harnesses/copilot-app/sqlite.mjs", import.meta.url).href;
const HAS_SQLITE3 = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;

// Quote and newline + a leading-dot line: neither may end the literal or
// reach the sqlite3 shell as a line of its own. (No NUL: SQLite builds may
// cut TEXT at an embedded NUL on read-back, so it can't round-trip.)
const nastyId = (marker) => `accounts/fireworks/models/x'\n.output ${marker}\nb;\ttail`;

const WRITE = `
const m = await import(${JSON.stringify(SQLITE_URL)});
await m.upsertFireconnectProvider(process.argv[1], {
  providerId: "fc-test", apiKey: "fw_TEST_NOT_A_REAL_KEY",
  models: [{ id: (${nastyId.toString()})(process.argv[2]), displayName: "it's" }],
});
`;
const READ = `
const m = await import(${JSON.stringify(SQLITE_URL)});
process.stdout.write(JSON.stringify(await m.listCopilotProviderModels(process.argv[1], "fc-test")));
`;

function node(flags, script, args) {
  const r = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", script, ...args], {
    encoding: "utf8", cwd: fileURLToPath(new URL("../../../", import.meta.url)),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function roundTrip(writeFlags) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fc-copilot-sql-"));
  try {
    const db = path.join(dir, "data.db");
    const marker = path.join(dir, "marker");
    const id = nastyId(marker);
    node(writeFlags, WRITE, [db, marker]);
    // Read back through node:sqlite, which returns values intact.
    const rows = JSON.parse(node([], READ, [db]));
    return { id, rows, markerCreated: existsSync(marker) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("copilot-app SQL literals", () => {
  it("round-trip quotes and newlines through node:sqlite", () => {
    const { id, rows } = roundTrip([]);
    assert.deepEqual(rows.map((r) => [r.model_id, r.display_name]), [[id, "it's"]]);
  });

  it("stay literals through the sqlite3 CLI fallback", { skip: !HAS_SQLITE3 }, () => {
    const { id, rows, markerCreated } = roundTrip(["--no-experimental-sqlite"]);
    assert.equal(markerCreated, false);
    assert.deepEqual(rows.map((r) => [r.model_id, r.display_name]), [[id, "it's"]]);
  });
});
