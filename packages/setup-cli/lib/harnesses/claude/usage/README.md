# `fireconnect claude usage`

Everything that reads Claude Code's session logs and turns them into cost.

## Entry points

The harness (`../index.mjs`) uses two, depending on the flags:

| Command | Path |
| --- | --- |
| `claude usage` on a TTY | `session-picker.mjs` → `live.mjs` → `meter.mjs` |
| `--json` / `--last-n` / `--plain` / non-TTY | `report.mjs` → `display.mjs` |

## Modules

**Shared**

- `report.mjs` — parses session JSONL and prices it. `computeClaudeUsageCost`
  lives here and is the only place cost is computed, so the live meter and the
  one-shot snapshot cannot disagree.
- `format.mjs` — cost and cache-percentage strings shared by the meter and both
  pickers.
- `agents.mjs` — discovers subagent logs and labels them from the `.meta.json`
  sidecar Claude Code writes next to each one.

**Snapshot**

- `display.mjs` — the table `--plain` and `--json`-less snapshots print.

**Live meter**, in dependency order — each layer may import from the ones above
it in this list, never below:

- `meter-style.mjs` — SGR colour codes, box glyphs, printable-width measurement.
  Colour is decided per run, so these are module-level `let`s that
  `applyMeterStyle` sets once; importers see the change through ES module live
  bindings.
- `meter-layout.mjs` — the column table. Every width in the frame derives from
  `TOKEN_COLUMNS`, so a heading and its cells cannot drift apart.
- `meter-model.mjs` — pricing one call, `Tally`/`Turn`, and reading prompt text
  out of a log record. No rendering.
- `meter-render.mjs` — state in, lines of text out. Pure functions, so a frame
  can be rendered in a test without a Dashboard or a stream.
- `meter.mjs` — the `Dashboard` that accumulates records into tallies, plus the
  tail loop that feeds it.

**Navigation**

- `live.mjs` — orchestrates the session, owns the agents-pane state, and moves
  between agents and sessions.
- `session-picker.mjs`, `agent-picker.mjs` — the two interactive lists.

## Token columns

`uncached`, `cached`, and `write` are three **disjoint** buckets, priced
differently, and they are named the way the two vendors bill them:

| Column | API field | Rate |
| --- | --- | --- |
| `uncached` | `input_tokens` | 1× base |
| `cached` | `cache_read_input_tokens` | 0.1× base |
| `write` | `cache_creation_input_tokens` | 1.25× (5m) / 2× (1h) |
| `out` | `output_tokens` | ~5× base |

`input_tokens` is only the uncached remainder, not the whole prompt — which is
why a well-cached Opus turn reads `uncached 81 / cached 21.7M`. Fireworks bills
"cached prompt tokens" against "uncached tokens" and has no separate write price,
so `write` reads 0 on Fireworks models.

## Tests

`test/harnesses/claude/usage/` mirrors this folder. `modules.test.mjs` guards the
structure itself: the layering stays acyclic, the renderers stay pure, cost has
one call site, and each module stays inside a line budget.
