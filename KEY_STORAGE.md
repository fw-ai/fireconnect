# Key Storage

This document describes exactly where FireConnect stores the API keys you provide, in what form (encrypted or plain text), and how to verify each location yourself. It is intended as a reference for security reviews.

FireConnect handles up to two credentials:

- **Fireworks API key** (`fw_...` or `fpk_...`) — provided during `fireconnect configure`, `fireconnect key set`, or a harness `on` command.
- **Anthropic API key** — optional, used only by FireRouter (`--router`) mode for harnesses that forward requests in the Anthropic API format.

## Primary key store (tiered)

When you provide a Fireworks API key, FireConnect stores it once, centrally, using the first available tier:

| Tier | Backend | Location | Protection |
|---|---|---|---|
| 1 | OS keychain | macOS Keychain, Windows Credential Manager, or Linux Secret Service (libsecret / gnome-keyring), service **`FireworksAI`**, account **`fireworks-api-key`** | Encrypted and access-controlled by the operating system |
| 2 | Encrypted file | `~/.local/share/keyring/secrets.json` (`$XDG_DATA_HOME/keyring` if set; `%LOCALAPPDATA%\Keyring` on Windows) | AES-256-GCM, random per-secret IV, authenticated. Master key at `~/.config/keyring/file.key`, file mode `0600` |
| 3 | Plain-text file (last resort) | `~/.fireconnect/.api-key` | File mode `0600`, **not encrypted** |

Keychain access is implemented with the [`cross-keychain`](https://www.npmjs.com/package/cross-keychain) library. Tier 2 is used only when no OS keychain is available (for example containers, CI, or a Linux host without a Secret Service daemon). Tier 3 is used only when both secure tiers fail at write time; when that happens, the chosen tier and the reason are recorded in `~/.fireconnect/key-storage.json`, and `fireconnect status` will report it. A plain-text or legacy key is lifted back into secure storage automatically the next time you run `fireconnect configure` or `fireconnect upgrade`.

Every write is verified by an immediate read-back; if the backend did not actually persist the key, the command fails rather than silently falling through.

`~/.fireconnect/config.json` stores a **reference**, not the key itself — `"apiKey": "{keychain:fireworks}"` or `"{env:FIREWORKS_API_KEY}"`. The one exception is the optional Anthropic API key for router mode, which is stored as a literal in this file (see the table below); whenever any literal is present the file is written with mode `0600`.

You can pin the backend explicitly with the `FIRECONNECT_KEY_STORAGE` environment variable (`keychain`, `file`, or `null`), and supply a fixed master key for the encrypted-file tier with `KEYRING_FILE_MASTER_KEY` (64 hex characters) in CI or sandboxed environments.

## How harnesses receive the key

FireConnect never copies the Fireworks key into a harness config file unless the harness gives it no other option. Two indirection mechanisms are used:

- **`apiKeyHelper` (Claude Code, direct mode).** `~/.claude/settings.json` contains a helper *command* (`fireconnect key export --stored-only`) that Claude Code runs at startup to fetch the key from the primary store. The literal key never appears in the settings file.
- **Shell environment hook (Codex, OpenCode, Pi, Deep Agents).** These harnesses read `FIREWORKS_API_KEY` from the environment. FireConnect installs a marked block in your shell profile (`~/.zshrc`, `~/.bashrc`, or `~/.bash_profile`) that exports the variable by running `fireconnect key export --stored-only`. The profile contains the command, never the literal key. The block is removed when the last environment-based harness is turned off.

## Storage matrix

The table below covers every harness in every mode. "Encrypted" means the key material on disk is ciphertext; "reference" means the file contains no key material at all, only a pointer resolved at runtime from the primary store.

| Harness | Mode | Fireworks key on disk | Encrypted? | Where to verify |
|---|---|---|---|---|
| **Claude Code** | Direct (`fireconnect claude on`) | Not in harness config — `apiKeyHelper` command reference; key stays in the primary store | Yes (OS keychain / AES-256-GCM tier) | `~/.claude/settings.json` (`apiKeyHelper`, `env.ANTHROPIC_BASE_URL`) |
| **Claude Code** | Router (`--router`) | **Plain-text literal** in `env.ANTHROPIC_CUSTOM_HEADERS` (`X-FireRouter-Fireworks-Key`) | **No** | `~/.claude/settings.json` |
| **Claude Code** | Off (`fireconnect claude off`) | Removed from `settings.json` (env vars, headers, and `apiKeyHelper` stripped or restored from backup) | — | `~/.claude/settings.json` |
| **VS Code Chat** | Direct (`fireconnect vscode on`) | Encrypted secret in VS Code's `state.vscdb` (row `secret://chat.lm.secret.fw-*`); the JSON config holds only the `${input:chat.lm.secret.fw-*}` reference | Yes (Electron `safeStorage`; see caveats below) | `<VS Code User dir>/chatLanguageModels.json` and `<VS Code User dir>/globalStorage/state.vscdb` |
| **VS Code Chat** | Router (`--router`) | Fireworks key: **plain-text literal** in each model's `requestHeaders["X-FireRouter-Fireworks-Key"]`. Anthropic key: encrypted in the `state.vscdb` secret slot | Fireworks: **No**. Anthropic: Yes | `<VS Code User dir>/chatLanguageModels.json`, `state.vscdb` |
| **VS Code Chat** | Off (`fireconnect vscode off`) | Provider entry removed from the JSON config; all `secret://chat.lm.secret.fw-*` rows deleted from `state.vscdb` | — | Same files |
| **Cursor** | Direct (`fireconnect cursor on`) | **Plain-text** cell in Cursor's SQLite state DB (`ItemTable` row `cursorAuth/openAIKey`) — Cursor's own key slot does not support encryption | **No** | `<Cursor User dir>/globalStorage/state.vscdb` |
| **Cursor** | Router | Not offered for Cursor | — | — |
| **Cursor** | Off (`fireconnect cursor off`) | Key cell deleted (or restored to its pre-FireConnect value from backup) | — | `<Cursor User dir>/globalStorage/state.vscdb` |
| **Codex** | Direct (`fireconnect codex on`) | Not on disk — `env_key = "FIREWORKS_API_KEY"` reference; resolved via the shell hook from the primary store | Yes (primary store) | `~/.codex/config.toml` (`[model_providers.fireworks-ai]`) |
| **Codex** | Router | Not offered for Codex | — | — |
| **Codex** | Off (`fireconnect codex off`) | Provider section removed or restored from backup | — | `~/.codex/config.toml` |
| **OpenCode** | Direct (`fireconnect opencode on`) | Not on disk — `"apiKey": "{env:FIREWORKS_API_KEY}"` reference | Yes (primary store) | `~/.config/opencode/opencode.json` |
| **OpenCode** | Router (`--router`) | **Plain-text literal** in `provider.anthropic.options.headers["X-FireRouter-Fireworks-Key"]`; Anthropic key (if stored) plain text in `options.apiKey`. File is written mode `0600` | **No** | `~/.config/opencode/opencode.json` |
| **OpenCode** | Off (`fireconnect opencode off`) | Provider entry / FireRouter headers and key removed or restored from backup | — | `~/.config/opencode/opencode.json` |
| **Pi** | Direct (`fireconnect pi on`) | Not on disk — `"key": "$FIREWORKS_API_KEY"` reference in `auth.json` (file mode `0600`) | Yes (primary store) | `~/.pi/agent/auth.json`, `~/.pi/agent/settings.json` |
| **Pi** | Router (`--router`) | Fireworks key: **plain-text literal** in `providers.anthropic.headers` in `models.json` (file mode `0600`). Anthropic key (if provided): plain text in `auth.json` (mode `0600`) | **No** | `~/.pi/agent/models.json`, `~/.pi/agent/auth.json` |
| **Pi** | Off (`fireconnect pi off`) | Managed entries removed from `auth.json`, `models.json`, `settings.json`, or restored from backups | — | Same files |
| **Deep Agents** | Direct (`fireconnect deepagents on`) | Not on disk — `api_key_env = "FIREWORKS_API_KEY"` reference | Yes (primary store) | `~/.deepagents/config.toml` (`[models.providers.fireworks]`) |
| **Deep Agents** | Router | Not offered for Deep Agents | — | — |
| **Deep Agents** | Off (`fireconnect deepagents off`) | Provider section and model default removed or restored from backup | — | `~/.deepagents/config.toml` |

VS Code and Cursor user directories by platform:

- macOS: `~/Library/Application Support/<Code|Cursor>/User/`
- Linux: `~/.config/<Code|Cursor>/User/` (`$XDG_CONFIG_HOME` respected)
- Windows: `%APPDATA%\<Code|Cursor>\User\`

FireConnect detects VS Code Insiders installs and targets the matching folder.

> **Note on turning a harness off:** `off` removes FireConnect-managed key material from that harness's configuration, but it does not delete the key from the primary store — other harnesses may still be using it. To remove the stored key entirely, run `fireconnect key delete`.

## Router mode and plain-text keys

FireRouter mode routes Anthropic-format traffic through `https://router.fireworks.ai`, authenticated by a static `X-FireRouter-Fireworks-Key` request header. The affected harnesses (Claude Code, VS Code Chat, OpenCode, Pi) can only send a static header whose value is present in their configuration files, so router mode necessarily writes the Fireworks key to disk in plain text. This is a deliberate, documented trade-off, and the CLI prints a warning when it happens, for example:

```
Note: FireRouter mode writes your Fireworks API key in plaintext to ~/.claude/settings.json
(in ANTHROPIC_CUSTOM_HEADERS), because Claude Code sends it as a static header.
Prefer `fireconnect claude on` (direct mode) to keep the key in the OS keychain via apiKeyHelper.
```

If your threat model excludes plain-text keys on disk, use direct mode, which keeps the key in the OS keychain on every harness except Cursor.

Router mode's optional **Anthropic API key** is handled as follows:

- If existing Anthropic enterprise/login credentials are detected, no Anthropic key is written anywhere.
- If you provide one, it is stored as a literal in `~/.fireconnect/config.json` (`anthropicApiKey`, file mode `0600`) and written into the harness configuration in the forms shown in the table above. In VS Code it occupies the `safeStorage`-encrypted secret slot; in Claude Code, OpenCode, and Pi it is plain text in the respective config file.

## Keychain and cross-keychain details

- **Entry identity.** One entry per machine: service `FireworksAI`, account `fireworks-api-key`. FireConnect creates no other keychain entries of its own.
- **Backends.** The `cross-keychain` library selects the native backend per platform (`native-macos`, `native-windows`, `native-linux`/Secret Service). FireConnect maps its `FIRECONNECT_KEY_STORAGE` override onto cross-keychain's `TS_KEYRING_BACKEND` variable so the same backend is used both in the interactive CLI and in spawned `fireconnect key export` processes.
- **macOS.** The first read after storing the key may show the standard macOS Keychain access prompt for the process requesting it. If the keychain is locked, FireConnect reports it and asks you to unlock rather than falling back to a weaker tier.
- **Linux.** Requires a running Secret Service provider (e.g. gnome-keyring). Without one, FireConnect uses the AES-256-GCM encrypted-file tier instead.
- **VS Code's `safeStorage` is a separate mechanism.** The encrypted secret FireConnect writes for VS Code lives in VS Code's own `state.vscdb` and is encrypted with Electron `safeStorage` (Chromium OSCrypt): on macOS, AES-128-CBC keyed from the "Code Safe Storage" master password held in the login keychain; on Windows, DPAPI (current user); on Linux, AES-128-CBC keyed from a keyring-held master password. **Caveat:** on a Linux system with no keyring available, VS Code itself falls back to a hardcoded obfuscation password ("basic text" mode), which is not meaningful encryption.
- **Master key for the encrypted-file tier** is stored at `~/.config/keyring/file.key` with mode `0600`. It is local key material protected by file permissions, not by a passphrase.

## Backups

Before modifying a harness configuration, FireConnect snapshots the pre-existing file to `~/.fireconnect/<harness>/…backup….json` so `off` can restore your original setup. These snapshots contain whatever the file contained *before* FireConnect touched it — including any credentials you had configured previously — and are written with restrictive permissions (`0600`, directories `0700` where applicable). Backups are deleted when the corresponding harness is turned off.

## Verifying yourself

- **Where is my key right now?**

  ```bash
  fireconnect status            # sign-in state, backend, location, per-harness runtime source; add --json for machine-readable output
  ```

- **macOS Keychain entry** (prints metadata; add `-w` only if you want the secret itself):

  ```bash
  security find-generic-password -s FireworksAI -a fireworks-api-key
  ```

- **VS Code secret rows** (values are `safeStorage` ciphertext):

  ```bash
  sqlite3 "<VS Code User dir>/globalStorage/state.vscdb" \
    "SELECT key FROM ItemTable WHERE key LIKE 'secret://chat.lm.secret.fw-%'"
  ```

- **Cursor key cell** (value is plain text):

  ```bash
  sqlite3 "<Cursor User dir>/globalStorage/state.vscdb" \
    "SELECT key FROM ItemTable WHERE key = 'cursorAuth/openAIKey'"
  ```

- **Plain-text fallback and storage cache:**

  ```bash
  ls -l ~/.fireconnect/.api-key 2>/dev/null   # exists only if the last-resort tier was used
  cat ~/.fireconnect/key-storage.json          # records which tier is active and why
  ```

- **Grep harness configs for literals** (should find nothing in direct mode, except Cursor):

  ```bash
  grep -R "fw_" ~/.claude/settings.json ~/.codex/config.toml \
    ~/.config/opencode/opencode.json ~/.pi/agent ~/.deepagents/config.toml 2>/dev/null
  ```

## Removing everything

```bash
fireconnect claude off && fireconnect vscode off && fireconnect cursor off \
  && fireconnect codex off && fireconnect opencode off && fireconnect pi off \
  && fireconnect deepagents off   # remove per-harness wiring (each restores your prior config)
fireconnect key delete            # remove the stored key from keychain / encrypted file / plain-text fallback
```

`fireconnect key delete` clears the key from all primary-store tiers and removes the `{keychain:fireworks}` reference from `~/.fireconnect/config.json`.

---

*Notes:* Azure/Foundry modes (`--azure`) follow the same environment-reference pattern by default; passing a literal key via `--api-key` writes it to the harness config with file mode `0600`. All FireConnect config writes are atomic (temp file + rename) to prevent partial writes. If this document and the code ever disagree, the code is authoritative — the relevant modules are under [`packages/setup-cli/lib/`](packages/setup-cli/lib/), in particular `secret-store.mjs`, `builtin-file-secret-store.mjs`, `plaintext-secret-store.mjs`, and the per-harness `*-core.mjs` files.
