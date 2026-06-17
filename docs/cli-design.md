# FireConnect CLI Design

Harness-first command syntax aligned with team spec (June 2026).

## Syntax

```
fireconnect <harness> <noun> <verb>
```

**Harness first**, then resource, then action.

### Per harness (`claude`, `opencode`)

```bash
fireconnect claude on
fireconnect claude off
fireconnect claude status
fireconnect claude on --main kimi-k2p7-code-fast
fireconnect claude model list
fireconnect claude model select --slot sonnet
fireconnect claude model reset

fireconnect opencode on
fireconnect opencode off
fireconnect opencode model list
fireconnect opencode model select
fireconnect opencode model reset
```

Bare harness runs `on` (e.g. `fireconnect claude`).

### Global commands

```bash
fireconnect configure          # register harnesses, API key setup
fireconnect uninstall          # off + restore ALL configured harnesses, then remove CLI
fireconnect help
```

`model list` is harness-scoped (`fireconnect <harness> model list`) so the
Fireworks key is resolved from that harness's settings.

## Migration (previous syntax)

| Before | After |
|--------|-------|
| `fireconnect on` | `fireconnect claude on` |
| `fireconnect off` | `fireconnect claude off` |
| `fireconnect status` | `fireconnect claude status` |
| `fireconnect list` | `fireconnect claude status` |
| `fireconnect set` | `fireconnect claude on --main <id>` |
| `fireconnect reset` | `fireconnect claude model reset` |
| `fireconnect on --harness opencode` | `fireconnect opencode on` |
| `fireconnect model list` | `fireconnect claude model list` / `fireconnect opencode model list` |
| `fireconnect model select --harness opencode` | `fireconnect opencode model select` |
| `fireconnect uninstall` (Claude only) | Off all configured harnesses, then uninstall |

## Internal shape

Each harness is a module implementing `HarnessAdapter`:

- `on`, `off`, `status`, `modelList`, `modelSelect`, `modelReset`, `resolveKey`

`resolveKey(ctx)` returns the harness-local Fireworks key; the shared resolver
layers it between `--api-key` and the global config / `FIREWORKS_API_KEY`.

Shared config at `~/.fireconnect/config.json`:

```json
{
  "apiKey": "{env:FIREWORKS_API_KEY}",
  "harnesses": {
    "claude": { "enabled": true },
    "opencode": { "enabled": false }
  }
}
```

Per-harness data dirs (`~/.fireconnect/claude`, `~/.fireconnect/opencode`) hold
backups and harness-local metadata; on/off state lives in `config.json`.

## API key resolution

1. Explicit `--api-key`
2. Harness-local stored key
3. Global `config.json`
4. `FIREWORKS_API_KEY` environment variable
