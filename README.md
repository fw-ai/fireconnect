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

**Windows:** run the install from Git Bash. In PowerShell, piping `curl | bash`
corrupts the script's line endings (you'll see `set: pipefail\r: invalid option
name`); keep the pipe inside bash instead:

```bash
bash -c "curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh | bash"
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

## Upgrading

To update FireConnect, re-run the installer (do not use `fireconnect upgrade`):

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/fw-ai/fireconnect/main/install.sh)"
```

If Claude Code is connected through FireConnect, the installer detects it, asks
before temporarily restoring your original settings, installs the latest CLI,
and tells you to reconnect with `fireconnect claude on`. Your other harness
settings and stored API key are preserved.

Default models (Claude Code):

```text
main     -> glm-fast-latest
opus     -> glm-fast-latest
fable    -> glm-fast-latest
sonnet   -> kimi-fast-latest
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
fireconnect claude on                    # writes an owner-only X-Fireworks-Api-Key header
```

Restart Claude Code after this completes.

## What Gets Written

The setup writes these Claude Code settings. Claude Code authenticates via the
`X-Fireworks-Api-Key` custom header (in `ANTHROPIC_CUSTOM_HEADERS`), **not**
`apiKeyHelper`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.fireworks.ai/inference",
    "ANTHROPIC_MODEL": "glm-fast-latest[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-fast-latest[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-fast-latest",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "glm-fast-latest[1m]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Fireworks-Api-Key: fw_..."
  }
}
```

**Why the custom header (and not `apiKeyHelper`)?** The gateway authenticates via
`X-Fireworks-Api-Key`, which wins over any `x-api-key` / `Authorization` that a
user's `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (in the shell env or
`settings.json`) would otherwise send — so a stray Anthropic key can't break
routing. The trade-off is that the Fireworks key is written in plaintext in
`settings.json` (still stored in the OS keychain as the source of truth for
`key export` and the other harnesses). FireConnect saves a byte-for-byte backup
of your previous settings so `fireconnect claude off` restores them exactly, and
pre-approves a stray `ANTHROPIC_API_KEY` in `~/.claude.json` so Claude Code
doesn't prompt about it on first launch.

FireConnect also adds privacy-safe request attribution where a harness supports
custom headers:

```text
X-Title: <harness name>
HTTP-Referer: fireconnect/v<version>
```

FireConnect never overrides `User-Agent`; the harness sends its own native name
and version. `X-Title` identifies the harness, while `HTTP-Referer` carries only
FireConnect's normalized version label. These values contain no user, account,
local path, repository, prompt, session, or credential data. Re-running `on`
refreshes only FireConnect-managed headers and preserves unrelated custom
headers; `off` restores the pre-connect config byte-for-byte. Cursor and Deep
Agents currently expose no custom request-header surface, so FireConnect omits
telemetry there.

While Claude Code is routed through Fireworks, `fireconnect claude on` also adds
`WebSearch` and `WebFetch` to `permissions.deny` in `settings.json`. Those are
Anthropic **server-side** tools that the gateway can't run, so they'd break;
your own `permissions` rules are preserved and the deny entries are removed on
`fireconnect claude off`. If your account is entitled to Fireworks web search, a
`fireworks-websearch` MCP server is installed as the working replacement.

Short model IDs are accepted everywhere. For example, `glm-fast-latest` is written to Claude Code settings as `accounts/fireworks/routers/glm-fast-latest[1m]`.

### Cursor IDE

Cursor stores its AI settings in a SQLite database (`state.vscdb`), not a JSON file, so the Cursor harness writes there directly:

- API key -> `cursorAuth/openAIKey`
- Base URL -> `openAIBaseUrl` (set to `https://api.fireworks.ai/inference/v1`, Cursor's OpenAI-compatible endpoint)
- Custom models -> `aiSettings.userAddedModels` + `aiSettings.modelOverrideEnabled`
- Per-mode model -> `aiSettings.modelConfig[mode]` (e.g. `composer`, `cmd-k`)

`cursor on --model <id>` registers that model and sets **every mode that already
exists** in `modelConfig` to it (non-destructive — it won't create mode entries
that aren't already there). `status` reports the active/default model.

Cursor registers the preferred latest/newest catalog. FireRouter is not
supported in Cursor. Direct Fireworks model IDs are stored as short slugs in the
picker, ownership tracker, and every managed mode selection. Legacy canonical
`accounts/fireworks/...` entries remain readable and migrate on the next `on`.

```bash
fireconnect cursor on --api-key fw_...   # quit Cursor first; sets all existing modes
fireconnect cursor status                # read-only; works while Cursor is open
fireconnect model list --search glm
fireconnect cursor on --model glm-fast-latest
fireconnect cursor off                   # restores your previous settings
```

**Quit Cursor (`Cmd-Q` / File > Quit) before `on` or `off`** — otherwise
Cursor's in-memory state overwrites the write on next flush. In an interactive
terminal, if Cursor is still running fireconnect asks you to quit it and
**press Enter to continue**; if Cursor is still running after that it errors
out. `status` and `model list` are read-only and work any time. Pass `--force`
to write anyway without waiting. `off` only removes models FireConnect
registered; your own custom models are preserved.

**While FireConnect is on, only Fireworks models in your picker work** — Cursor
subscription models, Opus modes, and other built-in models won't respond. For
model access or setup help, reach out to the Fireworks team. Run
`fireconnect cursor off` to restore built-in Cursor models.

### VS Code Chat

VS Code Chat's custom language models are configured in `chatLanguageModels.json` (a JSON array of providers). fireconnect adds a `Fireworks` provider (vendor `customendpoint`, `apiType: responses` — the OpenAI Responses API) whose models point at `https://api.fireworks.ai/inference` (VS Code appends `/v1/responses`). Microsoft Foundry (Azure) mode uses `apiType: chat-completions`. FireRouter is just the `firerouter` model on this same provider (`apiType: responses`).

VS Code registers the preferred latest/newest catalog. Workspace-BYOK accounts
also receive `firerouter` automatically; otherwise run
`vscode on --model firerouter`. Direct Fireworks `models[].id` values are short
slugs; legacy canonical IDs remain readable and migrate on the next `on`.

The API key is **not** stored in the JSON — VS Code resolves the `${input:chat.lm.secret.<id>}` reference through its secret storage, which keeps the key as an Electron `safeStorage`-encrypted blob inside VS Code's application-scoped `state.vscdb` (SQLite `ItemTable`, key `secret://<id>`). `fireconnect vscode on` writes both: the provider entry to `chatLanguageModels.json` and the encrypted key to `state.vscdb` under a `chat.lm.secret.fw-*` id.

```bash
fireconnect vscode on --api-key fw_...    # quit VS Code first
fireconnect vscode status                 # read-only; works while VS Code is open
fireconnect model list --search glm
fireconnect vscode on --model deepseek-v4-flash
fireconnect vscode off                    # restores chatLanguageModels.json + removes the key
```

**Quit VS Code (`Cmd-Q` / File > Quit) before `on` or `off`** — if VS Code is
still running, fireconnect prompts you to quit and press Enter (same as Cursor).
Pass `--force` to write anyway without waiting.
`status` and `model list` are read-only and work any time.

Per-model `toolCalling`/`vision`/`maxInputTokens`/`maxOutputTokens` are defined alongside serverless pricing in `packages/setup-cli/lib/fireworks/model-specs.mjs` (sourced from the Fireworks model library and API). Unmapped models default to `toolCalling: true` and `vision: false`; token limits are omitted until the model is added to the specs registry. VS Code sends `maxOutputTokens` as `max_output_tokens`, so mapped values must not exceed the model limit.

On macOS, `safeStorage` encrypts with a master key VS Code stores in the login Keychain under "<App> Safe Storage" (e.g. `Visual Studio Code Safe Storage`); opening VS Code once creates it, so the first `on` may need that. Insiders is detected automatically (it reads `Code - Insiders Safe Storage` and targets the Insiders `state.vscdb`); `--vscode-path` pointing inside an Insiders user-data dir is also inferred. On Windows, `safeStorage` uses AES-256-GCM with a DPAPI-protected key stored in VS Code's `Local State` file — opening VS Code once creates the key. On Linux, `safeStorage` needs `libsecret` (`secret-tool`) for real encryption — without it, Chromium falls back to a hardcoded password (obfuscated, not encrypted), which fireconnect still writes but warns about. `off` restores your original `chatLanguageModels.json` byte-for-byte and deletes the `chat.lm.secret.fw-*` secret row from `state.vscdb`; any providers you configured manually are preserved.

### FireRouter mode

> Enabled by selecting the `firerouter` model: `fireconnect vscode on --model firerouter`. The old `--router` flag has been retired; firerouter is available to every standard key.

`fireconnect vscode on --model firerouter` registers the **`firerouter` model** in the Fireworks provider — served on the normal gateway via the **OpenAI Responses API**, exactly like every other model. Pick it in the VS Code Chat model picker.

```bash
fireconnect vscode on --model firerouter --api-key fw_... --anthropic-api-key sk-ant-...
fireconnect vscode status
fireconnect vscode off
```

The Fireworks key stays **encrypted** in `state.vscdb` (the provider `apiKey`)
— no plaintext. An Anthropic BYOK key is optional; when supplied it is written
on the `firerouter` model as `anthropic_api_key` and
`requestHeaders["x-anthropic-api-key"]`. Workspace-BYOK accounts and sessions
with a valid `ANTHROPIC_API_KEY` receive `firerouter` alongside the preferred
aliases; otherwise use `on --model firerouter`.
`fireconnect vscode off` restores your `chatLanguageModels.json` byte-for-byte
and removes the secret.


## FireRouter (`firerouter` model)

FireRouter is a judge-model router that rates each request and dispatches simpler work to
cheaper models while passing hard work through — surfaced as a first-class **`firerouter`
model** on the normal Fireworks gateway (`https://api.fireworks.ai/inference`). Select it like
any other model:

```bash
fireconnect claude on --model firerouter
fireconnect claude on --opus firerouter
fireconnect opencode on --model firerouter
fireconnect codex on --model firerouter
```

FireRouter is available to every standard Fireworks key (not Fire Pass), but it is
automatically included in supported model lists/pickers only when workspace BYOK is
provisioned server-side (`enable-workspace-byok`) or a valid `sk-ant-...`
`ANTHROPIC_API_KEY` is present for a harness that can forward it. Otherwise
select it explicitly with `on --model firerouter`; Claude uses a slot flag such
as `on --opus firerouter`. Cursor does not support FireRouter. It is never the
default.

**BYOK for frontier models.** FireRouter routes hard requests to Anthropic frontier models using
your Anthropic key. If your workspace has BYOK provisioned server-side (`enable-workspace-byok`),
FireRouter uses it automatically, so selecting a FireRouter model/slot needs
**no extra keys**. Otherwise pass `--anthropic-api-key sk-ant-...` where
supported; without it, FireRouter still routes among Fireworks models.
FireConnect checks for a valid local Anthropic key first, then the workspace
flag when populating a model catalog. (OpenAI BYOK is not supported.)

**Claude Code.** `--model` sets the primary `ANTHROPIC_MODEL`; alias flags set
their corresponding slots independently. For example, `--opus firerouter`
changes only Opus and leaves the primary on the recommended
`glm-fast-latest`, while `--model firerouter` explicitly makes FireRouter the
primary. Combine flags when multiple aliases should use it. Claude authenticates
with the Fireworks key via the `X-Fireworks-Api-Key` custom header. That header
wins over any `x-api-key`/`Authorization` a user's `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
(from the environment or `~/.claude/settings.json`) would otherwise send, so FireRouter mode
works even when an Anthropic key is present. A resolved Anthropic key is forwarded as the
`x-anthropic-api-key` BYOK header so FireRouter can pass hard requests through to Anthropic
models; it is optional (Fireworks-only routing needs only the Fireworks key). Claude Code
requires a static Fireworks header in both direct and FireRouter setups, so FireConnect writes
the key to `settings.json` with mode `0600` and restores the previous file on `off`.

**Text-only models and images.** Claude Code has no way to mark a model as non-vision.
If you paste or attach images while a text-only slot (for example `glm-fast-latest` or
`deepseek-v4-flash`) is active, the session can break and you may need `/rewind` to recover.
`fireconnect claude on` warns when your configured mapping includes text-only models, and
`fireconnect claude status` labels each slot with `vision` or `text-only`.

> **The `--router` flag has been retired.** FireRouter is a first-class model:
> use `--model firerouter` for the primary/default model or a Claude alias flag
> such as `--opus firerouter`. Workspace-BYOK accounts also receive it in
> supported model lists.

## Browsing and Configuring Models

Browse the Fireworks catalog, then configure the harness through `on`:

```bash
fireconnect model list --search glm
fireconnect claude on --sonnet kimi-latest
fireconnect opencode on --model glm-fast-latest
fireconnect codex on --model glm-fast-latest
fireconnect cursor on --model glm-fast-latest
```

### `fireconnect model list`

Lists the shared Fireworks serverless catalog using the global Fireworks key.
Fetches coding-tagged serverless models from the Fireworks serverless models API
(`GET /v1/serverless/models?use_cases=coding`) and merges
the known public platform routers (`glm-latest`, `glm-fast-latest`, `glm-5p2-fast`, `kimi-fast-latest`, `kimi-latest`, and `kimi-k2p7-code-fast`). Every row is
tagged `serverless` (on-demand endpoints will be added later).

```bash
fireconnect model list
fireconnect model list --search glm
fireconnect model list --json
```

Resolves the key in documented order: `--api-key`, then `FIREWORKS_API_KEY`,
then the globally stored credential. Standard keys include `firerouter`; Fire
Pass keys omit it and show only Fire Pass-supported routers.

Fire Pass keys (`fpk_...`) show Fire Pass-supported routers: `glm-latest`,
`glm-fast-latest`, `glm-5p2-fast`, `kimi-fast-latest`, and
`kimi-k2p7-code-fast`.

### `fireconnect claude status` vs `fireconnect model list`

| Command | Shows |
|---------|--------|
| `fireconnect claude status` | Your current provider, auth, configured alias mapping, and **Fireworks serverless rates** per slot |
| `fireconnect model list` | Available serverless endpoints from the Fireworks API, with **IN / OUT pricing** where known |

### Claude Code pricing estimates (important)

Claude Code’s `/model` picker and session cost estimates use **Anthropic list prices** (for
the model tier), while **Fireworks bills at serverless model rates**. The UI estimate can therefore
be much higher than your real bill.

FireConnect cannot override Claude Code’s price column. Use `fireconnect claude status` and
`fireconnect model list` for Fireworks rates, check the
[current serverless pricing](https://docs.fireworks.ai/serverless/pricing), and use the
[Fireworks billing dashboard](https://app.fireworks.ai/account/billing) for actual spend.

#### Status line: live Fireworks spend vs. Anthropic

`bin/cc-fireworks-savings.mjs` is a Claude Code status-line command that shows real
savings as you work. On each render Claude Code pipes the session transcript to the
script, which parses actual per-request token usage, computes the **real Fireworks
spend** (from the same serverless rates `fireconnect model list` uses), and compares it
to what the **same token mix would cost on the Anthropic-equivalent tier** (Opus for
GLM, Sonnet for Kimi, Haiku for DeepSeek, Fable for FireRouter):

```text
🔥 Fireworks · $0.28 spent (25 req) vs Anthropic $1.14 saved $0.86 75% · glm-5p2 · fireworks
```

Wire it into `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/fireconnect/cli/packages/setup-cli/bin/cc-fireworks-savings.mjs",
    "padding": 0
  }
}
```

The comparison uses Anthropic **list prices** (including cache-read/write rates), so the
savings figure reflects what routing through Fireworks saves versus paying Anthropic
directly for the equivalent tier — not the inflated in-UI estimate. `firerouter` rows are
priced against the concrete serverless model the transcript recorded, when available.
Set `CC_STATUSLINE_NOCOLOR=1` to disable ANSI colors (e.g. for non-TTY captures).

After `fireconnect claude on`, `settings.json` is updated immediately. To use
the new model, exit Claude Code and then resume the conversation with
`claude --resume <id>`, or start a new session.

### Recommended model slugs

Short IDs and canonical `accounts/fireworks/...` IDs are accepted everywhere.
OpenCode, Codex, Pi, Cursor, VS Code, and Deep Agents store direct Fireworks
selections as short slugs; existing canonical configs remain compatible and are
migrated the next time `on` runs. Microsoft Foundry (Azure) deployment names
remain unchanged.

| Short ID | Best for | Notes |
|----------|----------|-------|
| `glm-latest` | All-around use, agentic tasks | Version-tracking router; strong reasoning, 1M context. |
| `glm-fast-latest` | Latency-sensitive agentic use | Default for `main`, `opus`, and `fable` slots. Version-tracking router on the high-speed Fast serving path (100+ tok/s), at a higher per-token price. 1M context. |
| `glm-5p2-fast` | Latency-sensitive agentic use | Same as `glm-fast-latest` but pinned to GLM 5.2 rather than version-tracking. 1M context. |
| `kimi-fast-latest` | General use (lighter) | Default `sonnet` slot. Version-tracking Kimi router on the high-speed Fast serving path. |
| `glm-5p1` | General use (lighter) | Good balance of speed and quality. |
| `deepseek-v4-flash` | Background / fast tasks | Default `haiku` and `subagent` slots. Lowest latency. |

**Fire Pass keys** (`fpk_...`): all slots default to `glm-fast-latest`.

**Switching a single slot** (Claude Code only):

```bash
fireconnect model list --search glm
fireconnect claude on --opus glm-fast-latest --sonnet glm-5p1
fireconnect claude on --haiku deepseek-v4-flash --subagent deepseek-v4-flash
```

**OpenCode and Pi** use a single default model; pass `--model <slug>` to `on`.

## FireConnect CLI

The CLI is harness-first: `fireconnect <harness> <command>`. A handful of commands are
global (no harness). Commands below are listed in the same order as `fireconnect help`.

**Global**

```text
fireconnect login                  Sign in — browser (creates a key) or paste a key you have.
fireconnect logout                 Clear the stored key (keychain entry + config ref).
fireconnect status                 Show sign-in state, machine environment, and where the key is stored.
fireconnect configure              Set the provider (Azure/Foundry) and the Anthropic key.
fireconnect demo                   Race your provider vs Fireworks GLM 5.2 Fast on the same prompt.
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
inline, then finishes the job.

Recommended flow:

```bash
fireconnect login                        # guided sign-in (browser or paste)
fireconnect claude on                    # Claude: static Fireworks header + optional websearch MCP
fireconnect codex on                     # Codex/OpenCode/Pi/Deep Agents: bake literal into harness config
```

`~/.fireconnect/config.json` stores `{keychain:fireworks-api-key}` (normal). Legacy installs may still have `{env:FIREWORKS_API_KEY}` — never a literal Fireworks key in config.
The Fireworks key itself lives in the OS keychain (or encrypted-file / plaintext fallback tier). Harness
configs hold **baked literals** for Codex, OpenCode, Pi, Deep Agents, and Claude's custom header;
Cursor and VS Code use IDE safeStorage.

`FIREWORKS_API_KEY` and FireConnect-managed storage are mutually exclusive for **login and other
explicit store paths**. When the environment variable is set, `fireconnect login` verifies and uses it
without copying it into FireConnect's secret store. Combining login with a key-storing option
(`--api-key`, `--with-token`, browser sign-in, or paste) fails before anything changes.
Unset `FIREWORKS_API_KEY` first when you want FireConnect to store a key in the OS keychain/keyring.
`fireconnect <harness> on` may still read `FIREWORKS_API_KEY`, persist it to the keychain (file-config
harnesses), and bake it into that harness's config.

A managed shell hook (`export FIREWORKS_API_KEY="$(fireconnect key export)"`) is installed only for
Claude websearch MCP (`${FIREWORKS_API_KEY}` in `~/.claude.json`). Re-running `install.sh` rebakes
enabled harness configs to literals, including any legacy env-reference auth left on disk.

**Per harness** (`claude`, `opencode`, `codex`, `pi`, `cursor`, `vscode`, `deepagents`)

```text
fireconnect <harness> on           Route the harness through Fireworks (default if no command).
fireconnect <harness> off          Restore your previous provider/config.
fireconnect <harness> status       Show the provider, auth, and model mapping.
fireconnect <harness> help         Show help for that harness.
```

Global catalog discovery: `fireconnect model list`.

All model mutation goes through `<harness> on`; `--model <id>` sets the
primary/default model and Claude alias flags set individual semantic slots.
Claude also has `fireconnect claude usage` (estimate usage cost from a session
log).

Run `fireconnect help` for the overview, or `fireconnect <harness> help` (e.g. `fireconnect claude help`, `fireconnect cursor help`, `fireconnect vscode help`, `fireconnect deepagents help`) for everything available at the harness level.

## Codex Harness

FireConnect routes [OpenAI Codex CLI](https://developers.openai.com/codex) through Fireworks via the Responses API:

```bash
fireconnect login
fireconnect codex on                  # route Codex through Fireworks (~/.codex/config.toml)
fireconnect codex status              # check current provider and model
fireconnect codex on --model glm-5p1   # switch model (non-interactive)
fireconnect codex on --model firerouter  # route requests through FireRouter
fireconnect codex off                 # restore your original config
```

What it does:

- Sets root `model_provider` / `model` for Codex 0.134+ (storing `model` as a short slug) and adds a
  `[model_providers.fireworks-ai]` block with `wire_api = "responses"` and a **baked**
  `experimental_bearer_token` literal (file mode `0600`). Codex reads the key from config — no shell
  hook required for normal Fireworks routing.
- Writes the **preferred serverless catalog** (`*-latest`, `*-fast-latest`, or the newest concrete family version) to `~/.codex/fireworks-model-catalog.json` and points
  Codex at it via `model_catalog_json`
  (short slugs; latest aliases preferred; embeddings/no-tools/deprecated models filtered out). Canonical
  model IDs from the Fireworks API and older catalogs remain accepted. Workspace-BYOK
  accounts and sessions with a valid `ANTHROPIC_API_KEY` also receive `firerouter`; otherwise select it with `on --model firerouter`. `codex off`
  removes the catalog file and reference.
- Snapshots your original `~/.codex/config.toml` before the first change. `fireconnect codex off`
  restores it byte-for-byte and reconciles the shell hook when nothing else needs `FIREWORKS_API_KEY`.
- Preserves unrelated Codex settings (for example `[[mcp_servers]]`) via surgical TOML edits.

**MiniMax models are not supported in Codex.** Codex uses the Fireworks Responses API and may
insert assistant messages between `tool_calls` and `tool_results`. MiniMax chat templates require
`tool_results` to follow `tool_calls` directly, so Codex sessions fail with template errors. MiniMax
remains available through Chat Completions harnesses (for example Claude or OpenCode). If you run
`fireconnect codex on --model minimax-m3`, FireConnect rejects the request with an explanation.

### FireRouter mode

> Enabled by selecting the `firerouter` model: `fireconnect codex on --model firerouter`. The old `--router` flag has been retired; firerouter is available to every standard key.

`fireconnect codex on --model firerouter` registers the `firerouter` model on the normal
Fireworks gateway provider (`https://api.fireworks.ai/inference/v1`, Responses API). The
Fireworks key is baked into `config.toml` like any other Fireworks model. An optional Anthropic BYOK key rides along as an
`env_http_headers` `x-anthropic-api-key` reference so FireRouter can pass hard requests through
to Anthropic; export `ANTHROPIC_API_KEY` or rely on workspace BYOK. (OpenAI BYOK is
not supported by FireRouter.)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
fireconnect codex on --model firerouter
```

`fireconnect codex off` restores the original `config.toml` byte-for-byte.
After `fireconnect codex on` or `off`, `config.toml` is updated immediately.
To use updated routing, exit Codex and then resume with `codex resume <id>`,
or start a new session.

## OpenCode Harness

FireConnect routes [OpenCode](https://opencode.ai) through Fireworks with harness-first commands:

```bash
fireconnect login
fireconnect opencode on                  # route OpenCode through Fireworks
fireconnect opencode status              # check current provider
fireconnect opencode on --model glm-5p1   # switch model (non-interactive)
fireconnect opencode off                 # restore your original config
```

What it does:

- Merges a `provider.fireworks-ai` block into `~/.config/opencode/opencode.json`, sets the
  default `model` to `fireworks-ai/<slug>`, and keys provider models by short slug.
  `options.apiKey` is a **baked plaintext literal** (file mode `0600`). Existing canonical model
  references remain compatible.
- Registers the **preferred serverless catalog** in the provider's `models` (`*-latest` /
  `*-fast-latest`, otherwise the newest concrete family version)
  in OpenCode's `/model` picker — plus `firerouter` for workspace BYOK or a valid `ANTHROPIC_API_KEY`. Falls back to the active model
  when the catalog can't be fetched (offline). `on --model firerouter` registers only the
  `firerouter` model (it routes server-side).
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
fireconnect pi on --model glm-5p1         # switch model (non-interactive)
fireconnect pi on --model firerouter               # route Anthropic models through FireRouter
fireconnect pi off                       # restore your original settings and auth
```

What it does:

- Sets `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` and stores a
  **baked plaintext literal** in `fireworks.key` (`auth.json`, mode `0600`). `on` applies the default model
  (`glm-fast-latest`) unless you pass `--model`.
- Registers the **preferred serverless catalog** in `~/.pi/agent/models.json` (`*-latest` /
  `*-fast-latest`, otherwise the newest concrete family version) for Pi's
  `/model` picker, plus `firerouter` for workspace BYOK or a valid
  `ANTHROPIC_API_KEY`. `settings.defaultModel`, managed state IDs, and provider
  model IDs are short slugs. Every managed short-ID model gets a complete
  `models` entry so Pi retains context, pricing, reasoning, and vision metadata
  even though Pi's built-in catalog is keyed by canonical IDs. Falls back to the
  bundled router set offline; `on --model firerouter` registers only the
  `firerouter` model.
- Snapshots both files under `~/.fireconnect/pi/` before the first change. `fireconnect pi off`
  restores them **byte-for-byte**. `auth.json` is written at mode `0600`.
- Restart Pi after `on` or `off` when Pi is already running.

### FireRouter mode

> Enabled by selecting the `firerouter` model: `fireconnect pi on --model firerouter`. The old `--router` flag has been retired; firerouter is available to every standard key.

`fireconnect pi on --model firerouter` selects
`firerouter` on Pi's normal Fireworks provider. The
Fireworks key is resolved exactly as it is for every other Fireworks model. An
Anthropic BYOK key is optional and, when supplied, is attached as the
`x-anthropic-api-key` model header:

```bash
fireconnect pi on --model firerouter --anthropic-api-key sk-ant-...
fireconnect pi on --model firerouter
```

FireConnect backs up `settings.json`, `auth.json`, and `models.json`, and
`fireconnect pi off` restores all three byte-for-byte. Re-run `on --model
<id>` or use Pi's model picker to switch to another Fireworks model.

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
MACC. Foundry exposes an **OpenAI-compatible** endpoint, so **OpenCode, Codex, Pi,
Deep Agents, Cursor, and VS Code** can route through your Foundry resource instead of
the Fireworks gateway.

**Configure the endpoint once**, then `<harness> on` leverages it — no per-command flags:

```bash
fireconnect configure --provider azure \
  --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key>

fireconnect opencode on   # routes through the configured Foundry endpoint
fireconnect codex on
fireconnect pi on
fireconnect deepagents on
fireconnect cursor on
fireconnect vscode on
```

`configure` stores a top-level `provider` and `azure` endpoint in
`~/.fireconnect/config.json`; this design extends to future providers without touching the
harnesses. To switch back, run `fireconnect configure --provider fireworks ...`.

You can also opt in per-command (or override the configured endpoint) with `--azure`:

```bash
fireconnect opencode on --azure --base-url https://<resource>.services.ai.azure.com \
  --api-key <azure-api-key> --model FW-GLM-5.2
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
  without the `fireworks-ai/` publisher prefix (e.g. `FW-GLM-5.2`, `FW-MiniMax-M2.5`).
  Defaults to `FW-GLM-5.2`; pass `--model <foundry-deployment-name>` to select another.
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
| Deep Agents | `[models.providers.fireworks-azure]` in `config.toml` | `fireworks-azure:<deployment>` |
| Cursor | OpenAI-compatible URL, deployment, and key in Cursor's `state.vscdb` | `<deployment>` |
| VS Code | custom endpoint model in `chatLanguageModels.json`; key in VS Code `safeStorage` | `<deployment>` |

`fireconnect <harness> status` reports `azure` as the provider along with the endpoint and
model.

> Claude Code is intentionally excluded: its harness speaks the Anthropic Messages API,
> which Foundry does not expose. `model list` reads the Fireworks catalog and
> is not used in Azure mode — select a Foundry deployment with `--model`.

## Deep Agents Harness

FireConnect routes [LangChain Deep Agents Code](https://docs.langchain.com/oss/python/deepagents/cli) (`dcode`) through Fireworks:

```bash
fireconnect login
fireconnect deepagents on                # route Deep Agents through Fireworks
fireconnect deepagents status            # check current provider
fireconnect deepagents on --model glm-5p1 # switch model (non-interactive)
fireconnect deepagents off               # restore your original config
```

What it does:

- Sets `[models].default` to `fireworks:<slug>` and configures
  `[models.providers.fireworks]` in `~/.deepagents/config.toml` with the Fireworks
  OpenAI-compatible base URL (`https://api.fireworks.ai/inference`) and a **baked**
  `api_key` literal (file mode `0600`). Existing canonical `fireworks:accounts/fireworks/...`
  model references remain compatible.
- Stores your Fireworks API key in the FireConnect keychain via `fireconnect login` or
  `deepagents on --api-key`, then bakes it into `config.toml`. FireConnect does not write
  `~/.deepagents/.state/auth.json` — use dcode's `/auth` for credentials stored
  in that file.
- Snapshots `config.toml` under `~/.fireconnect/deepagents/` before the first
  change. `fireconnect deepagents off` restores byte-for-byte.
- Restart `dcode` after `on` or `off`.

Use `--config-path <path>` to target a non-default config file.
