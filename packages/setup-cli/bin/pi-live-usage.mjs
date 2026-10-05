#!/usr/bin/env node

import process from "node:process";

import { runPiLiveUsagePane } from "../lib/harnesses/pi/live-usage-pane.mjs";

runPiLiveUsagePane(process.argv[2]).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
