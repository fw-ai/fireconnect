#!/usr/bin/env node

import { parseCli } from "../lib/parse-args.mjs";
import { runGlobalCommand } from "../lib/commands/global.mjs";
import { runHarnessCommand } from "../lib/commands/harness.mjs";
import { runDemoCommand } from "../lib/demo/command.mjs";
import { checkForUpdates } from "../lib/update-notify.mjs";

async function run() {
  const parsed = parseCli(process.argv.slice(2));

  if (parsed.kind === "global") {
    await runGlobalCommand(parsed);
    checkForUpdates(parsed.command, parsed.ctx.home);
    return;
  }

  if (parsed.kind === "harness") {
    await runHarnessCommand(parsed.route, parsed.ctx);
    checkForUpdates("harness", parsed.ctx.home);
    return;
  }

  if (parsed.kind === "demo") {
    await runDemoCommand(parsed.ctx);
    return;
  }

  throw new Error("Internal error: unknown parse result");
}

run().catch((error) => {
  console.error(`Error: ${error.message}`);
  if (process.env.FC_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
