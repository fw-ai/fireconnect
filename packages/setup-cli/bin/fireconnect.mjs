#!/usr/bin/env node

import { parseCli } from "../lib/parse-args.mjs";
import { runGlobalCommand } from "../lib/commands/global.mjs";
import { runHarnessCommand } from "../lib/commands/harness.mjs";

async function run() {
  const parsed = parseCli(process.argv.slice(2));

  if (parsed.kind === "global") {
    await runGlobalCommand(parsed);
    return;
  }

  if (parsed.kind === "harness") {
    await runHarnessCommand(parsed.route, parsed.ctx);
    return;
  }

  throw new Error("Internal error: unknown parse result");
}

run().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
