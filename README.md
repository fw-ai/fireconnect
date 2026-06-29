# FireConnect

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/fw-ai/fireconnect/blob/main/LICENSE)

> Use [Fireworks AI](https://fireworks.ai) models in Claude Code, OpenCode, Codex, Pi, Cursor, and VS Code.

**Install in one line:**

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh)"
```

Or with `bash` directly:

```bash
curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash
```

Install the `fireconnect` CLI once, then use it to manage Fireworks routing for Claude Code, OpenCode, Codex, Pi, Cursor, and VS Code. Run `fireconnect help` to see what it can do.

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
fireconnect claude on --api-key fw_...   # also saves key to ~/.fireconnect/config.json
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
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "accounts/fireworks/models/deepseek-v4-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "accounts/fireworks/models/deepseek-v4-flash"
  }
}
```

The setup writes both `ANTHROPIC_API_KEY` (preferred) and `ANTHROPIC_AUTH_TOKEN` (compatibility alias) with the same Fireworks key. It saves a backup of your previous provider settings so `fireconnect claude off` can restore them.

Short model IDs are accepted everywhere. For example, `glm-latest` is written to Claude Code settings as `accounts/fireworks/routers/glm-latest[1m]`.

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

The API key is **not** stored in the JSON — VS Code stores it in the OS keychain (macOS Keychain / Windows Credential Manager / libsecret on Linux) and the JSON holds a `${input:chat.lm.secret.<id>}` reference. `fireconnect vscode on` writes both: the provider entry to `chatLanguageModels.json` and the key to the keychain under VS Code's `product.nameLong` service (e.g. `Visual Studio Code`).

```bash
fireconnect vscode on --api-key fw_...    # quit VS Code first
fireconnect vscode status                 # read-only; works while VS Code is open
fireconnect vscode model list --search glm
fireconnect vscode model add deepseek-v4-flash
fireconnect vscode model select
fireconnect vscode off                    # restores chatLanguageModels.json + removes the key
```

**No restart needed** — VS Code watches `chatLanguageModels.json` and hot-reloads provider changes (including the keychain-resolved API key), so `on`/`off`/`model add`/`model select`/`model reset` take effect immediately in the Chat picker. Quit VS Code only to avoid a concurrent-edit clobber (if you edit models in VS Code's UI at the same moment fireconnect writes). `status` and `model list` are read-only and work any time.

Per-model `toolCalling`/`vision`/`maxInputTokens`/`maxOutputTokens` are defined alongside serverless pricing in `packages/setup-cli/lib/fireworks-model-specs.mjs` (sourced from the Fireworks model library and API). Unmapped models default to `toolCalling: true` and `vision: false`; token limits are omitted until the model is added to the specs registry. VS Code sends `maxOutputTokens` as `max_output_tokens`, so mapped values must not exceed the model limit.

On macOS the first time VS Code reads the fireconnect-written keychain entry it may show a Keychain access prompt — click **Always Allow** once. On Linux, `libsecret` (`secret-tool`) must be installed. `--keychain-service` overrides the service name for custom installs / Insiders. `off` restores your original `chatLanguageModels.json` and deletes the `chat.lm.secret.fw-*` keychain entry; any providers you configured manually are preserved.

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

Resolves the key in documented order: `--api-key`, then the harness's stored key, then
`~/.fireconnect/config.json`, then `FIREWORKS_API_KEY`. Non-Fireworks-shaped keys (for example
Anthropic `sk-ant-...`) are skipped when resolving harness-local keys.

Fire Pass keys (`fpk_...`) show Fire Pass-supported routers: `glm-latest`, `glm-fast-latest`, `glm-5p2-fast`, `kimi-fast-latest`, and `kimi-k2p7-code-fast`.

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
example **$5 / $25 per Mtok** on the default Opus-style mapping for `glm-latest`). **Fireworks
bills at serverless model rates** (for example about **$1.40 / $4.40 per Mtok** for GLM 5.2 on
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
| `glm-latest` | All-around use, agentic tasks | Default for `main` and `opus` slots. Version-tracking router; strong reasoning, 1M context. |
| `glm-fast-latest` | Latency-sensitive agentic use | Version-tracking router on the high-speed Fast serving path (100+ tok/s), at a higher per-token price. 1M context. |
| `glm-5p2-fast` | Latency-sensitive agentic use | Same as `glm-fast-latest` but pinned to GLM 5.2 rather than version-tracking. 1M context. |
| `glm-5p1` | General use (lighter) | Default `sonnet` slot. Good balance of speed and quality. |
| `deepseek-v4-flash` | Background / fast tasks | Default `haiku` and `subagent` slots. Lowest latency. |

**Fire Pass keys** (`fpk_...`): all slots default to `glm-latest`.

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
fireconnect configure              Register harnesses and API key preferences.
fireconnect uninstall              Disable + restore all harnesses, then remove FireConnect.
fireconnect help                   Show help.
```

`fireconnect configure` stores a provided API key in `~/.fireconnect/config.json`.
`<harness> on` reads that global key (or `FIREWORKS_API_KEY`) and writes harness-local auth.

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
without touching your real config). Run `fireconnect help` for the full CLI reference.

OpenCode also supports routing through Fireworks models on Microsoft Foundry (Azure) — see
[Azure (Microsoft Foundry) endpoints](#azure-microsoft-foundry-endpoints).

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
fireconnect configure --harnesses opencode,codex,pi --provider azure \
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

