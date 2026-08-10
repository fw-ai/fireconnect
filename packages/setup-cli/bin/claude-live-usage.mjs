#!/usr/bin/env node

import process from "node:process";

import { runLiveUsagePane } from "../lib/harnesses/claude/live-usage-pane.mjs";

runLiveUsagePane(process.argv[2]).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
