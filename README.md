# FireConnect

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/fw-ai/fireconnect/blob/main/LICENSE)

> Use [Fireworks AI](https://fireworks.ai) models in Claude Code, OpenCode, Codex, Pi, Cursor, VS Code, and DeepSeek Harness.

One CLI points your existing AI coding tools at Fireworks. `on` rewrites the tool's own config,
`off` restores your original file **byte-for-byte** — no proxy to run, no wrapper to launch.

**Contents:** [Quick start](#quick-start) · [Supported harnesses](#supported-harnesses) ·
[Default models](#default-models) · [Claude Code](#claude-code) · [Codex](#codex) ·
[OpenCode](#opencode) · [Pi](#pi) · [Cursor](#cursor) · [VS Code Chat](#vs-code-chat) ·
[DeepSeek Harness](#deepseek-harness) · [FireRouter](#firerouter) · [Models](#models) ·
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
fireconnect claude       # first run opens the model mapping wizard
```

```text
✓ Claude Code → Fireworks
Model mapping
  Fable     → kimi-fast-latest
  Main      → Claude default
  Opus      → firerouter
  Sonnet    → glm-fast-latest
  Haiku     → deepseek-flash-latest
  Subagents → Claude default

✓ Web search → fireworks-websearch (installed)

Restart Claude Code to use the new setup.
```

**4. Restart the tool, then verify**

```bash
fireconnect claude status
```

```text
Claude Code
Connection: on
Provider: Fireworks
Auth: custom header in settings.json

Model mapping:
  main     -> firerouter
```

`claude status` lists only overrides — unpinned native slots and slots still on the
default Fireworks mapping are omitted. After Mix with the recommended fast profile,
the mapping section may be empty until you pin a slot.

Swap `claude` for any harness: `opencode`, `codex`, `pi`, `cursor`, `vscode`, `deepseek`.
Run `fireconnect help` or `fireconnect <harness> help` for every option.

### Install notes

- Requires **bash** and **Node.js 18+**. Missing or too old Node: installed via Homebrew on macOS, otherwise the
  installer prints nvm / nodejs.org / NodeSource instructions.
- Clones the CLI to `~/.fireconnect/cli`, installs the launcher into `~/.local/bin`, and adds it
  to your shell `PATH`.
- Runs the same finalize as `fireconnect upgrade` (reprobe secret storage; rebake enabled harness
  keys and the Claude websearch MCP Bearer token).
- Does **not** sign you in or touch harness settings — that's steps 2 and 3.

**Windows:** run from Git Bash with the same command above. Piping through PowerShell corrupts line endings
(`set: pipefail\r: invalid option name`).

**From an SSH checkout:**

```bash
mkdir -p ~/.fireconnect && git clone git@github.com:fw-ai/fireconnect.git ~/.fireconnect && bash ~/.fireconnect/install.sh
```

## Supported harnesses

| Harness | Command | Config it writes | Key storage | Before `on` / `off` |
|---------|---------|------------------|-------------|---------------------|
| [Claude Code](#claude-code) | `fireconnect claude` | `~/.claude/settings.json` | Baked header literal (`0600`) | Restart after |
| [Codex](#codex) | `fireconnect codex` | `~/.codex/config.toml` | Baked bearer literal (`0600`) | Restart after |
| [OpenCode](#opencode) | `fireconnect opencode` | `~/.config/opencode/opencode.json` | Baked literal (`0600`) | Restart after |
| [Pi](#pi) | `fireconnect pi` | `~/.pi/agent/{settings,models,auth}.json` | Baked literal (`0600`) | Restart after |
| [Cursor](#cursor) | `fireconnect cursor` | `state.vscdb` (SQLite) | IDE `safeStorage` | **Quit Cursor first** |
| [VS Code Chat](#vs-code-chat) | `fireconnect vscode` | `chatLanguageModels.json` + `state.vscdb` | IDE `safeStorage` | **Quit VS Code first** |
| [DeepSeek Harness](#deepseek-harness) | `fireconnect deepseek` | `~/.dsh/settings.yaml` + `.credentials.yaml` | Baked credential (`0600`) | Restart `dsh` after |

Every harness supports `on`, `off`, `status`, and `help`. `off` restores your pre-connect
configuration — file-based harnesses byte-for-byte from a snapshot under `~/.fireconnect/`,
and the IDEs by removing only what FireConnect registered.

## Default models

| Slot / harness | Default |
|----------------|---------|
| Claude `opus` | `firerouter` on first connect when FireRouter auth is available; otherwise `kimi-fast-latest` |
| Claude `sonnet` | `glm-fast-latest` |
| Claude `fable` | `kimi-fast-latest` when FireRouter takes Opus; otherwise `deepseek-pro-latest` |
| Claude `haiku` | `deepseek-flash-latest` |
| Claude `subagent` | `deepseek-flash-latest` |
| OpenCode, Codex, Pi, Cursor, VS Code, DeepSeek Harness | `kimi-fast-latest` |
| Fire Pass (`fpk_...`) | `kimi-fast-latest` everywhere |

Fire Pass keys are detected automatically — no flags needed. Saved Claude mappings are
key-scoped (Fireworks vs Fire Pass) and silently restored after `claude off` → `claude`.
Override anytime with flags or the [wizard](#model-mapping).

## Claude Code

```bash
fireconnect claude                       # wizard on first setup; flags work anytime
fireconnect claude --interactive         # reopen the model mapping wizard
fireconnect claude status                # mapping, auth, and per-slot rates
fireconnect claude usage                 # pick session → live meter (Tab agents, Esc sessions, q quit)
fireconnect claude usage --days 7        # widen the session list's lookback (default 3)
fireconnect claude usage --session <id>  # start on one session; Esc still opens the list
fireconnect claude usage --plain         # one-shot snapshot, no interactive picker
fireconnect claude demo                  # race two models on a prompt (requires routing on)
fireconnect claude off
```

Settings apply per session: to pick up a new mapping, exit and resume with
`claude --resume <id>`, or start a new session.

### Model mapping

Claude Code has six model slots. FireConnect owns the mapping and prints it after every
successful activation. Configure it three ways:

```bash
# 1. Interactive wizard — first connect, or anytime
fireconnect claude --interactive

# 2. Slot flags — scriptable, combine freely
fireconnect claude --model kimi-fast-latest
fireconnect claude --opus glm-fast-latest --sonnet glm-fast-latest
fireconnect claude --haiku deepseek-flash-latest --subagent deepseek-flash-latest

# 3. Saved prefs / defaults, no prompts — CI and scripts
fireconnect claude --non-interactive
```

`--interactive` opens the wizard at any time, not just on first connect. It is Fable-first,
toggles between the recommended fast profile and a non-fast profile, and needs a terminal —
use the flags above in CI.

| Flag | Writes |
|------|--------|
| `--model` | top-level `model` (Claude's main / the `/model` "Default" row) |
| `--opus`, `--sonnet`, `--haiku`, `--fable` | matching `ANTHROPIC_DEFAULT_*_MODEL` |
| `--subagent` | `CLAUDE_CODE_SUBAGENT_MODEL` |

Slots are independent — `--opus firerouter` changes only Opus and leaves main alone.
Use `native` as a slot value to leave it unpinned so Claude Code picks Anthropic's
default for that role (still routed through Fireworks). `on` is optional.

```bash
fireconnect claude --opus native --sonnet native   # native Opus/Sonnet
fireconnect claude --model claude-sonnet-4-5       # pin a specific Anthropic model
```

On first connect, the wizard asks Fireworks-only vs Mix (recommended). Re-running `fireconnect claude` without model flags preserves the current main when
FireConnect is already active (including `/model` changes made inside Claude Code), and
otherwise restores your saved key-scoped mapping.

### What gets written

Claude authenticates with a static `X-Fireworks-Api-Key` custom header
(`ANTHROPIC_CUSTOM_HEADERS`), **not** `apiKeyHelper`. `main` and `subagent` stay native
(Claude-default — Claude Code's own defaults), so neither is pinned; the alias slots are
pinned in `env`. With FireRouter auth present, `opus` is `firerouter` and `fable` is
`kimi-fast-latest`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.fireworks.ai/inference",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "firerouter[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-fast-latest[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-flash-latest[1m]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "kimi-fast-latest[1m]",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Fireworks-Api-Key: fw_..."
  }
}
```

Without FireRouter auth, `opus` falls back to `kimi-fast-latest[1m]` and `fable` to
`deepseek-pro-latest[1m]`.

When FireRouter is auto-selected on first connect, `model` is `firerouter[1m]` instead.

**Why the custom header?** The gateway authenticates via `X-Fireworks-Api-Key`, which wins over
any `x-api-key` / `Authorization` a stray `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` would
send — so a leftover Anthropic key can't silently break routing. The trade-off is a plaintext
Fireworks key in `settings.json` (mode `0600`); the OS keychain stays the source of truth for
`key export` and other harnesses. FireConnect keeps a byte-for-byte backup for `off`, and
pre-approves a stray `ANTHROPIC_API_KEY` in `~/.claude.json` so Claude Code doesn't prompt on
first launch.

`on` also:

- Adds `WebSearch` / `WebFetch` to `permissions.deny` — Anthropic **server-side** tools the
  gateway can't run. Your own rules are preserved; the deny entries are removed on `off`. If
  your account is entitled to Fireworks web search, a `fireworks-websearch` MCP server is
  installed as the working replacement, with `Authorization: Bearer <key>` baked into
  `~/.claude.json` (same shape as `claude mcp add --header`).
- Sends privacy-safe attribution headers where the harness supports them: `X-Title: <harness>`
  and `HTTP-Referer: fireconnect/v<version>`. `User-Agent` is never overridden, and these carry
  no user, account, path, repo, prompt, session, or credential data. Cursor and DeepSeek Harness
  expose no custom-header surface, so they skip attribution.

**Model IDs and `[1m]`.** Short slugs are accepted everywhere and canonical
`accounts/fireworks/...` IDs are shortened before write. The `[1m]` suffix is
applied **per model ID** when the resolved serverless context window is at least
1M tokens (live catalog cache when available, otherwise static specs), plus any
`firerouter*` gateway pattern. Router aliases such as `deepseek-flash-latest`
resolve to their base model before the limit check.
`CLAUDE_CODE_SUBAGENT_MODEL` never gets `[1m]` — Claude Code forwards that value verbatim.
The `[1m]` tag is Claude Code only; other harnesses (Cursor, etc.) should use the bare
model ID without the suffix.

### Text-only models and images

Claude Code has no way to mark a model as non-vision. Pasting or attaching an image while a
text-only slot is active can break the session — recover with `/rewind`. Activation prints a
one-line warning:

```text
Text-only: deepseek-flash-latest, glm-fast-latest · Avoid images; recover with /rewind.
```

The wizard and `fireconnect claude status` label every model `vision` or `text-only`.

### Pricing estimates

Claude Code's `/model` picker and session cost estimates use **Anthropic list prices**, while
Fireworks bills at **serverless rates** — the in-app estimate can look far higher than your real
bill. Use `fireconnect claude status` and `fireconnect model list` for Fireworks rates, check
[serverless pricing](https://docs.fireworks.ai/serverless/pricing), and see the
[billing dashboard](https://app.fireworks.ai/account/billing) for actual spend.

## Codex

Routes [OpenAI Codex CLI](https://developers.openai.com/codex) through Fireworks via the
Responses API.

```bash
fireconnect codex                       # writes ~/.codex/config.toml
fireconnect codex status
fireconnect codex --model glm-latest      # switch model
fireconnect codex off
```

- Sets root `model_provider` / `model` for Codex 0.134+ (short slug) and adds a
  `[model_providers.fireworks-ai]` block with `wire_api = "responses"` and a **baked**
  `experimental_bearer_token` literal (mode `0600`). No shell hook needed.
- Writes the preferred serverless catalog to `~/.codex/fireworks-model-catalog.json` and points
  Codex at it via `model_catalog_json` (latest aliases preferred; embeddings, no-tool, and
  deprecated models filtered out). `off` removes the file and reference.
- Preserves unrelated settings (for example `[[mcp_servers]]`) via surgical TOML edits, and on
  `off` reconciles the shell hook when nothing else needs `FIREWORKS_API_KEY`.

> **MiniMax is not supported on Codex.** Codex may insert assistant messages between
> `tool_calls` and `tool_results`, which MiniMax chat templates reject. FireConnect fails
> `codex --model minimax-latest` with an explanation. Use MiniMax on a Chat Completions harness
> such as Claude Code or OpenCode.

`config.toml` updates immediately; exit Codex and `codex resume <id>` (or start a new session)
to pick up the change. Use `--config-path <path>` for a non-default config.

## OpenCode

Routes [OpenCode](https://opencode.ai) through Fireworks.

```bash
fireconnect opencode
fireconnect opencode status
fireconnect opencode --model glm-latest
fireconnect opencode off
```

- Merges a `provider.fireworks-ai` block into `~/.config/opencode/opencode.json`, sets the
  default `model` to `fireworks-ai/<slug>`, and keys provider models by short slug.
  `options.apiKey` is a **baked plaintext literal** (mode `0600`).
- Registers the preferred serverless catalog in the provider's `models` for OpenCode's `/model`
  picker, falling back to the active model when the catalog can't be fetched (offline).

Use `--config-path <path>` for a non-default config.

## Pi

Routes [Pi](https://pi.dev) through Fireworks.

```bash
fireconnect pi
fireconnect pi status
fireconnect pi --model glm-latest
fireconnect pi off
```

- Sets `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` and stores a **baked
  plaintext literal** in `fireworks.key` (`auth.json`, mode `0600`). `on` applies
  `kimi-fast-latest` unless you pass `--model`.
- Registers the preferred serverless catalog in `~/.pi/agent/models.json` for Pi's `/model`
  picker. Managed IDs are canonical `accounts/fireworks/...` ids, so each entry overrides Pi's
  built-in catalog row in place with context, pricing, reasoning, and vision metadata from the
  shared Fireworks specs. Falls back to the last cached catalog offline.
- Snapshots and restores all three files (`settings.json`, `auth.json`, `models.json`). The
  registered model ids are tracked in `~/.fireconnect/config.json`
  (`harnesses.pi.profiles.managedModelIds`) so repeat `on` rebuilds exactly and `off` strips
  only what FireConnect added.

Use `--settings-path <path>` for a non-default settings file.

## Cursor

Cursor stores AI settings in SQLite (`state.vscdb`), so FireConnect writes there directly:

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
fireconnect cursor off
```

`cursor --model <id>` registers the model and sets **every mode that already exists** in
`modelConfig` — it won't create modes you don't have. Direct Fireworks IDs are stored as short
slugs; legacy canonical entries migrate on the next `on`.

> **Quit Cursor (`Cmd-Q` / File > Quit) before `on` or `off`.** Otherwise Cursor's in-memory
> state overwrites the write on its next flush. In an interactive terminal FireConnect waits for
> you to quit (press Enter to confirm, or auto-detect); after ~90s it offers continue-anyway.
> `--force` writes anyway.

**While FireConnect is on, only Fireworks models work** — Cursor's built-in models (Auto,
subscription models, Opus modes) are hidden from the picker and won't respond.
`fireconnect cursor off` restores them, and only removes models FireConnect registered.

## VS Code Chat

FireConnect adds a `Fireworks` provider to `chatLanguageModels.json` (vendor `customendpoint`,
`apiType: chat-completions`) pointing at `https://api.fireworks.ai/inference` — VS Code appends
`/v1/chat/completions`. Azure/Foundry mode also uses `apiType: chat-completions`.

```bash
fireconnect vscode --api-key fw_...       # quit VS Code first
fireconnect vscode status                 # read-only; safe while VS Code is open
fireconnect vscode --model deepseek-flash-latest
fireconnect vscode off
```

The API key is **not** in the JSON: VS Code resolves `${input:chat.lm.secret.<id>}` through
Electron `safeStorage` in its application-scoped `state.vscdb`. `on` writes both the provider
entry and the encrypted key under a `chat.lm.secret.fw-*` id. Same quit / `--force` rules as
Cursor.

`safeStorage` by platform:

- **macOS** — master key in the login Keychain (`<App> Safe Storage`); open VS Code once first.
  Insiders is auto-detected (`Code - Insiders Safe Storage`).
- **Windows** — AES-256-GCM with a DPAPI-protected key in VS Code's `Local State`.
- **Linux** — needs `libsecret` (`secret-tool`) for real encryption. Without it Chromium falls
  back to a hardcoded password (obfuscated, not encrypted); FireConnect still writes and warns.

`off` restores `chatLanguageModels.json` byte-for-byte and deletes the `chat.lm.secret.fw-*`
row; providers you configured yourself are preserved.

Per-model `toolCalling` / `vision` / token limits live in
`packages/setup-cli/lib/fireworks/model-specs.mjs`. Unmapped models default to
`toolCalling: true`, `vision: false`, with limits omitted until the model is added.

## DeepSeek Harness

Routes [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) through Fireworks
via a custom OpenAI-compatible provider in `$DSH_HOME` (default `~/.dsh`).

```bash
fireconnect deepseek
fireconnect deepseek status
fireconnect deepseek --model glm-latest
fireconnect deepseek off
```

- Writes `llm-pi-ai.providers.fireworks` and `agent-default-model` into `~/.dsh/settings.yaml`
  pointing at `https://api.fireworks.ai/inference/v1`.
- Stores the Fireworks key as `FIREWORKS_API_KEY` in `~/.dsh/.credentials.yaml` (mode `0600`).
- Sets the default model for new sessions to the selected Fireworks model.

Use `--config-path <path>` for a non-default `settings.yaml` (credentials stay beside that file).

## FireRouter

FireRouter is a judge-model router: simpler requests go to cheaper models, harder ones pass
through. It's a normal **`firerouter` model** on the Fireworks gateway — not a separate mode.
Select it like any other model.

```bash
fireconnect <harness> --model firerouter       # any harness
fireconnect claude --opus firerouter           # or a single Claude slot
```

| | |
|--|--|
| **Keys** | Standard Fireworks (`fw_...`) only — not Fire Pass |
| **Catalog** | Always in `fireconnect model list` for a standard key |
| **Pickers** | Auto-included with workspace BYOK (`enable-workspace-byok`), or a forwardable `sk-ant-...` `ANTHROPIC_API_KEY` on harnesses that can attach one |
| **Auto default** | Claude Code `main` only — first connect, FireRouter auth present, no explicit model flags |
| **No Anthropic key** | Still routes among Fireworks models |

**BYOK for Anthropic frontier models.** With workspace BYOK, your Anthropic key is used
server-side — no extra flags. Otherwise pass `--anthropic-api-key sk-ant-...` (or export
`ANTHROPIC_API_KEY`) on a harness that can forward it. OpenAI BYOK is not supported.

| Harness | Local Anthropic BYOK | `--routing-preference` | Notes |
|---------|----------------------|------------------------|-------|
| Claude Code | Header value | Yes | Fireworks header still wins for gateway auth; only harness that can auto-default `main` |
| OpenCode | Header value | Yes | `--model firerouter` registers only that model |
| Pi | Header value | Yes | Same Fireworks provider as other Pi models |
| VS Code | Header value | Yes | Same provider (`apiType: chat-completions`) |
| Codex | `ANTHROPIC_API_KEY` env reference | No | Export the key, or use workspace BYOK |
| Cursor | Workspace BYOK only | No | Override UI can't attach a local Anthropic key |
| DeepSeek Harness | Workspace BYOK only | No | Same BYOK shape as Cursor |

Tune the cost/quality tradeoff where supported:

```bash
fireconnect claude --opus firerouter --routing-preference balanced
# max-intelligence (1) · more-intelligence (2) · balanced (3) · more-savings (4) · max-savings (5)
```

> The old `--router` flag is retired — use `--model firerouter` or a Claude slot flag.

More detail: [FireRouter overview](https://docs.fireworks.ai/ecosystem/firerouter/overview).

## Models

```bash
fireconnect model list
fireconnect model list --search glm
fireconnect model list --json
```

Fetches coding-tagged serverless models (`GET /v1/serverless/models?use_cases=coding`), adds the
per-model fast routers the API reports, and merges version-tracking aliases whose targets are
present: `glm-latest`, `glm-fast-latest`, `kimi-latest`, `kimi-fast-latest`, `minimax-latest`,
`qwen-plus-latest`. Every row is tagged `serverless`.

Key resolution order: `--api-key` → `FIREWORKS_API_KEY` → stored credential. Standard keys
include `firerouter`; Fire Pass keys show only Fire Pass-supported routers (`glm-latest`,
`glm-fast-latest`, `glm-5p2-fast`, `kimi-fast-latest`).

| Command | Shows |
|---------|--------|
| `fireconnect claude status` | Provider, auth, alias mapping, **Fireworks rates** per slot |
| `fireconnect model list` | Serverless catalog with **IN / OUT pricing** where known |

Short IDs and canonical `accounts/fireworks/...` IDs both work, and `-latest` router aliases
(`glm-latest`, `kimi-fast-latest`, …) are recommended over pinned versions so you track new
releases automatically. Most non-Claude harnesses store short slugs; Pi stores canonical
`accounts/fireworks/...` ids — legacy configs migrate to each harness's format on the next
`on`. Not sure what to pick? Start from [the defaults](#default-models), browse
`fireconnect model list`, or run `fireconnect claude --interactive`. Foundry (Azure) uses
deployment names instead — see [Azure](#azure-microsoft-foundry-endpoints).

## Azure (Microsoft Foundry) endpoints

Fireworks models are also first-party models inside
[Microsoft Foundry](https://docs.fireworks.ai/ecosystem/integrations/azure-foundry), billed
through Azure and counting toward your MACC. Foundry exposes an **OpenAI-compatible** endpoint,
so **OpenCode, Codex, Pi, Cursor, and VS Code** can route there instead of the
Fireworks gateway.

Configure once, then `<harness> on` uses it — no per-command flags:

```bash
fireconnect configure --provider azure \
  --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key>

fireconnect opencode      # routes through the configured Foundry endpoint
fireconnect codex
```

`configure` stores a top-level `provider` and `azure` endpoint in `~/.fireconnect/config.json`.
Switch back with `fireconnect configure --provider fireworks ...`. You can also opt in per
command (or override the configured endpoint) with `--azure`:

```bash
fireconnect opencode --azure --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key> --model FW-GLM-5.2
```

- **Endpoint.** FireConnect normalizes whatever you paste — bare resource root, portal project
  endpoint (`.../api/projects/<name>`), or the `/models` route — to
  `https://<resource>.services.ai.azure.com/openai/v1`. Find it in the Foundry portal under
  **Project settings**.
- **Auth.** Use your **Azure** API key (not `fw_`/`fpk_`). `--api-key` writes it literally;
  exporting `AZURE_API_KEY` writes an environment reference instead.
- **Model.** The id is your Foundry **deployment** name — the catalog model name without the
  `fireworks-ai/` prefix (e.g. `FW-GLM-5.2`, `FW-MiniMax-M2.5`). Defaults to `FW-GLM-5.2`.
- **Isolation.** Each harness writes a dedicated `fireworks-azure` provider separate from the
  Fireworks gateway; `off` restores byte-for-byte and switching modes replaces it cleanly.

| Harness | Writes | Provider |
|---------|--------|----------|
| OpenCode | `provider.fireworks-azure` in `opencode.json` (`@ai-sdk/openai-compatible`, `options.baseURL` + `options.apiKey`) | `fireworks-azure/<deployment>` |
| Codex | `[model_providers.fireworks-azure]` in `config.toml` (`wire_api = "chat"`, bearer or `env_key = "AZURE_API_KEY"`) | `fireworks-azure` |
| Pi | custom `openai-completions` provider in `models.json` (`baseUrl`, `authHeader`, `apiKey` literal or `$AZURE_API_KEY`) + `defaultProvider` in `settings.json` | `fireworks-azure` |
| Cursor | OpenAI-compatible URL, deployment, and key in `state.vscdb` | `<deployment>` |
| VS Code | custom endpoint model in `chatLanguageModels.json`; key in `safeStorage` | `<deployment>` |

`fireconnect <harness> status` reports `azure` as the provider with the endpoint and model.

> Claude Code is intentionally excluded: it speaks the Anthropic Messages API, which Foundry
> does not expose. `model list` reads the Fireworks catalog and isn't used in Azure mode —
> select a deployment with `--model`.

## CLI reference

Harness-first: `fireconnect <harness> <command>`, plus a few global commands.

**Per harness** (`claude`, `opencode`, `codex`, `pi`, `cursor`, `vscode`, `deepseek`)

```text
fireconnect <harness> on           Route the harness through Fireworks (default if no command).
fireconnect <harness> off          Restore your previous provider/config.
fireconnect <harness> status       Show the provider, auth, and model mapping.
fireconnect <harness> help         Show help for that harness.
```

All model changes go through `<harness> on`. Claude adds `fireconnect claude usage`, `fireconnect claude live`, and `fireconnect claude demo`.

**Global**

```text
fireconnect login                  Sign in — browser (creates a key) or paste a key you have.
fireconnect logout                 Clear the stored key (keychain entry + config ref).
fireconnect status                 Show sign-in state, machine environment, and key storage.
fireconnect model list             Browse the serverless catalog.
fireconnect configure              Set the provider (Azure/Foundry) and the Anthropic key.
fireconnect claude demo              Race two models on the same prompt via Claude Code.
fireconnect upgrade                Update FireConnect.
fireconnect uninstall              Disable + restore all harnesses, then remove FireConnect.
fireconnect --version              Print the installed CLI version (-V; --json for machine-readable).
fireconnect help                   Show help.
```

`login` asks one question: create an API key for this machine, or paste one you already have.
Create opens the browser, mints `fireconnect-{hostname}`, and stores it in the OS keychain —
confirming the account and where the key went. Paste masks input, validates live, and stores
only on success. `--paste` skips the chooser; `--with-token` reads from stdin (CI).

`logout` removes the local key and offers to revoke the machine key server-side (`--revoke` /
`--keep-key` skip the question). You don't have to start with `login` — `fireconnect claude`
runs the same sign-in inline when a key is needed.

## Keys and storage

- `~/.fireconnect/config.json` holds a **reference** (`{keychain:fireworks-api-key}`), never a
  literal key. Legacy installs may still have `{env:FIREWORKS_API_KEY}`.
- The key itself lives in the OS keychain, or an encrypted-file / plaintext fallback tier when
  no secret service is available (`fireconnect status` reports which).
- Harness configs hold **baked literals** for Claude's custom header, Codex, OpenCode, Pi, and
  DeepSeek Harness; Cursor and VS Code use IDE `safeStorage`.
- Claude websearch MCP no longer uses a shell hook — the Bearer token is baked into
  `~/.claude.json`. Re-running `install.sh` or `fireconnect upgrade` shares one finalize path
  that rebakes enabled harness configs (and any existing websearch entry) to literals, including
  legacy env-reference auth left on disk.

**`FIREWORKS_API_KEY` interaction.** The env var and FireConnect-managed storage are mutually
exclusive for **login and other explicit store paths**. When it's set, `login` verifies and uses
it without copying it into the secret store, and combining `login` with a key-storing option
(`--api-key`, `--with-token`, browser, paste) fails before anything changes — unset the variable
first. `<harness> on` may still read it, persist it, and bake it into that harness's config.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool still uses the old model or provider | Fully restart the harness. In Claude Code, exit and `claude --resume <id>` — settings apply per session. |
| Cursor / VS Code changes don't stick | Quit the IDE (`Cmd-Q`) **before** `on`/`off`; the running app flushes its own state over yours. |
| Only Fireworks models respond in Cursor | Expected while FireConnect is on. `fireconnect cursor off` restores built-in models. |
| Claude session breaks after pasting an image | A [text-only](#text-only-models-and-images) slot was active. `/rewind`, then map that slot to a vision model. |
| Claude Code shows a scary cost estimate | It uses [Anthropic list prices](#pricing-estimates). Check `fireconnect claude status` for real Fireworks rates. |
| `firerouter` missing from a picker | Needs workspace BYOK or a forwardable `ANTHROPIC_API_KEY`; otherwise select it explicitly with `on --model firerouter`. Not available on Fire Pass keys. |
| `login` fails with a key-storage conflict | `FIREWORKS_API_KEY` is set. Unset it to let FireConnect store a key. |
| `/model` picker ignores your main model | A legacy `env.ANTHROPIC_MODEL` is overriding it — re-run `fireconnect claude` once to migrate. |
| PowerShell install fails (`set: pipefail\r`) | Install from [Git Bash](#install-notes). |
| Linux warns the key isn't encrypted | Install `libsecret` (`secret-tool`); Chromium's fallback is obfuscation, not encryption. |
| Something else | `fireconnect status` shows sign-in, environment, storage tier, and every harness's state. |

## Upgrade and uninstall

```bash
fireconnect upgrade
# or re-run the installer:
sh -c "$(curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh)"
```

Interactive terminals also offer an upgrade prompt when a newer version is cached
(`Upgrade now?`); declining snoozes it for a day.

Upgrading from **before 0.9.0** with Claude Code connected asks before temporarily restoring
your original settings, then tells you to reconnect with `fireconnect claude`. From **0.9.0**
onward, reinstall and upgrade leave harness settings alone. Other harness settings and your
stored API key are preserved either way.

```bash
fireconnect uninstall    # restores every harness, then removes ~/.fireconnect and the launcher
```
