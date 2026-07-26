/**
 * Argument parser for `fireconnect demo`.
 *
 * Lives in the demo folder on purpose: the shared CLI parser (`../parse-args.mjs`)
 * carries no demo-*specific* flag knowledge — its only demo touchpoint is a
 * one-line delegation to `parseDemoArgs`. Keeping the whole grammar here means
 * the demo can be lifted out (or dropped in) without editing the mainline parser.
 *
 * Demo-specific flags (`--prompt`, `--challenger`, …) are handled here; the
 * command-agnostic global flags (`--json`, `--home`, `--api-key`, `--mode`, …)
 * are delegated to `applyGlobalFlag` so that knowledge stays in exactly one place
 * and `fireconnect demo` accepts the same global flags as every other command.
 */

import { applyGlobalFlag } from "../cli/parse-args.mjs";

const DEMO_PROMPT_PRESETS = new Set(["tetris", "tictactoe", "snake", "clock", "custom"]);

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value. Run: fireconnect help`);
  }
  return value;
}

/**
 * @param {string[]} rest  argv with the `demo` command token removed
 * @param {import("../harness/types.mjs").HarnessContext} ctx  a fresh base context
 * @returns {{ kind: "demo", ctx: object }
 *   | { kind: "global", command: "help", ctx: object, helpTopic: string }}
 */
export function parseDemoArgs(rest, ctx) {
  // Demo-specific defaults — the shared base context doesn't declare these.
  ctx.prompt = "";
  ctx.promptFile = "";
  ctx.challenger = "";
  ctx.anthropicModel = "";
  ctx.noOpen = false;
  ctx.out = "";
  ctx.yes = false;
  ctx.clean = false;

  // The single positional: a prompt preset, or the `clean` maintenance
  // subcommand (which removes generated output rather than racing).
  let positional = "";
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];

    if (arg === "--help" || arg === "-h") {
      return { kind: "global", command: "help", ctx, helpTopic: "demo" };
    }

    // `fireconnect demo --version` mirrors every other subcommand: print the
    // CLI version instead of falling through to "Unknown argument: --version".
    if (arg === "--version" || arg === "-V") {
      return { kind: "global", command: "version", ctx };
    }

    // Demo-specific flags.
    if (arg === "--prompt") {
      ctx.prompt = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--prompt-file") {
      ctx.promptFile = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--challenger") {
      ctx.challenger = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--anthropic-model") {
      ctx.anthropicModel = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--out") {
      ctx.out = requireValue(arg, next); i += 1; continue;
    }
    if (arg === "--no-open") {
      ctx.noOpen = true; continue;
    }
    if (arg === "--yes") {
      ctx.yes = true; continue;
    }

    // Command-agnostic global flags (--json, --home, --api-key, --mode, …).
    let consumed;
    try {
      consumed = applyGlobalFlag(ctx, arg, next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        message.includes("Run: fireconnect")
          ? message
          : `${message} Run: fireconnect help`,
      );
    }
    if (consumed === true) {
      i += 1; continue;
    }
    if (consumed === false) {
      continue;
    }

    // Not a flag → the sole positional.
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}. Run: fireconnect help`);
    }
    if (positional) {
      throw new Error(ctx.clean
        ? "fireconnect demo clean takes no preset. Run: fireconnect help"
        : "fireconnect demo takes an optional preset, not subcommands. Run: fireconnect help");
    }
    if (arg === "clean") {
      ctx.clean = true;
    }
    positional = arg;
  }

  if (ctx.clean) {
    return { kind: "demo", ctx };
  }

  // `fireconnect demo [preset]` — the positional preset folds into ctx.prompt,
  // mirroring `--prompt`. An explicit --prompt wins over the positional.
  if (positional) {
    if (!DEMO_PROMPT_PRESETS.has(positional)) {
      throw new Error(
        `Unknown demo preset: ${positional}. Choose one of: `
          + `${[...DEMO_PROMPT_PRESETS].join(", ")}. Run: fireconnect help`,
      );
    }
    if (!ctx.prompt) {
      ctx.prompt = positional;
    }
  }
  return { kind: "demo", ctx };
}
