# FireConnect

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/fw-ai/fireconnect/blob/main/LICENSE)

> Use [Fireworks AI](https://fireworks.ai) models inside the coding harnesses you already use: Claude Code, OpenCode, Codex, Pi, Cursor, VS Code, GitHub Copilot (app and CLI), and DeepSeek Harness.

One command points a harness at Fireworks. `on` edits that harness's own settings, `off` puts your original file back **exactly as it was**: nothing to host, nothing to launch.

**Contents:** [Quick start](#quick-start) · [Supported harnesses](#supported-harnesses) ·
[Default models](#default-models) · [Claude Code](#claude-code) · [Codex](#codex) ·
[OpenCode](#opencode) · [Pi](#pi) · [Cursor](#cursor) · [VS Code Chat](#vs-code-chat) ·
[GitHub Copilot app](#github-copilot-app) · [GitHub Copilot CLI](#github-copilot-cli) · [DeepSeek Harness](#deepseek-harness) ·
[FireRouter](#firerouter) · [Models](#models) ·
[Azure / Foundry](#azure-microsoft-foundry-endpoints) · [CLI reference](#cli-reference) ·
[Keys and storage](#keys-and-storage) · [Troubleshooting](#troubleshooting) ·
[Upgrade and uninstall](#upgrade-and-uninstall)

## Quick start

**1. Install**

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash
```

**2. Sign in**

```bash
fireconnect login        # browser sign-in, or paste a fw_… / fpk_… key
```

**3. Connect a harness**

```bash
fireconnect claude       # routes through Fireworks, appends the catalog to /model
```

```text
✓ Claude Code → Fireworks
Model picker
  Anthropic tiers → unchanged
  Fireworks catalog → appended in /model

Restart Claude Code to use the new setup.
```

**4. Restart the harness, then check**

```bash
fireconnect claude status
```

```text
Claude Code
Connection: on
Provider: Fireworks
Auth: X-Fireworks-Api-Key header in settings.json
Model: auto

Registered models:
  firerouter
  auto
  deepseek-flash-latest
  ...
```

`status` shows the model serving requests (`auto` when the main slot is left on
Claude Code's default) and the serverless catalog registered in `/model`.

Use any harness name in place of `claude`: `opencode`, `codex`, `pi`, `cursor`, `vscode`, `copilot-app`, `copilot-cli`, `deepseek`.
Run `fireconnect help` or `fireconnect <harness> help` to see every option.

### Install notes

- You need **bash** and **Node.js 18+**. If Node is missing or too old, the installer sets it up via Homebrew on macOS, or points you to nvm / nodejs.org / NodeSource elsewhere.
- The installer puts the CLI in `~/.fireconnect/cli`, adds a launcher to `~/.local/bin`, and adds it to your shell `PATH`.
- It also runs the same cleanup as `fireconnect upgrade`: re-checks key storage, re-saves keys for harnesses you've already connected, and removes the retired Claude WebSearch MCP.
- It doesn't sign you in or change any harness settings. That's steps 2 and 3.

**Windows:** run the install command from Git Bash. Piping it through PowerShell breaks line endings
(`set: pipefail\r: invalid option name`).

**From an SSH checkout:**

```bash
mkdir -p ~/.fireconnect && git clone git@github.com:fw-ai/fireconnect.git ~/.fireconnect && bash ~/.fireconnect/install.sh
```

## Supported harnesses

| Harness | Command | Settings file it edits | Where your key goes | Before `on` / `off` |
|---------|---------|------------------|-------------|---------------------|
| [Claude Code](#claude-code) | `fireconnect claude` | `~/.claude/settings.json` | Saved in the file itself (locked down to you only) | Restart after |
| [Codex](#codex) | `fireconnect codex` / `fireconnect chatgpt` | `~/.codex/config.toml` | Saved in the file itself (locked down to you only) | Restart after |
| [OpenCode](#opencode) | `fireconnect opencode` | `~/.config/opencode/opencode.json` | Saved in the file itself (locked down to you only) | Restart after |
| [Pi](#pi) | `fireconnect pi` | `~/.pi/agent/{settings,models,auth}.json` | Saved in the file itself (locked down to you only) | Restart after |
| [Cursor](#cursor) | `fireconnect cursor` | `state.vscdb` (SQLite) | IDE's own secure storage | **Quit Cursor first** |
| [VS Code Chat](#vs-code-chat) | `fireconnect vscode` | `chatLanguageModels.json` + `state.vscdb` | IDE's own secure storage | **Quit VS Code first** |
| [GitHub Copilot app](#github-copilot-app) | `fireconnect copilot-app` | `~/.copilot/data.db` (SQLite) | Saved in the file itself (locked down to you only) | **Quit Copilot first** |
| [GitHub Copilot CLI](#github-copilot-cli) | `fireconnect copilot-cli` | `~/.copilot/providers.json` + `settings.json` | Saved in the file itself (locked down to you only) | Restart `copilot` after |
| [DeepSeek Harness](#deepseek-harness) | `fireconnect deepseek` | `~/.dsh/settings.yaml` + `.credentials.yaml` | Saved in the file itself (locked down to you only) | Restart `dsh` after |

Every harness supports `on`, `off`, `status`, and `help`. `off` brings back how things were before you connected.
File-based harnesses restore from a snapshot kept under `~/.fireconnect/`, and the IDEs just drop what FireConnect added.

## Default models

| Slot / harness | What you get |
|----------------|---------|
| Claude tiers (`opus` / `sonnet` / `haiku` / `fable` / subagents) | Claude's own defaults (left alone); pick Fireworks entries in `/model` |
| Claude `/model` picker | Serverless catalog appended (`auto`, routers, `firerouter` when eligible) |
| OpenCode, Codex, Pi, Cursor, VS Code, Copilot, DeepSeek Harness | `auto` |
| Fire Pass (`fpk_...`) | `kimi-fast-latest` everywhere |

Fire Pass keys are detected on their own. No flags needed. Your saved Claude picks are kept separately
per key type (Fireworks vs Fire Pass) and come back quietly after `claude off` → `claude`.
Add a Fireworks model to the picker anytime with `fireconnect claude --model <id>`.

Re-running `fireconnect <harness>` refreshes the registered catalog in every harness: retired
models are pruned, newly served ones are added, and pricing / context / display metadata is
re-rendered in place. Your own models and picks are untouched.

## Claude Code

```bash
fireconnect claude                       # connect; catalog lands in /model
fireconnect claude --model <id>          # ensure one model appears in /model
fireconnect claude status                # mapping, auth, and per-slot rates
fireconnect claude usage                 # pick session → live meter (Tab agents, Esc sessions, q quit)
fireconnect claude usage --days 7        # look back further in the session list (default 3)
fireconnect claude usage --session <id>  # start on one session; Esc still opens the list
fireconnect claude usage --plain         # one-shot snapshot, no interactive picker
fireconnect claude live                  # tmux split: Claude Code left, live usage meter right
fireconnect claude demo                  # race two models on a prompt (needs routing on)
fireconnect claude off
```

For scripts and cost reporting, `status` and `usage` both print JSON:

```bash
fireconnect claude status --json         # provider, auth, mapping
fireconnect claude usage --last-n 5 --json  # snapshot the 5 latest sessions
fireconnect claude usage --verbose       # per-request rows and per-request rates
```

Settings apply per session: exit and resume with `claude --resume <id>`, or just
start a new session.

### Model picker

Claude Code has Anthropic tier rows in `/model` plus Fireworks entries. On connect, FireConnect
routes through Fireworks, **does not override** Opus / Sonnet / Haiku / Fable / subagent slots,
and **appends the registerable serverless catalog** (same set as Cursor and OpenCode) via
`settings.json` → `modelPicker`.

Use **`--model`** only when you want an extra picker row (for example `firerouter` or a router
not yet in the live catalog). It does **not** pin the main default or tier aliases.

```bash
fireconnect claude                              # catalog in /model, tiers native
fireconnect claude --model firerouter           # FireRouter row + routing headers
fireconnect claude --model glm-latest           # ensure that router appears in the picker
```

### What gets written

Claude Code signs in with a static `X-Fireworks-Api-Key` header
(`ANTHROPIC_CUSTOM_HEADERS`), **not** `apiKeyHelper`. On a standard key, `main` and
every tier slot default to **native** (unpinned): Anthropic's own picker rows stay
as-is. Pick Fireworks models from the extra `/model` entries FireConnect adds (`auto`,
routers, `firerouter`, etc.). Tier slot flags are retired — slots stay native.

| Slot | Default (standard `fw_` keys) |
|------|---------------------------|
| Main, Opus, Sonnet, Haiku, Fable, Subagents | native (never overridden by `on`) |
| `/model` picker | + full registerable serverless catalog |
| `--model <id>` | adds one Fireworks id to the picker (optional) |

Fire Pass (`fpk_`) keys are the exception: every slot pins its curated router
(`kimi-fast-latest` everywhere, including `main`), and no catalog picker is written.

After `fireconnect claude on`, settings look roughly like this (tier env pins omitted;
serverless models listed in `modelPicker`):

```json
{
  "modelPicker": {
    "fireconnectManaged": true,
    "replaceBuiltInOptions": false,
    "options": [
      { "model": "auto[1m]", "label": "Auto", "description": "…" },
      { "model": "glm-latest[1m]", "label": "GLM 5.3 (Latest)", "description": "…" }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.fireworks.ai/inference",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Fireworks-Api-Key: fw_..."
  }
}
```

`firerouter` is already a picker row on a standard key; passing
`--model firerouter` additionally sends routing headers with each request
(used for `--routing-preference`). Tier slots stay on Claude Code defaults
either way — pick a Fireworks entry in `/model` when you want a Fireworks
model. `main` stays unpinned on standard keys.

**Why a header?** The gateway checks `X-Fireworks-Api-Key` first, ahead of any `x-api-key` /
`Authorization` a leftover `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` might send, so a stray
Anthropic key can't quietly break routing. The trade-off: your Fireworks key sits in plaintext in
`settings.json` (readable only by you). The OS keychain stays the source of truth for
`key export` and other harnesses. FireConnect keeps an exact backup for `off`, and pre-approves a
stray `ANTHROPIC_API_KEY` in `~/.claude.json` so Claude Code doesn't nag you on first launch.

`on` also:

- Keeps Claude's own `WebSearch` and `WebFetch` working through the Fireworks Messages endpoint.
  Old `fireworks-websearch` MCP entries and tool denials from earlier FireConnect versions are
  removed; your own MCPs and permission rules are untouched.
- Adds a `statusLine` to `settings.json` showing which model served the session and what it cost
  at Fireworks rates (see [Status line](#status-line)). If you already have your own
  `statusLine`, it's never replaced.
- Labels requests with privacy-safe headers where the harness allows it: `X-Title: <harness>` and
  `HTTP-Referer: fireconnect/v<version>`. No `User-Agent` override, and nothing identifying you,
  your account, files, repos, prompts, sessions, or keys. Cursor and DeepSeek Harness have no
  header support, so they skip this.

**Model IDs and `[1m]`.** Short names work everywhere; long `accounts/fireworks/...` IDs are
shortened before saving. Picker rows carry a `[1m]` tag when the model's context window is 1M
tokens or more (checked against the live catalog when available, else built-in specs), plus any
`firerouter*` gateway name. Claude Code reads the tag to size the context window and strips it
before sending, so the gateway still sees a real model ID. Without the tag, Claude Code assumes
200K and squeezes the session to fit. The tag is Claude Code only. Other harnesses (Cursor, etc.)
take the bare name.

### Text-only models and images

Claude Code can't tell which models see images. Pasting or attaching an image while a text-only
model is active can break the session. Recover with `/rewind`. Adding a text-only model with
`--model` prints a one-line heads-up:

```text
Text-only: glm-fast-latest · Avoid images; recover with /rewind.
```

`fireconnect claude status` marks every model `vision` or `text-only`.

### Pricing estimates

Claude Code's `/model` picker and session estimates use **Anthropic list prices**, while
Fireworks bills at **serverless rates**, so the in-app number can look much higher than your real
bill. Trust `fireconnect claude status` and `fireconnect model list` for Fireworks rates, check
[serverless pricing](https://docs.fireworks.ai/serverless/pricing), and see the
[billing dashboard](https://app.fireworks.ai/account/billing) for what you actually spent. For a
per-session view at Fireworks rates, use the optional [status line](#status-line) or
`fireconnect claude usage`.

### Status line

`on` adds a `statusLine` to `settings.json` showing what served the session and what it cost at
Fireworks rates:

```text
━━━━━━━━━━━━ ━ ━ · $70.39
━ Claude Opus 5 $62.91 98% cache · ━ GLM 5.2 $7.35 96% cache · ━ DeepSeek V4 Flash $0.13 87% cache
```

The top line is a **bar showing where the money went**: one colored slice per model, sized by
its share of the bill, plus the session total. FireRouter switches models call by call, so the
bar shows the whole mix instead of just the latest model. Above, Opus 5 took 47% of the calls
but almost the whole bar, because it's 89% of the spend. That's the gap worth seeing. The bar
carries no text on purpose: a bare `%` next to the cache percentages below would be confusing,
so width means "share of spend" and the legend underneath names each model with exact dollars.

There's deliberately **no context-window figure**. Everything here is something only FireConnect
knows: which model served each call, what it cost at Fireworks rates, how often the cache hit.
Context usage is Claude Code's own number, already visible via `/context` and its auto-compact
warnings, so repeating it would waste columns. Before the first call there's no transcript yet,
so the bar shows the slot name instead. `fireconnect claude usage` has the full token table.

**Color is just identity.** Only the swatches and bar slices are colored; all words and numbers
use your terminal's own color so the line fits your theme. `NO_COLOR` gives plain text.

The cost is **not** Claude Code's number. That one uses Anthropic's list prices for every call,
so on the Fireworks gateway it reports money you'll never pay. FireConnect re-adds it from the
session transcript with the same engine behind `fireconnect claude usage`, priced by whichever
model actually served each call. Mid-session slot switches, FireRouter sessions that sent hard
turns to Claude, and subagent calls all total correctly. A `~` prefix means some model had no
published rate and fell back to a reference price. `97% cache` is the overall prompt-cache hit
share. It's the same number the live meter prints.

Rates come from the catalog cache `on` saves, so the line works offline. `off` removes it.
**If you already have a `statusLine`, FireConnect leaves it alone.** Delete yours and re-run
`fireconnect claude` to opt in.

## Codex

Sends [OpenAI Codex CLI](https://developers.openai.com/codex) through Fireworks via the
Responses API.

```bash
fireconnect codex                       # writes ~/.codex/config.toml
fireconnect codex status
fireconnect codex --model glm-latest      # switch model
fireconnect codex off
```

- Sets root `model_provider` / `model` for Codex 0.134+ (short name) and adds a
  `[model_providers.fireworks-ai]` block with `wire_api = "responses"` and your key saved
  right in the file (readable only by you). No shell hook needed.
- Saves the preferred serverless catalog to `~/.codex/fireworks-model-catalog.json` and points
  Codex at it with `model_catalog_json` (newest names preferred; embeddings, no-tool, and retired
  models filtered out). `off` deletes the file and the reference.
- Leaves the rest of your config alone (like `[[mcp_servers]]`) with careful TOML edits, and on
  `off` cleans up the shell hook when nothing else needs `FIREWORKS_API_KEY`.

> **MiniMax doesn't work on Codex.** Codex sometimes puts assistant messages between
> `tool_calls` and `tool_results`, which MiniMax templates reject. `codex --model minimax-latest`
> fails with an explanation. Use MiniMax on a Chat Completions harness like Claude Code or OpenCode.

Edits take effect in the file right away; exit Codex and `codex resume <id>` (or start fresh)
to load them. Use `--config-path <path>` for a config somewhere else.

> **Resuming an old session needs the matching provider on.**
> `codex resume` looks up the session's saved `model_provider` in the live
> `config.toml`, so say which provider or it falls back to OpenAI:
>
> ```bash
> codex resume <id> -c model_provider="fireworks-ai"        # Fireworks gateway
> codex resume <id> -c model_provider="fireworks-azure"     # Azure/Foundry
> ```
>
> `fireconnect codex off` removes the provider table, so resume only works while that route is on.

`fireconnect chatgpt` is the same thing under another name. `codex` and `chatgpt` share
`~/.codex`, so one command routes both the Codex CLI and the ChatGPT desktop app. Like the
IDEs, it asks you to quit the app first; `--force` writes anyway (not recommended).

## OpenCode

Sends [OpenCode](https://opencode.ai) through Fireworks.

```bash
fireconnect opencode
fireconnect opencode status
fireconnect opencode --model glm-latest
fireconnect opencode off
```

- Adds a `provider.fireworks-ai` block to `~/.config/opencode/opencode.json`, sets the default
  `model` to `fireworks-ai/<name>`, and lists provider models by short name. Your key is saved
  right in the file (readable only by you).
- Lists the preferred serverless catalog in the provider's `models` for OpenCode's `/model`
  picker. If the catalog can't be fetched (offline), it falls back to the active model.

Use `--config-path <path>` for a config somewhere else.

## Pi

Sends [Pi](https://pi.dev) through Fireworks.

```bash
fireconnect pi
fireconnect pi status
fireconnect pi --model glm-latest
fireconnect pi off
```

- Sets `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` and saves your key in
  `auth.json` (readable only by you). Without `--model` you get `auto`.
- Lists the preferred serverless catalog in `~/.pi/agent/models.json` for Pi's `/model` picker.
  Entries use full `accounts/fireworks/...` IDs so they line up with Pi's built-in rows, with
  context, pricing, reasoning, and vision info from the shared Fireworks specs. Offline, the last
  cached catalog is used.
- Backs up all three files (`settings.json`, `auth.json`, `models.json`). Which model IDs were
  added is tracked in `~/.fireconnect/config.json`, so repeat `on` rebuilds exactly and `off`
  removes only what FireConnect added.

Use `--settings-path <path>` for a settings file somewhere else.

## Cursor

Cursor keeps its AI settings in SQLite (`state.vscdb`), so FireConnect writes there directly:

| Setting | Key |
|---------|-----|
| API key | `cursorAuth/openAIKey` |
| Base URL | `openAIBaseUrl` → `https://api.fireworks.ai/inference/v1` |
| Custom models | `aiSettings.userAddedModels` + `aiSettings.modelOverrideEnabled` |
| Hidden built-ins | `aiSettings.modelOverrideDisabled` |
| Per-mode model | `aiSettings.modelConfig[mode]` (e.g. `composer`, `cmd-k`) |

```bash
fireconnect cursor --api-key fw_...      # quit Cursor first
fireconnect cursor status                # read-only; safe while Cursor is open
fireconnect cursor --model glm-fast-latest
fireconnect cursor --db-path <path>      # non-default state.vscdb (e.g. Cursor Insiders)
fireconnect cursor off
```

`cursor --model <id>` registers the model and applies it to **every mode you already have** in
`modelConfig` will not invent modes you don't use. Full Fireworks IDs are shortened on save;
old long-form entries migrate on the next `on`.

> **Quit Cursor (`Cmd-Q` / File > Quit) before `on` or `off`.** A running Cursor overwrites your
> edit with its in-memory state the next time it saves. In a terminal FireConnect waits for you
> to quit (press Enter to confirm, or it auto-detects); after ~90s it offers to continue anyway.
> `--force` skips the wait.

**While connected, only Fireworks models work.** Cursor's built-ins (Auto, subscription models,
Opus modes) are hidden and won't answer. `fireconnect cursor off` brings them back, and removes
only models FireConnect added.

## VS Code Chat

FireConnect adds a `Fireworks` provider to `chatLanguageModels.json` (vendor `customendpoint`,
`apiType: chat-completions`) pointing at `https://api.fireworks.ai/inference`. VS Code adds
`/v1/chat/completions` itself. Azure/Foundry mode uses `apiType: chat-completions` too.

```bash
fireconnect vscode --api-key fw_...       # quit VS Code first
fireconnect vscode status                 # read-only; safe while VS Code is open
fireconnect vscode --model deepseek-flash-latest
fireconnect vscode --vscode-path <path>   # non-default chatLanguageModels.json
fireconnect vscode off
```

Your key is **not** in the JSON: VS Code looks up `${input:chat.lm.secret.<id>}` in its
application-scoped `state.vscdb`, encrypted with Electron `safeStorage`. `on` writes the provider
entry plus the encrypted key under a `chat.lm.secret.fw-*` id. Same quit-first / `--force` rules
as Cursor.

`safeStorage` per platform:

- **macOS**: master key in the login Keychain (`<App> Safe Storage`); open VS Code once first.
  Insiders is auto-detected (`Code - Insiders Safe Storage`).
- **Windows**: AES-256-GCM with a DPAPI-protected key in VS Code's `Local State`.
- **Linux**: needs `libsecret` (`secret-tool`) for real encryption. Without it Chromium falls
  back to a fixed password (hidden, not encrypted); FireConnect still writes, with a warning.

`off` restores `chatLanguageModels.json` exactly and deletes the `chat.lm.secret.fw-*` row;
providers you set up yourself are untouched.

Per-model `toolCalling` / `vision` / token limits live in
`packages/setup-cli/lib/fireworks/model-specs.mjs`. Models not listed there default to
`toolCalling: true`, `vision: false`, with limits left out until the model is added.

## GitHub Copilot app

`fireconnect copilot-app` routes the **GitHub Copilot desktop app** through Fireworks. The app's
BYOK providers live in SQLite at `~/.copilot/data.db` (movable via `COPILOT_HOME`):

| Table | What FireConnect writes |
|-------|-------------------------|
| `model_providers` | One row, id starting `fc-`, named `Fireworks`, type `openai` |
| `settings_json` | `baseUrl` → `https://api.fireworks.ai/inference/v1`, `wireApi: completions`, your key as an `Authorization` header |
| `provider_models` | One row per model: model name, display name, token limits, reasoning efforts |

```bash
fireconnect copilot-app --api-key fw_...        # quit Copilot first
fireconnect copilot-app status                  # read-only; safe while Copilot is open
fireconnect copilot-app --model glm-latest
fireconnect copilot-app --db-path <path>        # non-default ~/.copilot/data.db
fireconnect copilot-app off
```

**Your built-in Copilot models keep working.** FireConnect's provider is added alongside them,
so the app's own models stay in the picker. And because only our own rows are added, `off` is
exact: it deletes the `fc-` provider and its models and touches nothing else.

> **Quit GitHub Copilot (`Cmd-Q` / File > Quit) before `on` or `off`**, same deal as Cursor and
> VS Code: wait in the terminal, continue-anyway after a bit, or `--force`.

Each model shows its display name, model name, token limits, and reasoning efforts
(`low`/`medium`/`high`/`max`) in Settings → Model providers → Edit model. Three things BYOK
models don't get in the desktop app: image input, the hover card's Context row, and AI-credits
pricing (BYOK bills through Fireworks, so GitHub has no price to show).

## GitHub Copilot CLI

`fireconnect copilot-cli` routes the **`copilot` command** (`@github/copilot`) through Fireworks.
The CLI shares the `~/.copilot` folder with the desktop app but never reads its database. Its
BYOK config is plain JSON:

| File | What FireConnect writes |
|------|-------------------------|
| `providers.json` | One `providers[]` entry named `fireworks` plus one `models[]` entry per model (token limits, per-model vision, `reasoningEffort` as an on/off toggle) |
| `settings.json` | The selected `model`: a BYOK provider has no default and the CLI won't start without one |

```bash
fireconnect copilot-cli --api-key fw_...
fireconnect copilot-cli status
fireconnect copilot-cli --model glm-latest
fireconnect copilot-cli --providers-path <path>   # non-default providers.json
fireconnect copilot-cli off
```

**Pick models with the provider name attached**: `fireworks/glm-latest`, not `glm-latest`. A bare
name is rejected ("Model … is not available") and quietly falls back to something else. Switch with
`copilot --model fireworks/<name>` or `/model`.

Unlike the desktop app, the CLI supports **per-model image input** (`capabilities.supports.vision`),
taken from the serverless catalog. What the CLI doesn't show for BYOK models: context size,
reasoning levels, or pricing — `providers.json` records token limits and a `reasoningEffort`
toggle, but the CLI's UI doesn't render either, and BYOK bills through Fireworks so there's no
price to show anyway. `providers.json` is yours to edit, so `off` restores it exactly
from a snapshot (or deletes it if FireConnect created it); providers and models you added yourself
survive both directions.

The two are independent. GitHub ships both under one brand but they share no settings. Turn on
either, both, or neither.

## DeepSeek Harness

Sends [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) through Fireworks
with a custom OpenAI-compatible provider in `$DSH_HOME` (default `~/.dsh`).

```bash
fireconnect deepseek
fireconnect deepseek status
fireconnect deepseek --model glm-latest
fireconnect deepseek off
```

- Writes `llm-pi-ai.providers.fireworks` and `agent-default-model` into `~/.dsh/settings.yaml`
  pointing at `https://api.fireworks.ai/inference/v1`.
- Saves your Fireworks key as `FIREWORKS_API_KEY` in `~/.dsh/.credentials.yaml` (readable only by you).
- Makes the chosen Fireworks model the default for new sessions.

Use `--config-path <path>` for a `settings.yaml` somewhere else (credentials stay next to that file).

## FireRouter

FireRouter sends each request to either Claude or a Fireworks open model. Easy work stays on
open models, hard work can use Claude when you've connected your Anthropic key. It's just a
**`firerouter` model** on the Fireworks gateway, not a separate mode.
Pick it like any other model.

```bash
fireconnect <harness> --model firerouter       # any harness
```

| | |
|--|--|
| **Keys** | Standard Fireworks (`fw_...`) only, not Fire Pass |
| **Catalog** | Always in `fireconnect model list` for a standard key |
| **Pickers** | In the default set for standard keys; `on --model firerouter` additionally sends routing headers |
| **No Anthropic key** | Still routes between Fireworks models; Claude Code attaches its own Anthropic auth |

**Using Anthropic's frontier models.** Pass `--anthropic-api-key sk-ant-...` (or export
`ANTHROPIC_API_KEY`) on a harness that can forward it. OpenAI BYOK isn't supported. On
Claude Code the flag is optional native auth — FireRouter works without it.

| Harness | Local Anthropic key | `--routing-preference` | Notes |
|---------|----------------------|------------------------|-------|
| Claude Code | Header value | Yes | Gateway header still wins for auth |
| OpenCode | Header value | Yes | `--model firerouter` registers only that model |
| Pi | Header value | Yes | Same Fireworks provider as other Pi models |
| VS Code | Header value | Yes | Same provider (`apiType: chat-completions`) |
| Codex | `ANTHROPIC_API_KEY` env reference | No | Export the key |
| Cursor | Not forwardable | No | Settings screen can't attach a local Anthropic key |
| DeepSeek Harness | Not forwardable | No | Custom provider can't attach a local Anthropic key |

Tune cost vs quality where supported:

```bash
fireconnect claude --model firerouter --routing-preference balanced
# max-intelligence (1) · more-intelligence (2) · balanced (3) · more-savings (4) · max-savings (5)
```

> The old `--router` flag is gone. Use `--model firerouter`.

More detail: [FireRouter overview](https://docs.fireworks.ai/ecosystem/firerouter/overview).

## Models

```bash
fireconnect model list
fireconnect model list --search glm
fireconnect model list --refresh
fireconnect model list --json
```

Lists coding-ready serverless models (`GET /v1/serverless/models?use_cases=coding`), plus the
fast per-model routers the API reports and version-tracking nicknames whose targets exist:
`glm-latest`, `glm-flash-latest`, `glm-fast-latest`, `kimi-latest`,
`kimi-fast-latest`, `minimax-latest`, `qwen-plus-latest`. Every row is tagged `serverless`.
The list is cached for **1 hour**; `--refresh` skips the cache and refetches. Offline, the last
cached list is shown instead of an error.

US-only serverless routers get their own section and take short names:

```bash
fireconnect claude on --model kimi-k3-us
fireconnect opencode on --model glm-5p2-fast-us
fireconnect claude on --model glm-5p3-flash-us
```

US-only endpoints launched from September 1, 2026 cost 50% more than the matching global row
(`glm-5p3-flash-us`). Earlier routers keep their launch prices: `kimi-k3-us` at +10%,
`glm-5p2-fast-us` at the same price as global GLM 5.2 Fast. See
[US-only Serverless](https://docs.fireworks.ai/serverless/us-only-serverless).

Which key is used, in order: `--api-key` → `FIREWORKS_API_KEY` → saved key. Standard keys see
`firerouter`; Fire Pass keys see only Fire Pass routers (`glm-latest`,
`glm-fast-latest`, `glm-5p2-fast`, `kimi-fast-latest`).

| Command | Shows |
|---------|--------|
| `fireconnect claude status` | Provider, auth, name mapping, **Fireworks rates** per slot |
| `fireconnect model list` | Serverless catalog with **IN / OUT pricing** where known |

Short names and full `accounts/fireworks/...` IDs both work, and `-latest` nicknames
(`glm-latest`, `kimi-fast-latest`, …) beat pinned versions. They follow new releases on their
own. Most non-Claude harnesses store short names; Pi stores full `accounts/fireworks/...` IDs.
Older configs migrate to each harness's format on the next `on`. Not sure? Start from
[the defaults](#default-models) or browse `fireconnect model list`.
Foundry (Azure) uses deployment names instead (see [Azure](#azure-microsoft-foundry-endpoints)).

## Azure (Microsoft Foundry) endpoints

Fireworks models are also first-party models inside
[Microsoft Foundry](https://docs.fireworks.ai/ecosystem/integrations/azure-foundry), billed
through Azure and counting toward your MACC. Foundry speaks an **OpenAI-compatible** API,
so **OpenCode, Codex, Pi, Cursor, and VS Code** can point there instead of the Fireworks gateway.

Set it once, then `<harness> on` uses it. No per-command flags:

```bash
fireconnect configure --provider azure \
  --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key>

fireconnect opencode      # goes through your Foundry endpoint
fireconnect codex
```

`configure` saves a top-level `provider` and `azure` endpoint in `~/.fireconnect/config.json`.
Go back with `fireconnect configure --provider fireworks ...`. Or opt in per command (overrides
the saved endpoint) with `--azure`:

```bash
fireconnect opencode --azure --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key> --model FW-GLM-5.2
```

- **Endpoint.** FireConnect tidies up whatever you paste (a bare resource root, a portal project
  endpoint (`.../api/projects/<name>`), or the `/models` route) into
  `https://<resource>.services.ai.azure.com/openai/v1`. Find it in the Foundry portal under
  **Project settings**.
- **Auth.** Use your **Azure** API key (not `fw_`/`fpk_`). `--api-key` saves it as-is;
  exporting `AZURE_API_KEY` saves a reference to the variable instead.
- **Model.** The id is your Foundry **deployment** name: the catalog model name without the
  `fireworks-ai/` prefix (e.g. `FW-GLM-5.2`, `FW-MiniMax-M2.5`). Defaults to `FW-GLM-5.2`.
- **Separation.** Each harness gets its own `fireworks-azure` provider, separate from the Fireworks
  gateway; `off` restores exactly, and switching modes swaps it cleanly.

| Harness | Writes | Provider |
|---------|--------|----------|
| OpenCode | `provider.fireworks-azure` in `opencode.json` (`@ai-sdk/openai-compatible`, `options.baseURL` + `options.apiKey`) | `fireworks-azure/<deployment>` |
| Codex | `[model_providers.fireworks-azure]` in `config.toml` (`wire_api = "chat"`, key or `env_key = "AZURE_API_KEY"`) | `fireworks-azure` |
| Pi | custom `openai-completions` provider in `models.json` (`baseUrl`, `authHeader`, key or `$AZURE_API_KEY`) + `defaultProvider` in `settings.json` | `fireworks-azure` |
| Cursor | OpenAI-compatible URL, deployment, and key in `state.vscdb` | `<deployment>` |
| VS Code | custom endpoint model in `chatLanguageModels.json`; key in `safeStorage` | `<deployment>` |

`fireconnect <harness> status` reports `azure` as the provider with the endpoint and model.

> Claude Code is left out on purpose: it speaks the Anthropic Messages API, which Foundry
> doesn't offer. `model list` reads the Fireworks catalog and doesn't apply in Azure mode.
> Pick a deployment with `--model`.

## CLI reference

Harness-first: `fireconnect <harness> <command>`, plus a few global commands.

**Per harness** (`claude`, `opencode`, `codex`, `pi`, `cursor`, `vscode`, `copilot-app`, `copilot-cli`, `deepseek`)

```text
fireconnect <harness> on           Send the harness through Fireworks (the default when no command given).
fireconnect <harness> off          Bring back your previous provider/config.
fireconnect <harness> status       Show the provider, auth, and model mapping.
fireconnect <harness> status --json  Same state as JSON (for CI checks).
fireconnect <harness> help         Help for that harness.
```

Every model change goes through `<harness> on`. Claude adds `fireconnect claude usage`, `fireconnect claude live`, and `fireconnect claude demo`.

**Global**

```text
fireconnect login                  Sign in: browser (creates a key) or paste a key you have.
fireconnect logout                 Clear the stored key (keychain entry + config ref).
fireconnect status                 Show sign-in state, machine environment, and key storage.
fireconnect model list             Browse the serverless catalog.
fireconnect configure              Set the provider (Azure/Foundry) and the Anthropic key.
fireconnect claude demo              Race two models on the same prompt via Claude Code.
fireconnect upgrade                Update FireConnect.
fireconnect uninstall              Switch off + restore every harness, then remove FireConnect.
fireconnect --version              Print the installed CLI version (-V; --json for machine-readable).
fireconnect help                   Show help.
```

`login` asks one question: create a key for this machine, or paste one you already have.
Create opens the browser, makes `fireconnect-{hostname}`, and stores it in the OS keychain.
It then tells you which account and where the key went. Paste hides what you type, checks it live,
and stores it only if valid. `--paste` skips the question; `--with-token` reads from stdin (CI);
`--account <id>` signs into an enterprise SSO account. Already signed in? `login` asks before
swapping the key. `--force` skips that check for rotations.

`logout` deletes the local key and offers to revoke the machine key on the server too (`--revoke`
skips the question and revokes). You can skip `login` entirely: `fireconnect claude` signs you in
inline when it needs a key.

## Keys and storage

- `~/.fireconnect/config.json` holds a **reference** (`{keychain:fireworks-api-key}`), never the
  key itself. Older installs may still have `{env:FIREWORKS_API_KEY}`.
- The key itself lives in the OS keychain, or in an encrypted-file / plaintext fallback when no
  secret service exists (`fireconnect status` says which).
- `--home <path>` overrides HOME for config lookup and `--data-dir <path>` moves the
  backup/state folder. Handy for sandboxes and tests that must leave your real harness configs alone.
- Harness configs hold **saved keys** for Claude's custom header, Codex, OpenCode, Pi, and
  DeepSeek Harness; Cursor and VS Code use IDE `safeStorage`.
- Re-running `install.sh` or `fireconnect upgrade` shares one cleanup that re-saves keys for
  connected harnesses, removes the retired Claude WebSearch MCP, and migrates old env-reference auth
  left on disk.

**`FIREWORKS_API_KEY` interaction.** The env var and FireConnect-managed storage don't mix for
**login and other explicit key saves**. When it's set, `login` checks it and uses it without
copying it into secret storage, and combining `login` with a key-saving option (`--api-key`,
`--with-token`, browser, paste) fails before changing anything. Unset the variable first.
`<harness> on` may still read it, save it, and bake it into that harness's config.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Harness still uses the old model or provider | Fully restart the harness. In Claude Code, exit and `claude --resume <id>`. Settings apply per session. |
| Cursor / VS Code changes don't stick | Quit the IDE (`Cmd-Q`) **before** `on`/`off`; the running app saves over your edit. |
| Only Fireworks models answer in Cursor | That's expected while connected. `fireconnect cursor off` brings back built-ins. |
| Claude session breaks after pasting an image | A [text-only](#text-only-models-and-images) slot was active. `/rewind`, then give that slot a vision model. |
| `claude-fable-5-1` fails with `model_not_found` | The gateway serves Opus / Sonnet / Haiku by concrete id, but Fable needs data retention enabled on the upstream account — without it every Fable call 404s while connected. Pick another row with `/model`, or ask about account access. |
| Resumed session says the model "could not be restored" | Normal with Fireworks models: the transcript records the serving backend (e.g. `accounts/fireworks/models/…`), which Claude doesn't recognize as a model id, so it falls back to your configured default. If no default is pinned, that means native Opus — check the status line for a fresh Opus slice and re-pick your row if so. |
| Claude Code shows a scary cost estimate | It uses [Anthropic list prices](#pricing-estimates). Check `fireconnect claude status` for real Fireworks rates. |
| `firerouter` missing from a picker | It's opt-in — pick it directly with `on --model firerouter`. Not on Fire Pass keys. |
| `login` fails with a key-storage conflict | `FIREWORKS_API_KEY` is set. Unset it so FireConnect can store a key. |
| `/model` picker ignores your main model | An old `env.ANTHROPIC_MODEL` is overriding it. Re-run `fireconnect claude` once to migrate. |
| PowerShell install fails (`set: pipefail\r`) | Install from [Git Bash](#install-notes). |
| Linux warns the key isn't encrypted | Install `libsecret` (`secret-tool`); Chromium's fallback only hides, not encrypts. |
| Something else | `fireconnect status` shows sign-in, environment, storage tier, and every harness's state. |

## Upgrade and uninstall

```bash
fireconnect upgrade
# or re-run the installer:
sh -c "$(curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh)"
```

Interactive terminals also offer an upgrade when a newer version is cached
(`Upgrade now?`); saying no snoozes it for a day.

Upgrading from **before 0.9.0** with Claude Code connected asks before briefly restoring
your original settings, then tells you to reconnect with `fireconnect claude`. From **0.9.0**
on, reinstalls and upgrades leave harness settings alone except re-saving keys and small forward
migrations (currently: VS Code's provider `apiType`, adding `ENABLE_TOOL_SEARCH` to
managed Claude Code settings, and registering / refreshing the Fireworks catalog in each
connected harness's picker). Your other settings and stored API key are kept either way.

After fetching the update, `fireconnect upgrade` runs its final step in a fresh process so
migrations come from the new version, not the old process's cache. For the move off older
updaters, the changed package lock makes their existing upgrade path run `npm install`; a
durable-install-only postinstall hook runs that same new final step. Plain repo and global npm
installs don't match the durable layout and skip the hook.

```bash
fireconnect uninstall    # restores every harness, then removes ~/.fireconnect and the launcher
fireconnect uninstall --force   # no questions: force-restore everything (CI / scripts)
```
