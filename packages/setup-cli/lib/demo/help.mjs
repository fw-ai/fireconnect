/**
 * Help text for `fireconnect demo`.
 *
 * Kept in the demo folder so the shared help builder (`../commands/global.mjs`)
 * holds no demo help content of its own — it just imports this string. The
 * general `fireconnect help` output still lists `demo` via a couple of one-line
 * navigational mentions there; the full usage block lives here.
 *
 * @param {string} cliName  the CLI's display name (e.g. "fireconnect")
 * @returns {string}
 */
export function demoHelpText(cliName) {
  return `Usage:
  ${cliName} demo [prompt] [options]
  ${cliName} demo clean [--out <dir>] [--yes]

Race Claude Code (your tool, on Anthropic) against a Fireworks model on the same
code-generation prompt. Stream both live in a split-pane terminal UI, then open a
browser page where both generated apps run side by side.

  Each side runs the real \`claude -p\` tool in its own isolated throwaway config
  dir — your ~/.claude/settings.json is never touched. The incumbent (Anthropic)
  side needs an Anthropic API key; the challenger uses your Fireworks key. Only
  Claude Code is supported today (opencode/codex/etc. planned).

Prompts: tetris (default), tictactoe, snake, clock, custom.

Options:
  --prompt <preset|task>    One of: tetris, tictactoe, snake, clock, or a
                            custom standalone HTML task.
  --prompt-file <path>      Use a custom task from a file (overrides preset).
  --challenger <model>      Fireworks model to race (default: glm-5p2-fast).
  --anthropic-model <alias> Anthropic model for your side — one of:
                            opus (default), sonnet, haiku. Also settable in the form.
  --anthropic-key <key>     Anthropic API key for your side
                            (defaults to ANTHROPIC_API_KEY / config / a TTY prompt).
  --api-key <key>           Fireworks API key (defaults to FIREWORKS_API_KEY / config).
  --no-open                 Skip the browser handoff; leave outputs on disk.
  --out <dir>               Output directory (default: ./fireconnect-demo/).
  --yes                     Non-interactive: skip the setup form.
  --json                    Emit a machine-readable result to stdout (skips TUI/browser).

Maintenance:
  ${cliName} demo clean     Remove generated output (default ./fireconnect-demo/) and
                            any leftover tmp dirs from crashed runs. Prompts unless
                            --yes; only deletes directories that hold demo output.`;
}
