# FireConnect

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/fw-ai/fireconnect/blob/main/LICENSE)

> Use [Fireworks AI](https://fireworks.ai) models in Claude Code and OpenCode.

**Install in one line:**

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh)"
```

Or with `bash` directly:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash
```

Install the `fireconnect` CLI once, then use it to manage Fireworks routing for Claude Code and OpenCode. Run `fireconnect help` to see what it can do.

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
uses the correct defaults for Fire Pass (kimi-k2p7-code-fast for all aliases).

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
opus     -> kimi-k2p7-code-fast
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
fireconnect on --api-key fw_...
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
    "ANTHROPIC_MODEL": "accounts/fireworks/routers/kimi-k2p7-code-fast",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "accounts/fireworks/routers/kimi-k2p7-code-fast",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "accounts/fireworks/models/glm-5p1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "accounts/fireworks/models/minimax-m2p5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "accounts/fireworks/models/minimax-m2p5"
  }
}
```

The setup writes both `ANTHROPIC_API_KEY` (preferred) and `ANTHROPIC_AUTH_TOKEN` (compatibility alias) with the same Fireworks key. It saves a backup of your previous provider settings so `fireconnect off` can restore them.

Short model IDs are accepted everywhere. For example, `kimi-k2p7-code-fast` is written to Claude Code settings as `accounts/fireworks/routers/kimi-k2p7-code-fast`.

## Browsing and Picking Models

After `fireconnect on`, FireConnect prints hints for browsing the Fireworks catalog and
picking a model interactively.

```bash
fireconnect model list              # browse callable serverless endpoints
fireconnect model select            # pick a model for Claude Code
fireconnect model select --slot sonnet   # update one Claude Code alias
fireconnect model select --harness opencode   # pick OpenCode's default model
```

### `fireconnect model list`

Harness-agnostic by default: lists the same Fireworks serverless catalog regardless of Claude
Code or OpenCode. Fetches serverless models from the Fireworks API (`supports_serverless=true`)
and merges the two known public platform routers (`kimi-k2p6-turbo` and `kimi-k2p7-code-fast`).
Every row is tagged `serverless` (on-demand endpoints will be added later).

```bash
fireconnect model list
fireconnect model list --search glm
fireconnect model list --json
fireconnect model list --harness opencode
```

Uses `FIREWORKS_API_KEY`, or a key already stored in Claude Code or OpenCode settings. By
default both sources are checked, but non-Fireworks-shaped keys (for example, an Anthropic
`sk-ant-...` token) are skipped. Use `--harness opencode` to force the OpenCode key source, or
`--harness claude` to force the Claude Code source.

Fire Pass keys (`fpk_...`) only show the `kimi-k2p7-code-fast` router.

### `fireconnect model select`

Interactive picker. Requires a terminal and Fireworks to be enabled. On confirm, writes
the chosen model to your harness settings.

**Claude Code** — pick one of five aliases (`main`, `opus`, `sonnet`, `haiku`, `subagent`):

```bash
fireconnect model select
fireconnect model select --slot sonnet
fireconnect model select --slot sonnet --search glm
```

**OpenCode** — single default model (no `--slot`):

```bash
fireconnect model select --harness opencode
fireconnect model select --harness opencode --search glm
```

### `fireconnect list` vs `fireconnect model list`

| Command | Shows |
|---------|--------|
| `fireconnect list` | Your configured alias mapping in Claude Code settings |
| `fireconnect model list` | Available serverless endpoints from the Fireworks API |

## FireConnect CLI

```text
fireconnect on         Route Claude Code through Fireworks.
fireconnect off        Restore your previous provider.
fireconnect status     Show the current provider.
fireconnect list       Show the model mapping.
fireconnect model      Browse or pick serverless models (list, select).
fireconnect set        Change model aliases.
fireconnect reset      Reset models to defaults.
fireconnect uninstall  Remove FireConnect from this machine.
```

Run `fireconnect help <command>` for all options.

## OpenCode Harness

FireConnect can also route [OpenCode](https://opencode.ai) through Fireworks. The same CLI
commands work with `--harness opencode`:

```bash
export FIREWORKS_API_KEY=fw_...
fireconnect on --harness opencode        # route OpenCode through Fireworks
fireconnect status --harness opencode    # check current provider
fireconnect set --harness opencode --main glm-5p1   # switch model
fireconnect off --harness opencode       # restore your original config
```

What it does:

- Merges a `provider.fireworks` block into `~/.config/opencode/opencode.json` (the
  OpenAI-compatible adapter pointed at `https://api.fireworks.ai/inference/v1`) and sets the
  default `model`. Your other providers are left untouched.
- Snapshots your original `opencode.json` before the first change. `fireconnect off`
  restores it **byte-for-byte** (formatting, key order, everything). The snapshot lives in
  `~/.fireconnect/opencode/`.
- Keeps secrets out of the config file: when the key comes from the `FIREWORKS_API_KEY`
  environment variable, it is written as the `{env:FIREWORKS_API_KEY}` reference. Passing
  `--api-key` explicitly writes the literal key instead. OpenCode's `auth.json` is never
  touched.

Use `--config-path <path>` to target a non-default config file (also handy for testing
without touching your real config). See `docs/opencode-harness.md` for design notes and
remaining verification items.

