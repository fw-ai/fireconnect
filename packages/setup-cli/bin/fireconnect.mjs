#!/usr/bin/env node

import process from "node:process";

import {
  cliDependenciesMissingMessage,
  ensureCliDependencies,
} from "../lib/system/ensure-cli-deps.mjs";

/*
 * `node:sqlite` (used for Cursor/VS Code `state.vscdb`) emits an
 * ExperimentalWarning on import under Node >= 22. The installed launcher passes
 * `--disable-warning=ExperimentalWarning`, but running this file directly
 * (`node bin/fireconnect.mjs`, e.g. a dev alias) does not — and the warning
 * lands in the middle of interactive output like the uninstall checklist.
 *
 * Two details make this the shape it is:
 *  - It must be a persistent listener, not a window around the import.
 *    `process.emitWarning` defers to `process.nextTick`, so a local
 *    suppress-then-restore always restores before the warning fires.
 *  - Node's default printer is itself a 'warning' listener, and adding one
 *    does not replace it. So drop the existing listeners and become the only
 *    one, then re-print everything we don't filter in Node's default format.
 */
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /\bSQLite\b/i.test(warning.message)) {
    return;
  }
  process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
});

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
    if (parsed.deprecated) {
      const { warn } = await import("../lib/ui/index.mjs");
      warn("`fireconnect demo` is deprecated. Use `fireconnect claude demo` instead.");
      console.log("Run `fireconnect claude demo` to race two models — see `fireconnect claude demo --help` for options.");
      return;
    }
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
