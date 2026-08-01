#!/usr/bin/env node

import process from "node:process";

import {
  cliDependenciesMissingMessage,
  ensureCliDependencies,
} from "../lib/system/ensure-cli-deps.mjs";

async function run() {
  if (!ensureCliDependencies()) {
    process.stderr.write(`${cliDependenciesMissingMessage()}\n`);
    process.exitCode = 1;
    return;
  }

  const { parseCli } = await import("../lib/cli/parse-args.mjs");
  const { runGlobalCommand } = await import("../lib/cli/commands/global.mjs");
  const { runHarnessCommand } = await import("../lib/cli/commands/harness.mjs");
  const { runDemoCommand } = await import("../lib/demo/command.mjs");
  const { checkForUpdates } = await import("../lib/system/update-notify.mjs");

  const parsed = parseCli(process.argv.slice(2));

  if (parsed.kind === "global") {
    await runGlobalCommand(parsed);
    await checkForUpdates(parsed.command, parsed.ctx.home);
    return;
  }

  if (parsed.kind === "harness") {
    await runHarnessCommand(parsed.route, parsed.ctx);
    await checkForUpdates("harness", parsed.ctx.home);
    return;
  }

  if (parsed.kind === "demo") {
    await runDemoCommand(parsed.ctx);
    return;
  }

  throw new Error("Internal error: unknown parse result");
}

run().catch(async (err) => {
  if (ensureCliDependencies()) {
    const { error } = await import("../lib/ui/index.mjs");
    error(err.message);
  } else {
    process.stderr.write(`${err.message}\n`);
  }
  if (process.env.FC_DEBUG) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
