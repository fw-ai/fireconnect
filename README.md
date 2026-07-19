# FireConnect

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/fw-ai/fireconnect/blob/main/LICENSE)

> Use [Fireworks AI](https://fireworks.ai) models in Claude Code, OpenCode, Codex, Pi, Cursor, VS Code, and Deep Agents.

**Install in one line:**

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh)"
```

Or with `bash` directly:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash
```

Install the `fireconnect` CLI once, then use it to manage Fireworks routing for Claude Code, OpenCode, Codex, Pi, Cursor, VS Code, and Deep Agents. Run `fireconnect help` to see what it can do.

## Quick Setup

Run this from a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash
```

The installer installs the `fireconnect` CLI; it does not prompt for a key. Once it finishes, sign in and enable a harness:

```bash
fireconnect login        # guided sign-in (browser or paste a key)
fireconnect claude on    # route Claude Code through Fireworks
```

Fire Pass users can use a `fpk_...` key directly — FireConnect detects the key type and uses the correct defaults for Fire Pass (`glm-fast-latest` for all aliases).

If you prefer installing from an SSH checkout:

```bash
mkdir -p ~/.fireconnect && git clone git@github.com:fw-ai/fireconnect.git ~/.fireconnect && bash ~/.fireconnect/install.sh
```

The installer:

- Requires Node.js 18+. If it's missing or too old, installs it with Homebrew on macOS or prints upgrade instructions (nvm / nodejs.org / NodeSource) elsewhere.
- Clones the FireConnect CLI source to `~/.fireconnect/cli` and runs `npm install --omit=dev` for its one runtime dependency (`cross-keychain`, used for secure API-key storage).
- Installs the `fireconnect` CLI launcher to `~/.local/bin` and adds it to your shell `PATH`.

It does **not** sign you in or write any harness settings — run `fireconnect login` then `fireconnect <harness> on` (e.g. `claude`, `opencode`, `codex`, `pi`, `cursor`, `vscode`, `deepagents`) after it finishes, then fully restart that tool.

Default models (Claude Code):

```text
main     -> glm-fast-latest
opus     -> glm-fast-latest
fable    -> glm-fast-latest
sonnet   -> glm-5p1
haiku    -> deepseek-v4-flash
subagent -> deepseek-v4-flash
```

## Manual Setup

Create a Fireworks API key here:

```text
https://app.fireworks.ai/settings/users/api-keys
```

Then enable Fireworks routing from a terminal:

```bash
fireconnect login                        # sign in (browser or paste); stores the key in the OS keychain
fireconnect claude on                    # uses apiKeyHelper (no literal key in settings)
```

Restart Claude Code after this completes.

## What Gets Written

The setup writes these Claude Code settings (no literal API key in the file — the key lives in the OS keychain and is fetched at runtime via `apiKeyHelper`):

```json
{
  "apiKeyHelper": "/path/to/fireconnect key export",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.fireworks.ai/inference",
    "ANTHROPIC_MODEL": "accounts/fireworks/routers/glm-fast-latest[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "accounts/fireworks/routers/glm-fast-latest[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "accounts/fireworks/models/glm-5p1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "accounts/fireworks/models/deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "accounts/fireworks/routers/glm-fast-latest[1m]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "accounts/fireworks/models/deepseek-v4-flash"
  }
}
```

Claude Code calls `apiKeyHelper` at runtime to fetch the key from the OS keychain. It saves a backup of your previous provider settings so `fireconnect claude off` can restore them.

Short model IDs are accepted everywhere. For example, `glm-fast-latest` is written to Claude Code settings as `accounts/fireworks/routers/glm-fast-latest[1m]`.

### Cursor IDE

Cursor stores its AI settings in a SQLite database (`state.vscdb`), not a JSON file, so the Cursor harness writes there directly:

- API key -> `cursorAuth/openAIKey`
- Base URL -> `openAIBaseUrl` (set to `https://api.fireworks.ai/inference/v1`, Cursor's OpenAI-compatible endpoint)
- Custom models -> `aiSettings.userAddedModels` + `aiSettings.modelOverrideEnabled`
- Per-mode model -> `aiSettings.modelConfig[mode]` (e.g. `composer`, `cmd-k`)

`cursor on` sets **every mode that already exists** in `modelConfig` to the default Fireworks model (non-destructive — it won't create mode entries that aren't already there). Use `cursor model select --mode <mode>` to point an individual mode at a different model. `status` lists every supported mode (the valid values for `--mode`, with the default marked) and a human-readable model name per mode (e.g. `GLM 5.2`, `GLM Latest`); `status --json` returns raw ids plus `defaultMode`.

```bash
fireconnect cursor on --api-key fw_...   # quit Cursor first; sets all existing modes
fireconnect cursor status                # read-only; works while Cursor is open
fireconnect cursor model list --search glm
fireconnect cursor model select --mode composer
fireconnect cursor off                   # restores your previous settings
```

**Quit Cursor (`Cmd-Q` / File > Quit) before `on`, `off`, `model select`, `model add`, or `model reset`** — otherwise Cursor's in-memory state overwrites the write on next flush. In an interactive terminal, if Cursor is still running fireconnect asks you to quit it and **press Enter to continue**; if Cursor is still running after that it errors out (it does not close or reopen Cursor for you). Non-interactive use (piped/CI) still requires Cursor to be quit ahead of time. `status` and `model list` are read-only and work any time. Pass `--force` to write anyway without waiting. `off` only removes models FireConnect registered (tracked under `aiSettings.fireconnectAddedModels`); your own custom models are preserved.

### VS Code Chat

VS Code Chat's custom language models are configured in `chatLanguageModels.json` (a JSON array of providers). fireconnect adds a `Fireworks` provider (vendor `customendpoint`, `apiType: chat-completions`) whose models point at `https://api.fireworks.ai/inference` (VS Code appends `/v1/chat/completions`).

The API key is **not** stored in the JSON — VS Code resolves the `${input:chat.lm.secret.<id>}` reference through its secret storage, which keeps the key as an Electron `safeStorage`-encrypted blob inside VS Code's application-scoped `state.vscdb` (SQLite `ItemTable`, key `secret://<id>`). `fireconnect vscode on` writes both: the provider entry to `chatLanguageModels.json` and the encrypted key to `state.vscdb` under a `chat.lm.secret.fw-*` id.

```bash
fireconnect vscode on --api-key fw_...    # quit VS Code first
fireconnect vscode status                 # read-only; works while VS Code is open
fireconnect vscode model list --search glm
fireconnect vscode model add deepseek-v4-flash
fireconnect vscode model select
fireconnect vscode off                    # restores chatLanguageModels.json + removes the key
```

**Quit VS Code (`Cmd-Q` / File > Quit) before `on` or `off`** — those write `state.vscdb`, which a running VS Code owns (it loads the DB into memory at startup and rewrites it on exit, so the write would be silently lost). Pass `--force` to write anyway. `model add` / `model select` / `model reset` only edit `chatLanguageModels.json`, which VS Code hot-reloads via a file watcher — so those take effect immediately in the Chat picker and only warn if VS Code is running (concurrent-edit clobber risk). `status` and `model list` are read-only and work any time.

Per-model `toolCalling`/`vision`/`maxInputTokens`/`maxOutputTokens` are defined alongside serverless pricing in `packages/setup-cli/lib/fireworks-model-specs.mjs` (sourced from the Fireworks model library and API). Unmapped models default to `toolCalling: true` and `vision: false`; token limits are omitted until the model is added to the specs registry. VS Code sends `maxOutputTokens` as `max_output_tokens`, so mapped values must not exceed the model limit.

On macOS, `safeStorage` encrypts with a master key VS Code stores in the login Keychain under "<App> Safe Storage" (e.g. `Visual Studio Code Safe Storage`); opening VS Code once creates it, so the first `on` may need that. Insiders is detected automatically (it reads `Code - Insiders Safe Storage` and targets the Insiders `state.vscdb`); `--vscode-path` pointing inside an Insiders user-data dir is also inferred. On Windows, `safeStorage` uses AES-256-GCM with a DPAPI-protected key stored in VS Code's `Local State` file — opening VS Code once creates the key. On Linux, `safeStorage` needs `libsecret` (`secret-tool`) for real encryption — without it, Chromium falls back to a hardcoded password (obfuscated, not encrypted), which fireconnect still writes but warns about. `off` restores your original `chatLanguageModels.json` byte-for-byte and deletes the `chat.lm.secret.fw-*` secret row from `state.vscdb`; any providers you configured manually are preserved.

### FireRouter mode

`fireconnect vscode on --router` retargets VS Code Chat at FireRouter so it speaks the **Anthropic Messages** wire format (`https://router.fireworks.ai/v1/messages`) and routes Anthropic models server-side. This requires both a Fireworks key and an Anthropic key:

```bash
fireconnect vscode on --router --api-key fw_... --anthropic-api-key sk-ant-...
fireconnect vscode status
fireconnect vscode off
```

VS Code's custom endpoint resolves exactly **one** credential from secret storage (the provider `apiKey`), so FireRouter's two-header auth can't both be encrypted. In `messages` mode VS Code auto-sends `x-api-key: <apiKey>`, so fireconnect uses **Layout A**:

- the **Anthropic key** is stored encrypted in `state.vscdb` under the `chat.lm.secret.fw-*` row (the `apiKey` field);
- the **Fireworks key** is written as a **plaintext literal** in each model's `requestHeaders["X-FireRouter-Fireworks-Key"]`.

This mirrors Claude Code's router mode (which also writes the Fireworks key in plaintext). The Anthropic key — the more expensive credential — stays encrypted. The provider is written with `apiType: "messages"` and each model's `url` points at `…/v1/messages`. Fire Pass keys are rejected (router mode is Anthropic-only).

`on --router` registers the Claude models FireRouter advertises — **pick one in the VS Code Chat picker**. Because VS Code has no built-in Anthropic catalog to override (unlike the Pi harness), fireconnect enumerates them itself: it reads FireRouter's published catalog (`https://router.fireworks.ai/.well-known/opencode.json`, the `firerouter` provider's models), keeps the Claude models (the Messages endpoint is Anthropic-format), and collapses near-duplicate `[1m]` context variants and dated snapshots onto their plain alias. If the catalog can't be fetched (offline), it falls back to a bundled default set (`claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`). Pin an explicit list with `FIRECONNECT_ROUTER_MODELS=id1,id2` to skip the network. `--main` and the model commands (`list`/`select`/`add`/`reset`) are disabled in router mode; model choice lives entirely in the Chat picker. Switching between `on` (direct) and `on --router` cleanly replaces the model set — a direct→router switch drops the Fireworks models for the advertised Claude set, and router→direct drops the router-shaped models. `off` restores your `chatLanguageModels.json` byte-for-byte and removes the secret.


## Browsing and Picking Models

After `fireconnect claude on`, FireConnect prints hints for browsing the Fireworks catalog and
picking a model interactively.

```bash
fireconnect claude model list                 # browse callable serverless endpoints
fireconnect claude model select               # pick a model for Claude Code
fireconnect claude model select --slot sonnet # update one Claude Code alias
fireconnect opencode model select             # pick OpenCode's default model
fireconnect codex model select                # pick Codex's default model
fireconnect cursor model select --mode composer # pick Cursor's composer model
```

### `fireconnect <harness> model list`

Harness-scoped: lists the Fireworks serverless catalog using the API key resolved from that
harness. Fetches serverless models from the Fireworks API (`supports_serverless=true`) and merges
the known public platform routers (`glm-latest`, `glm-fast-latest`, `glm-5p2-fast`, `kimi-fast-latest`, `kimi-latest`, `kimi-k2p6-turbo`, and `kimi-k2p7-code-fast`). Every row is
tagged `serverless` (on-demand endpoints will be added later).

```bash
fireconnect claude model list
fireconnect claude model list --search glm
fireconnect opencode model list --json
```

Resolves the key in documented order: `--api-key`, then `FIREWORKS_API_KEY`, then the OS
keychain, then legacy harness/global refs. Non-Fireworks-shaped keys (for example
Anthropic `sk-ant-...`) are skipped when resolving harness-local keys.

Fire Pass keys (`fpk_...`) show Fire Pass-supported routers: `glm-latest`, `glm-fast-latest`, `glm-5p2-fast`, `kimi-fast-latest`, and `kimi-k2p7-code-fast`.

### `fireconnect <harness> model select`

Interactive picker. Requires a terminal and Fireworks to be enabled for that harness.

**Claude Code** — pick one of six aliases (`main`, `opus`, `fable`, `sonnet`, `haiku`, `subagent`):

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

**Cursor** — pick a Cursor mode (`composer`, `cmd-k`, `background-composer`, …); defaults to `composer` (no `--slot`):

```bash
fireconnect cursor model select
fireconnect cursor model select --mode composer --search glm
```

**VS Code** — pick a model to add to the Fireworks provider (no `--slot`/`--mode`):

```bash
fireconnect vscode model select
fireconnect vscode model select --search glm
```

### `fireconnect claude status` vs `fireconnect claude model list`

| Command | Shows |
|---------|--------|
| `fireconnect claude status` | Your current provider, auth, configured alias mapping, and **Fireworks serverless rates** per slot |
| `fireconnect claude model list` | Available serverless endpoints from the Fireworks API, with **IN / OUT pricing** where known |

### Claude Code pricing estimates (important)

Claude Code’s `/model` picker and session cost estimates use **Anthropic list prices** (for
example **$5 / $25 per Mtok** on the default Opus-style mapping for `glm-fast-latest`). **Fireworks
bills at serverless model rates** (for example about **$2.10 / $6.60 per Mtok** for GLM 5.2 Fast on
standard serverless) — the UI estimate can be much higher than your real bill.

FireConnect cannot override Claude Code’s price column. Use `fireconnect claude status` and
`fireconnect claude model list` for Fireworks rates, and check the
[Fireworks billing dashboard](https://app.fireworks.ai/account/billing) for actual spend.

Full explanation: [docs/claude-code-pricing.md](docs/claude-code-pricing.md).

After `fireconnect claude on`, `model select`, or `model reset`, `settings.json` is updated
immediately. To use the new model in Claude Code, run `/model` to activate it in the same
session, start a new session, or `/exit` and resume the conversation with `claude --resume <id>`.

### Recommended model slugs

Short IDs are accepted everywhere and are normalized to their full paths automatically.

| Short ID | Best for | Notes |
|----------|----------|-------|
| `glm-latest` | All-around use, agentic tasks | Version-tracking router; strong reasoning, 1M context. |
| `glm-fast-latest` | Latency-sensitive agentic use | Default for `main`, `opus`, and `fable` slots. Version-tracking router on the high-speed Fast serving path (100+ tok/s), at a higher per-token price. 1M context. |
| `glm-5p2-fast` | Latency-sensitive agentic use | Same as `glm-fast-latest` but pinned to GLM 5.2 rather than version-tracking. 1M context. |
| `glm-5p1` | General use (lighter) | Default `sonnet` slot. Good balance of speed and quality. |
| `deepseek-v4-flash` | Background / fast tasks | Default `haiku` and `subagent` slots. Lowest latency. |

**Fire Pass keys** (`fpk_...`): all slots default to `glm-fast-latest`.

**Switching a single slot** (Claude Code only):

```bash
fireconnect claude model select --slot opus    # pick a model interactively
fireconnect claude model select --slot sonnet  # pick general model interactively
fireconnect claude on --sonnet glm-5p1 --haiku deepseek-v4-flash  # set non-interactively
```

**OpenCode and Pi** use a single default model; use `fireconnect <harness> model select` or pass `--main <slug>` to `on`.

## FireConnect CLI

The CLI is harness-first: `fireconnect <harness> <command>`. A handful of commands are
global (no harness). Commands below are listed in the same order as `fireconnect help`.

**Global**

```text
fireconnect login                  Sign in — browser (creates a key) or paste a key you have.
fireconnect logout                 Clear the stored key (keychain entry + config ref).
fireconnect status                 Show sign-in state (signed in as whom) and where the key is stored.
fireconnect configure              Set the provider (Azure/Foundry) and the Anthropic key.
fireconnect demo                   Race your provider vs Fireworks GLM 5.2 Fast on the same prompt.
fireconnect upgrade                Pull the latest FireConnect from GitHub; re-probe secret storage.
fireconnect uninstall              Disable + restore all harnesses, then remove FireConnect.
fireconnect --version              Print the installed CLI version (-V; --json for machine-readable).
fireconnect help                   Show help.
```

`login` asks the one question that matters: create an API key for this
machine, or paste one you already have. Create opens the browser (sign-in or
sign-up), mints `fireconnect-{hostname}`, and stores it in the OS keychain —
confirming the account it belongs to and exactly where the key went. Paste
walks you to the key page, masks the pasted key, validates it live, and
stores it only on success. `--paste` skips the chooser and goes straight to
pasting; `--with-token` reads a key from stdin (CI). Everything is reversible
and says so: `logout` removes the local key and offers to revoke the machine
key server-side (`--revoke`/`--keep-key` skip the question); `<harness> off`
restores the backed-up settings. You don't have to start with `login` — a
key-needing command like `fireconnect claude on` runs the same sign-in
inline, then finishes the job. Staging and history: `login_roadmap.md`.

Recommended flow:

```bash
fireconnect login                        # guided sign-in (browser or paste)
fireconnect claude on                    # Claude uses apiKeyHelper (no literal key in settings)
fireconnect codex on                     # Codex/OpenCode/Pi: env ref + shell hook (keychain mode)
source ~/.zshrc                          # load FIREWORKS_API_KEY for Codex/OpenCode/Pi
```

`~/.fireconnect/config.json` stores `{keychain:fireworks-api-key}` or `{env:FIREWORKS_API_KEY}` — never a literal key.
`<harness> on` validates credentials and writes env references in harness configs.

**Per harness** (`claude`, `opencode`, `codex`, `pi`, `cursor`, `vscode`, `deepagents`)

```text
fireconnect <harness> on           Route the harness through Fireworks (default if no command).
fireconnect <harness> off          Restore your previous provider/config.
fireconnect <harness> status       Show the provider, auth, and model mapping.
fireconnect <harness> model list   Browse serverless Fireworks models.
fireconnect <harness> model select Interactive model picker.
fireconnect <harness> model reset  Reset models to defaults.
fireconnect <harness> help         Show help for that harness.
```

Claude Code also has `fireconnect claude usage` (estimate usage cost from a session log). Cursor and VS Code also have `fireconnect <harness> model add <id>` (register a model in the picker without changing the active selection).

Run `fireconnect help` for the overview, or `fireconnect <harness> help` (e.g. `fireconnect claude help`, `fireconnect cursor help`, `fireconnect vscode help`, `fireconnect deepagents help`) for everything available at the harness level.

## Codex Harness

FireConnect routes [OpenAI Codex CLI](https://developers.openai.com/codex) through Fireworks via the Responses API:

```bash
fireconnect login
fireconnect codex on                  # route Codex through Fireworks (~/.codex/config.toml)
fireconnect codex status              # check current provider and model
fireconnect codex on --main glm-5p1   # switch model (non-interactive)
fireconnect codex model select        # switch model (interactive)
fireconnect codex off                 # restore your original config
source ~/.zshrc                       # keychain mode: load FIREWORKS_API_KEY for Codex
```

What it does:

- Sets root `model_provider` / `model` for Codex 0.134+ and adds a
  `[model_providers.fireworks-ai]` block with `wire_api = "responses"` and
  `env_key = "FIREWORKS_API_KEY"`. Harness configs never contain literal keys.
- In keychain mode, installs a marked block in `~/.zshrc` (or bash profile) that exports
  `FIREWORKS_API_KEY="$(fireconnect key export)"`. Open a new terminal or `source` your profile.
- Snapshots your original `~/.codex/config.toml` before the first change. `fireconnect codex off`
  restores it byte-for-byte and removes the shell hook when no env-based harnesses remain.
- Preserves unrelated Codex settings (for example `[[mcp_servers]]`) via surgical TOML edits.

After `fireconnect codex on`, `off`, `model select`, or `model reset`, `config.toml` is updated
immediately. To use the updated routing in Codex, run `/model` to activate it in the same
session, start a new session, or `/exit` and resume the conversation with `codex resume <id>`.

## OpenCode Harness

FireConnect routes [OpenCode](https://opencode.ai) through Fireworks with harness-first commands:

```bash
fireconnect login
fireconnect opencode on                  # route OpenCode through Fireworks
fireconnect opencode status              # check current provider
fireconnect opencode on --main glm-5p1   # switch model (non-interactive)
fireconnect opencode model select        # switch model (interactive)
fireconnect opencode off                 # restore your original config
```

What it does:

- Merges a `provider.fireworks-ai` block into `~/.config/opencode/opencode.json` and sets the
  default `model`. API key is stored as `{env:FIREWORKS_API_KEY}` — never a literal.
- Keychain mode installs the same shell profile hook as Codex so `FIREWORKS_API_KEY` is available
  when you launch OpenCode.
- Snapshots your original `opencode.json` before the first change. `fireconnect opencode off`
  restores it **byte-for-byte**. The snapshot lives in `~/.fireconnect/opencode/`.

Use `--config-path <path>` to target a non-default config file (also handy for testing
without touching your real config). Run `fireconnect help` for the full CLI reference.

OpenCode also supports routing through Fireworks models on Microsoft Foundry (Azure) — see
[Azure (Microsoft Foundry) endpoints](#azure-microsoft-foundry-endpoints).

## Pi Harness

FireConnect routes [Pi](https://pi.dev) through Fireworks with harness-first commands:

```bash
fireconnect login
fireconnect pi on                        # route Pi through Fireworks
fireconnect pi status                    # check current provider
fireconnect pi on --main glm-5p1         # switch model (non-interactive)
fireconnect pi on --router               # route Anthropic models through FireRouter
fireconnect pi model select              # switch model (interactive)
fireconnect pi off                       # restore your original settings and auth
```

What it does:

- Sets `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` and stores the API
  key in `~/.pi/agent/auth.json` (`$FIREWORKS_API_KEY` when from env, literal with
  `--api-key`; never a literal in keychain mode). `on` applies the default model
  (`glm-fast-latest`) unless you pass `--main`.
- Keychain mode installs the shell profile hook so Pi can read `FIREWORKS_API_KEY` at launch.
- Snapshots both files under `~/.fireconnect/pi/` before the first change. `fireconnect pi off`
  restores them **byte-for-byte**. `auth.json` is written at mode `0600`.
- Restart Pi after `on`, `model select`, `model reset`, or `off` when Pi is already running.

### FireRouter mode

`fireconnect pi on --router` overrides Pi's built-in Anthropic provider so its existing
Claude model catalog is sent through `https://router.fireworks.ai/v1`. The Fireworks key
is supplied through `X-FireRouter-Fireworks-Key`; an Anthropic API key is also required:

```bash
fireconnect pi on --router --anthropic-api-key sk-ant-...
fireconnect pi on --router
# Then choose an Anthropic model inside Pi with /model.
```

You can switch among Anthropic models inside Pi without re-running FireConnect. FireConnect
backs up `settings.json`, `auth.json`, and `models.json`, and `fireconnect pi off` restores
all three byte-for-byte. `model select` and `model reset` do not apply in router mode.

> **Note:** In router mode, Pi's `/model` picker still shows Anthropic's built-in model names
> (e.g. `Claude Sonnet 4.5`). The selected name is passed through FireRouter, but the display
> label is Pi's own — it does **not** reflect the Fireworks model actually serving the request
> behind the router. Use `fireconnect pi status` to see the underlying routing.

Use `--settings-path <path>` to target a non-default settings file.

Pi also supports routing through Fireworks models on Microsoft Foundry (Azure) — see
[Azure (Microsoft Foundry) endpoints](#azure-microsoft-foundry-endpoints).

## Azure (Microsoft Foundry) endpoints

Fireworks AI models are also available as first-party models inside
[Microsoft Foundry](https://docs.fireworks.ai/ecosystem/integrations/azure-foundry)
(formerly Azure AI Foundry), where usage is billed through Azure and counts toward your
MACC. Foundry exposes an **OpenAI-compatible** endpoint, so the OpenAI-compatible harnesses
— **OpenCode**, **Codex**, and **Pi** — can route through your Foundry resource instead of
the Fireworks gateway.

**Configure the endpoint once**, then `<harness> on` leverages it — no per-command flags:

```bash
fireconnect configure --provider azure \
  --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key>

fireconnect opencode on   # routes through the configured Foundry endpoint
fireconnect codex on
fireconnect pi on
```

`configure` stores a top-level `provider` and `azure` endpoint in
`~/.fireconnect/config.json`; this design extends to future providers without touching the
harnesses. To switch back, run `fireconnect configure --provider fireworks ...`.

You can also opt in per-command (or override the configured endpoint) with `--azure`:

```bash
fireconnect opencode on --azure --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key> --main FW-GLM-5.1
```

Common behavior across harnesses:

- **Endpoint.** Pass your Foundry endpoint to `--base-url`. FireConnect normalizes whatever
  you paste — the bare resource root, the portal **project endpoint**
  (`.../api/projects/<name>`), or the `/models` route — to the correct resource-root base
  `https://<resource>.services.ai.azure.com/openai/v1`. Find the endpoint in the Microsoft
  Foundry portal under **Project settings**.
- **Auth.** Authenticate with your **Azure** API key (not a `fw_`/`fpk_` key). Pass
  `--api-key` to write it literally, or export `AZURE_API_KEY` to have it written as an
  environment reference instead.
- **Model.** The model id is your Foundry **deployment** name — the catalog model name
  without the `fireworks-ai/` publisher prefix (e.g. `FW-GLM-5.1`, `FW-MiniMax-M2.5`).
  Defaults to `FW-GLM-5.1`; pass `--main <foundry-deployment-name>` to select another.
- **Provider isolation + restore.** Each harness writes a dedicated `fireworks-azure`
  provider distinct from the Fireworks gateway, and `off` restores your original config
  **byte-for-byte**. Switching between Fireworks and Azure modes replaces the managed
  provider cleanly.

Per-harness specifics:

| Harness | Writes | Provider |
|---------|--------|----------|
| OpenCode | `provider.fireworks-azure` in `opencode.json` (`@ai-sdk/openai-compatible`, `options.baseURL` + `options.apiKey`) | `fireworks-azure/<deployment>` |
| Codex | `[model_providers.fireworks-azure]` in `config.toml` (`wire_api = "chat"`, bearer or `env_key = "AZURE_API_KEY"`) | `fireworks-azure` |
| Pi | custom `openai-completions` provider in `models.json` (`baseUrl`, `authHeader`, `apiKey` literal or `$AZURE_API_KEY`) + `defaultProvider` in `settings.json` | `fireworks-azure` |

`fireconnect <harness> status` reports `azure` as the provider along with the endpoint and
model.

> Claude Code is intentionally excluded: its harness speaks the Anthropic Messages API,
> which Foundry does not expose. `model list` / `model select` read the Fireworks catalog
> and are not used in Azure mode — select a Foundry deployment with `--main`.

## Deep Agents Harness

FireConnect routes [LangChain Deep Agents Code](https://docs.langchain.com/oss/python/deepagents/cli) (`dcode`) through Fireworks:

```bash
export FIREWORKS_API_KEY=fw_...
fireconnect deepagents on                # route Deep Agents through Fireworks
fireconnect deepagents status            # check current provider
fireconnect deepagents on --main glm-5p1 # switch model (non-interactive)
fireconnect deepagents model select      # switch model (interactive)
fireconnect deepagents off               # restore your original config
```

What it does:

- Sets `[models].default` to `fireworks:<model>` and configures
  `[models.providers.fireworks]` in `~/.deepagents/config.toml` with the Fireworks
  OpenAI-compatible base URL (`https://api.fireworks.ai/inference`) and
  `api_key_env = "FIREWORKS_API_KEY"`.
- Stores your Fireworks API key in the FireConnect keychain (via `configure` or
  `deepagents on --api-key`) and installs a shell hook that exports
  `FIREWORKS_API_KEY` for `dcode`. FireConnect does not write
  `~/.deepagents/.state/auth.json` — use dcode's `/auth` for credentials stored
  in that file.
- Snapshots `config.toml` under `~/.fireconnect/deepagents/` before the first
  change. `fireconnect deepagents off` restores byte-for-byte.
- Restart `dcode` after `on`, `model select`, `model reset`, or `off`.

Use `--config-path <path>` to target a non-default config file.

