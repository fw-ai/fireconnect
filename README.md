# FireConnect

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/fw-ai/fireconnect/blob/main/LICENSE)

> Use [Fireworks AI](https://fireworks.ai) models in Claude Code, OpenCode, Codex, and Pi.

**Install in one line:**

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh)"
```

Or with `bash` directly:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash
```

Install the `fireconnect` CLI once, then use it to manage Fireworks routing for Claude Code, OpenCode, Codex, and Pi. Run `fireconnect help` to see what it can do.

## Quick Setup

Run this from a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash
```

For non-interactive setup:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | FIREWORKS_API_KEY="fw_..." bash
```

Fire Pass users can use a `fpk_...` key directly — FireConnect detects the key type and
uses the correct defaults for Fire Pass (glm-latest for all aliases).

If you prefer installing from an SSH checkout:

```bash
mkdir -p ~/.fireconnect && git clone git@github.com:fw-ai/fireconnect.git ~/.fireconnect && bash ~/.fireconnect/install.sh
```

The installer:

- Uses Node.js to update Claude Code settings. If Node.js is missing, asks before installing it with Homebrew or apt. It does not install or update npm packages.
- Points you to the Fireworks API key page and prompts once for your Fireworks API key.
- Applies the default model mapping and writes Claude Code settings.
- Installs the `fireconnect` CLI launcher to `~/.local/bin` and adds it to your shell `PATH`.

Then fully restart Claude Code and test with:

```text
hi
```

Default models:

```text
main     -> glm-latest
opus     -> glm-latest
sonnet   -> glm-5p1
haiku    -> minimax-m2p5
subagent -> minimax-m2p5
```

## Manual Setup

Create a Fireworks API key here:

```text
https://app.fireworks.ai/settings/users/api-keys
```

Then enable Fireworks routing from a terminal:

```bash
fireconnect claude on --api-key fw_...
```

Restart Claude Code after this completes.

## What Gets Written

The setup writes these Claude Code settings:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.fireworks.ai/inference",
    "ANTHROPIC_API_KEY": "fw_YOUR_FIREWORKS_API_KEY",
    "ANTHROPIC_AUTH_TOKEN": "fw_YOUR_FIREWORKS_API_KEY",
    "ANTHROPIC_MODEL": "accounts/fireworks/routers/glm-latest[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "accounts/fireworks/routers/glm-latest[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "accounts/fireworks/models/glm-5p1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "accounts/fireworks/models/minimax-m2p5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "accounts/fireworks/models/minimax-m2p5"
  }
}
```

The setup writes both `ANTHROPIC_API_KEY` (preferred) and `ANTHROPIC_AUTH_TOKEN` (compatibility alias) with the same Fireworks key. It saves a backup of your previous provider settings so `fireconnect claude off` can restore them.

Short model IDs are accepted everywhere. For example, `glm-latest` is written to Claude Code settings as `accounts/fireworks/routers/glm-latest[1m]`.

## Browsing and Picking Models

After `fireconnect claude on`, FireConnect prints hints for browsing the Fireworks catalog and
picking a model interactively.

```bash
fireconnect claude model list                 # browse callable serverless endpoints
fireconnect claude model select               # pick a model for Claude Code
fireconnect claude model select --slot sonnet # update one Claude Code alias
fireconnect opencode model select             # pick OpenCode's default model
fireconnect codex model select                # pick Codex's default model
```

### `fireconnect <harness> model list`

Harness-scoped: lists the Fireworks serverless catalog using the API key resolved from that
harness. Fetches serverless models from the Fireworks API (`supports_serverless=true`) and merges
the known public platform routers (`glm-latest`, `kimi-fast-latest`, `kimi-latest`, `kimi-k2p6-turbo`, and `kimi-k2p7-code-fast`). Every row is
tagged `serverless` (on-demand endpoints will be added later).

```bash
fireconnect claude model list
fireconnect claude model list --search glm
fireconnect opencode model list --json
```

Resolves the key in documented order: `--api-key`, then the harness's stored key, then
`~/.fireconnect/config.json`, then `FIREWORKS_API_KEY`. Non-Fireworks-shaped keys (for example
Anthropic `sk-ant-...`) are skipped when resolving harness-local keys.

Fire Pass keys (`fpk_...`) show Fire Pass-supported routers: `glm-latest`, `kimi-fast-latest`, and `kimi-k2p7-code-fast`.

### `fireconnect <harness> model select`

Interactive picker. Requires a terminal and Fireworks to be enabled for that harness.

**Claude Code** — pick one of five aliases (`main`, `opus`, `sonnet`, `haiku`, `subagent`):

```bash
fireconnect claude model select
fireconnect claude model select --slot sonnet
fireconnect claude model select --slot sonnet --search glm
```

**OpenCode** — single default model (no `--slot`):

```bash
fireconnect opencode model select
fireconnect opencode model select --search glm
```

### `fireconnect claude status` vs `fireconnect claude model list`

| Command | Shows |
|---------|--------|
| `fireconnect claude status` | Your current provider, auth, and configured alias mapping |
| `fireconnect claude model list` | Available serverless endpoints from the Fireworks API |

After `fireconnect claude on`, `model select`, or `model reset`, `settings.json` is updated
immediately. To use the new model in Claude Code, run `/model` to activate it in the same
session, start a new session, or `/exit` and resume the conversation with `claude --resume <id>`.

### Recommended model slugs

Short IDs are accepted everywhere and are normalized to their full paths automatically.

| Short ID | Best for | Notes |
|----------|----------|-------|
| `glm-latest` | All-around use, agentic tasks | Default for `main` and `opus` slots. Strong reasoning, 1M context. |
| `glm-5p1` | General use (lighter) | Default `sonnet` slot. Good balance of speed and quality. |
| `minimax-m2p5` | Background / fast tasks | Default `haiku` and `subagent` slots. Lowest latency. |

**Fire Pass keys** (`fpk_...`): all slots default to `glm-latest`.

**Switching a single slot** (Claude Code only):

```bash
fireconnect claude model select --slot opus    # pick a model interactively
fireconnect claude model select --slot sonnet  # pick general model interactively
fireconnect claude on --sonnet glm-5p1 --haiku minimax-m2p5  # set non-interactively
```

**OpenCode and Pi** use a single default model; use `fireconnect <harness> model select` or pass `--main <slug>` to `on`.

## FireConnect CLI

The CLI is harness-first: `fireconnect <harness> <command>`. A handful of commands are
global (no harness). Commands below are listed in the same order as `fireconnect help`.

**Global**

```text
fireconnect configure              Register harnesses and API key preferences.
fireconnect uninstall              Disable + restore all harnesses, then remove FireConnect.
fireconnect help                   Show help.
```

**Per harness** (`claude`, `opencode`, `codex`, `pi`)

```text
fireconnect <harness> on           Route the harness through Fireworks (default if no command).
fireconnect <harness> off          Restore your previous provider/config.
fireconnect <harness> status       Show the provider, auth, and model mapping.
fireconnect <harness> model list   Browse serverless Fireworks models.
fireconnect <harness> model select Interactive model picker.
fireconnect <harness> model reset  Reset models to defaults.
fireconnect <harness> help         Show help for that harness.
```

Run `fireconnect help` for the overview, or `fireconnect claude help` / `fireconnect opencode help` /
`fireconnect codex help` / `fireconnect pi help` for everything available at the harness level.

## Codex Harness

FireConnect routes [OpenAI Codex CLI](https://developers.openai.com/codex) through Fireworks via the Responses API:

```bash
export FIREWORKS_API_KEY=fw_...
fireconnect codex on                  # route Codex through Fireworks (~/.codex/config.toml)
fireconnect codex on --api-key fw_... # pass key once; later model commands reuse it
fireconnect codex status              # check current provider and model
fireconnect codex on --main glm-5p1   # switch model (non-interactive)
fireconnect codex model select        # switch model (interactive)
fireconnect codex off                 # restore your original config
```

What it does:

- Sets root `model_provider` / `model` for Codex 0.134+ and adds a
  `[model_providers.fireworks-ai]` block with `wire_api = "responses"`. With `--api-key` or a
  key from `~/.fireconnect/config.json`, FireConnect writes `experimental_bearer_token` so later
  `model list` / `select` / `reset` work without passing the key again. With only
  `FIREWORKS_API_KEY` in the environment, it writes `env_key = "FIREWORKS_API_KEY"` instead.
- Snapshots your original `~/.codex/config.toml` before the first change. `fireconnect codex off`
  restores it byte-for-byte. The snapshot lives in `~/.fireconnect/codex/`.
- Preserves unrelated Codex settings (for example `[[mcp_servers]]`) via surgical TOML edits.

After `fireconnect codex on`, `off`, `model select`, or `model reset`, `config.toml` is updated
immediately. To use the updated routing in Codex, run `/model` to activate it in the same
session, start a new session, or `/exit` and resume the conversation with `codex resume <id>`.

## OpenCode Harness

FireConnect routes [OpenCode](https://opencode.ai) through Fireworks with harness-first commands:

```bash
export FIREWORKS_API_KEY=fw_...
fireconnect opencode on                  # route OpenCode through Fireworks
fireconnect opencode status              # check current provider
fireconnect opencode on --main glm-5p1   # switch model (non-interactive)
fireconnect opencode model select        # switch model (interactive)
fireconnect opencode off                 # restore your original config
```

What it does:

- Merges a `provider.fireworks` block into `~/.config/opencode/opencode.json` (the
  OpenAI-compatible adapter pointed at `https://api.fireworks.ai/inference/v1`) and sets the
  default `model`. Your other providers are left untouched.
- Snapshots your original `opencode.json` before the first change. `fireconnect opencode off`
  restores it **byte-for-byte** (formatting, key order, everything). The snapshot lives in
  `~/.fireconnect/opencode/`.
- Keeps secrets out of the config file: when the key comes from the `FIREWORKS_API_KEY`
  environment variable, it is written as the `{env:FIREWORKS_API_KEY}` reference. Passing
  `--api-key` explicitly writes the literal key instead. OpenCode's `auth.json` is never
  touched.

Use `--config-path <path>` to target a non-default config file (also handy for testing
without touching your real config). See `docs/cli-design.md` for the full CLI spec.

## Pi Harness

FireConnect routes [Pi](https://pi.dev) through Fireworks with harness-first commands:

```bash
export FIREWORKS_API_KEY=fw_...
fireconnect pi on                        # route Pi through Fireworks
fireconnect pi status                    # check current provider
fireconnect pi on --main glm-5p1         # switch model (non-interactive)
fireconnect pi model select              # switch model (interactive)
fireconnect pi off                     # restore your original settings and auth
```

What it does:

- Sets `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` and stores the API
  key in `~/.pi/agent/auth.json` (`$FIREWORKS_API_KEY` when from env, literal with
  `--api-key`). `on` applies the default model (`glm-latest`) unless you pass
  `--main`.
- Snapshots both files under `~/.fireconnect/pi/` before the first change. `fireconnect pi off`
  restores them **byte-for-byte**. `auth.json` is written at mode `0600`.
- Restart Pi after `on`, `model select`, `model reset`, or `off` when Pi is already running.

Use `--settings-path <path>` to target a non-default settings file.

