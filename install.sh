#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${FIREWORKS_BASE_URL:-https://api.fireworks.ai/inference}"
# When install.sh is piped (curl | bash), BASH_SOURCE[0] is unset; bootstrap from git.
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CLI="${SCRIPT_DIR}/packages/setup-cli/bin/fireconnect.mjs"
else
  SCRIPT_DIR=""
  CLI=""
fi
DEFAULT_SOURCE="https://github.com/fw-ai/fireconnect.git"
SOURCE="${FIRECONNECT_SOURCE:-${DEFAULT_SOURCE}}"
MIN_NODE_MAJOR=18
CLAUDE_SETTINGS_RESTORED=0
INSTALL_NOTES=()

install_progress() {
  echo "→ $*"
}

install_note() {
  INSTALL_NOTES+=("$1")
}

print_install_notes() {
  local note
  # Empty "${array[@]}" is an unbound variable under `set -u` on Bash 3.2 (macOS).
  ((${#INSTALL_NOTES[@]})) || return 0
  for note in "${INSTALL_NOTES[@]}"; do
    echo "Note: ${note}"
  done
}

node_major_version() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0"
}

node_meets_minimum() {
  local major
  major="$(node_major_version)"
  [[ "${major}" =~ ^[0-9]+$ ]] && (( major >= MIN_NODE_MAJOR ))
}

print_node_upgrade_instructions() {
  echo "Install Node.js ${MIN_NODE_MAJOR}+ and rerun this installer." >&2
  echo >&2
  echo "Options:" >&2
  echo "  - https://nodejs.org/en/download" >&2
  echo "  - nvm: https://github.com/nvm-sh/nvm#installing-and-updating" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "  - NodeSource on Debian/Ubuntu (review the setup script before running it):" >&2
    echo "      curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x -o /tmp/nodesource-setup.sh" >&2
    echo "      less /tmp/nodesource-setup.sh" >&2
    echo "      sudo bash /tmp/nodesource-setup.sh && sudo apt-get install -y nodejs" >&2
  fi
}

ensure_node_runtime() {
  # Windows (Git Bash / MSYS / Cygwin): Node is frequently installed but not on
  # the PATH the shell inherits (e.g. C:\Program Files\nodejs). Probe the common
  # install location and add it to PATH for this session before giving up, so
  # the installer doesn't dead-end when Node is present. (gh fw-ai/fireconnect#11)
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      if ! command -v node >/dev/null 2>&1; then
        local win_node candidates=() win_pf
        # Guard the cygpath call inside an `if` so a non-zero exit can't abort
        # the whole installer under `set -e` before the fallback candidate below.
        if command -v cygpath >/dev/null 2>&1 && [[ -n "${PROGRAMFILES:-}" ]] \
          && win_pf="$(cygpath -u "${PROGRAMFILES}" 2>/dev/null)"; then
          candidates+=("${win_pf}/nodejs")
        fi
        candidates+=("/c/Program Files/nodejs")
        for win_node in "${candidates[@]}"; do
          if [[ -x "${win_node}/node.exe" || -x "${win_node}/node" ]]; then
            PATH="${win_node}:${PATH}"
            export PATH
            break
          fi
        done
      fi
      ;;
  esac

  if command -v node >/dev/null 2>&1 && node_meets_minimum; then
    return
  fi

  if command -v node >/dev/null 2>&1; then
    local current
    current="$(node -p "process.versions.node" 2>/dev/null || echo "unknown")"
    echo "Node.js ${MIN_NODE_MAJOR}+ is required (found ${current})." >&2
  else
    echo "Node.js ${MIN_NODE_MAJOR}+ is required for setup." >&2
  fi
  echo "The installer uses Node to update settings; it does not install or update npm packages." >&2

  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    # Prompt from the controlling terminal so this works under `curl … | bash`,
    # where stdin is the script stream (a plain `read -p` prompt never shows and
    # would consume the next line of the script). (gh fw-ai/fireconnect#11)
    if [[ -r /dev/tty ]]; then
      read -r -p "Install Node.js with Homebrew now? [y/N] " install_node </dev/tty
    else
      read -r -p "Install Node.js with Homebrew now? [y/N] " install_node
    fi
    if [[ ! "${install_node}" =~ ^[Yy]$ ]]; then
      print_node_upgrade_instructions
      exit 1
    fi

    echo "Installing Node.js with Homebrew..."
    brew install node
  else
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        echo "On Windows, install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org/ (or add an existing install, e.g. C:\\Program Files\\nodejs, to your PATH) and re-run this script." >&2
        ;;
    esac
    print_node_upgrade_instructions
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Missing required command: node" >&2
    exit 1
  fi

  if ! node_meets_minimum; then
    local current
    current="$(node -p "process.versions.node" 2>/dev/null || echo "unknown")"
    echo "Node.js ${MIN_NODE_MAJOR}+ is still required after install (found ${current})." >&2
    print_node_upgrade_instructions
    exit 1
  fi
}

existing_fireconnect_cli() {
  local home_launcher="${HOME}/.local/bin/fireconnect"
  if [[ -e "${home_launcher}" || -L "${home_launcher}" ]]; then
    printf '%s\n' "${home_launcher}"
    return
  fi

  local path_launcher
  path_launcher="$(command -v fireconnect 2>/dev/null || true)"
  if [[ -n "${path_launcher}" ]]; then
    printf '%s\n' "${path_launcher}"
  fi
}

# Exit 0 when Claude is still FireConnect-managed, 1 when it is not, and 2
# when the state cannot be inspected safely.
claude_is_fireconnect_enabled() {
  node - "${HOME}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const home = process.argv[2];

function readJson(relativePath) {
  const filePath = path.join(home, relativePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    console.error(`Unable to inspect ${filePath}: ${error.message}`);
    process.exit(2);
  }
}

const globalConfig = readJson(".fireconnect/config.json");
if (globalConfig?.harnesses?.claude?.enabled === true) {
  process.exit(0);
}

const settings = readJson(".claude/settings.json");
const env = settings?.env && typeof settings.env === "object" ? settings.env : {};
let hostname = "";
try {
  hostname = new URL(env.ANTHROPIC_BASE_URL).hostname.toLowerCase();
} catch {
  process.exit(1);
}
if (hostname !== "fireworks.ai" && !hostname.endsWith(".fireworks.ai")) {
  process.exit(1);
}

const backup = readJson(".fireconnect/claude/provider-backup.json");
const state = readJson(".fireconnect/claude/provider-state.json");
const headers = typeof env.ANTHROPIC_CUSTOM_HEADERS === "string"
  ? env.ANTHROPIC_CUSTOM_HEADERS.split("\n").map((line) => {
    const colon = line.indexOf(":");
    return colon === -1
      ? { name: "", value: "" }
      : {
          name: line.slice(0, colon).trim().toLowerCase(),
          value: line.slice(colon + 1).trim(),
        };
  })
  : [];
const header = (name) => headers.find((entry) => entry.name === name)?.value ?? "";
const hasTelemetry = headers.some(({ name, value }) => [
  "x-firerouter-harness",
  "x-title",
  "fireworks-use-case",
  "http-referer",
].includes(name) || (name === "user-agent" && /^fireconnect\//i.test(value)));
const mappingKeys = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];
const isFireworksModelMapping = (value) => {
  if (typeof value !== "string") {
    return false;
  }
  const model = value.trim();
  return model.startsWith("accounts/fireworks/")
    || /^[a-z0-9][a-z0-9._-]*(?:\[1m\])?$/i.test(model);
};
const hasFireworksMapping = mappingKeys.some(
  (key) => isFireworksModelMapping(env[key]),
);
const hasManagedPreset = env.CLAUDE_CODE_ATTRIBUTION_HEADER === "0"
  && env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING === "1";
const fireworksHeader = header("x-fireworks-api-key");
const currentHelper = typeof settings.apiKeyHelper === "string" ? settings.apiKeyHelper : "";
const hasManagedHelper = (
  typeof state.managedApiKeyHelper === "string"
  && currentHelper === state.managedApiKeyHelper
) || (
  /(?:^|[/\\])fireconnect(?:\.mjs)?['"]?(?:\s|$)/.test(currentHelper)
  && /(?:^|\s)key\s+export(?:\s|$)/.test(currentHelper)
);
const hasManagedEvidence = Object.hasOwn(backup, "snapshot")
  || Object.hasOwn(backup, "values")
  || Boolean(state.authMode || state.managedApiKeyHelper)
  || hasManagedHelper
  || env.ANTHROPIC_API_KEY === "fireconnect"
  || Boolean(header("x-firerouter-fireworks-key"))
  || hasTelemetry
  || (
    (fireworksHeader.startsWith("fw_") || fireworksHeader.startsWith("fpk_"))
    && (hasFireworksMapping || hasManagedPreset)
  )
  || (hasFireworksMapping && hasManagedPreset);

process.exit(hasManagedEvidence ? 0 : 1);
NODE
}

confirm_claude_restore() {
  local response
  if ! exec 3<>/dev/tty; then
    echo "Claude Code must be disconnected before upgrading, but no interactive terminal is available." >&2
    echo "Rerun in a terminal, or set FIRECONNECT_AUTO_OFF_CLAUDE=1 for automated installation." >&2
    return 1
  fi

  printf 'Claude Code is currently connected through FireConnect.\n\nFireConnect must temporarily restore your original Claude settings before upgrading.\n\nContinue? [Y/n] ' >&3
  if ! IFS= read -r response <&3; then
    exec 3>&-
    echo "Installation cancelled; Claude Code settings were not changed." >&2
    return 1
  fi
  exec 3>&-

  case "${response}" in
    ""|[Yy]|[Yy][Ee][Ss]) return 0 ;;
    *)
      echo "Installation cancelled; Claude Code settings were not changed." >&2
      return 1
      ;;
  esac
}

preflight_existing_install() {
  local installed_cli
  installed_cli="$(existing_fireconnect_cli)"
  if [[ -z "${installed_cli}" ]]; then
    return
  fi

  local detection_status
  if claude_is_fireconnect_enabled; then
    detection_status=0
  else
    detection_status=$?
  fi
  if (( detection_status == 1 )); then
    return
  fi
  if (( detection_status != 0 )); then
    echo "Installation stopped because the existing Claude Code configuration could not be inspected safely." >&2
    return 1
  fi

  if [[ "${FIRECONNECT_AUTO_OFF_CLAUDE:-}" != "1" ]]; then
    confirm_claude_restore
  fi

  echo "Restoring your original Claude Code settings before upgrading..."
  if ! "${installed_cli}" claude off; then
    echo "Installation stopped because the existing FireConnect CLI could not restore Claude Code settings." >&2
    return 1
  fi

  if claude_is_fireconnect_enabled; then
    echo "Installation stopped because Claude Code is still managed by FireConnect after running 'claude off'." >&2
    return 1
  else
    detection_status=$?
  fi
  if (( detection_status != 1 )); then
    echo "Installation stopped because the restored Claude Code configuration could not be verified safely." >&2
    return 1
  fi

  CLAUDE_SETTINGS_RESTORED=1
}

print_claude_restore_summary() {
  if [[ "${CLAUDE_SETTINGS_RESTORED}" != "1" ]]; then
    return
  fi
  echo
  echo "Your original Claude Code settings were restored before the upgrade."
  echo "Reconnect Claude Code through FireConnect: fireconnect claude on"
}

ensure_durable_source() {
  if [[ -f "${CLI}" ]]; then
    return
  fi

  local install_dir="${HOME}/.fireconnect/cli"
  install_progress "Downloading FireConnect..."

  if ! command -v git >/dev/null 2>&1; then
    echo "Missing required command: git" >&2
    exit 1
  fi
  rm -rf "${install_dir}"
  mkdir -p "$(dirname "${install_dir}")"
  git clone --quiet --depth 1 "${SOURCE}" "${install_dir}"
  CLI="${install_dir}/packages/setup-cli/bin/fireconnect.mjs"

  if [[ ! -f "${CLI}" ]]; then
    echo "FireConnect CLI not found after download." >&2
    exit 1
  fi
}

# Install runtime dependencies (cross-keychain, used for secure API-key storage).
# Without it, `import("cross-keychain")` fails at runtime and every
# `configure`/`<harness> on --api-key` aborts with "OS keychain is unavailable."
# Run on every install — including re-installs over an existing CLI — so a
# broken (dep-missing) install is repaired by re-running the installer, not just
# by `fireconnect upgrade`. Skips dev/peer deps to keep the install lean.
ensure_dependencies() {
  local setup_dir
  setup_dir="$(cd "$(dirname "${CLI}")/.." && pwd)"
  if [[ ! -f "${setup_dir}/package.json" ]]; then
    echo "FireConnect source not found; cannot install dependencies." >&2
    exit 1
  fi
  install_progress "Installing dependencies..."
  local npm_loglevel=error
  if [[ "${FIRECONNECT_INSTALL_VERBOSE:-}" == "1" ]]; then
    npm_loglevel=notice
  fi
  if ! (cd "${setup_dir}" && npm install --omit=dev --no-fund --no-audit --loglevel="${npm_loglevel}"); then
    echo "Failed to install FireConnect dependencies." >&2
    exit 1
  fi
}

add_bin_dir_to_path() {
  local bin_dir="${HOME}/.local/bin"
  local path_entry="export PATH=\"${bin_dir}:\$PATH\""
  local shell_config=""

  if [[ -n "${ZSH_VERSION:-}" || "${SHELL:-}" == *"zsh" ]]; then
    shell_config="${HOME}/.zshrc"
  elif [[ -n "${BASH_VERSION:-}" || "${SHELL:-}" == *"bash" ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      shell_config="${HOME}/.bash_profile"
    else
      shell_config="${HOME}/.bashrc"
    fi
  fi

  if [[ -n "${shell_config}" ]]; then
    touch "${shell_config}"
    if ! grep -qxF "${path_entry}" "${shell_config}" 2>/dev/null; then
      echo "${path_entry}" >> "${shell_config}"
      install_note "Added ${bin_dir} to PATH in ${shell_config} (open a new terminal if fireconnect is not found)."
    fi
  fi
}

install_cli_launcher() {
  local bin_dir="${HOME}/.local/bin"
  local launcher_path="${bin_dir}/fireconnect"

  mkdir -p "${bin_dir}"

  # Resolve an absolute Node path at install time and bake it into the launcher,
  # with a PATH fallback. This keeps the launcher (and the shell env hook's
  # `fireconnect key export`) working in non-interactive shells where `node`
  # is not on PATH — common in sandboxes, containers, and CI.
  local node_bin
  node_bin="$(command -v node 2>/dev/null || true)"

  cat > "${launcher_path}" <<EOF
#!/usr/bin/env bash
# FireConnect launcher. Uses the Node binary discovered at install time, falling
# back to PATH lookup, so the shell env hook works without \`node\` on PATH.
NODE_BIN="\${FIRECONNECT_NODE_BIN:-${node_bin}}"
[ -x "\$NODE_BIN" ] || NODE_BIN="\$(command -v node 2>/dev/null)"
if [ -z "\$NODE_BIN" ] || ! [ -x "\$NODE_BIN" ]; then
  echo "fireconnect: Node.js was not found. Install Node and re-run the FireConnect installer." >&2
  exit 1
fi
# Suppress Node's ExperimentalWarning for node:sqlite (Node >= 22).
# --disable-warning landed in Node 21.3.0; older Node would reject the flag.
node_flags=""
if node_major="\$(\$NODE_BIN -p "process.versions.node.split('.')[0]" 2>/dev/null)" && [ "\${node_major}" -ge 22 ] 2>/dev/null; then
  node_flags="--disable-warning=ExperimentalWarning"
fi
exec "\$NODE_BIN" \${node_flags} "${CLI}" "\$@"
EOF
  chmod +x "${launcher_path}"

  install_windows_cmd_shim "${node_bin}"
  add_bin_dir_to_path
}

# On Windows (Git Bash / MSYS / Cygwin) the bash launcher above only works from
# a POSIX shell. Also drop a `fireconnect.cmd` shim so native cmd.exe/PowerShell
# can run `fireconnect`. Best-effort and Windows-only: it needs `cygpath` to
# translate the Unix node/CLI paths to Windows paths, and silently no-ops
# otherwise so it can never break a macOS/Linux install.
install_windows_cmd_shim() {
  local node_bin="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) return 0 ;;
  esac
  command -v cygpath >/dev/null 2>&1 || return 0

  local bin_dir="${HOME}/.local/bin"
  local cmd_path="${bin_dir}/fireconnect.cmd"
  local node_src node_win cli_win node_flags node_major_for_shim
  node_src="${node_bin:-$(command -v node 2>/dev/null || true)}"
  [[ -n "${node_src}" ]] || return 0
  node_win="$(cygpath -w "${node_src}" 2>/dev/null || true)"
  cli_win="$(cygpath -w "${CLI}" 2>/dev/null || true)"
  [[ -n "${node_win}" && -n "${cli_win}" ]] || return 0

  if node_major_for_shim="$("${node_src}" -p "process.versions.node.split('.')[0]" 2>/dev/null)" \
    && [[ "${node_major_for_shim}" =~ ^[0-9]+$ ]] && (( node_major_for_shim >= 22 )); then
    node_flags="--disable-warning=ExperimentalWarning"
  else
    node_flags=""
  fi

  mkdir -p "${bin_dir}"
  if [[ -n "${node_flags}" ]]; then
    cat > "${cmd_path}" <<EOF
@echo off
"${node_win}" ${node_flags} "${cli_win}" %*
EOF
  else
    cat > "${cmd_path}" <<EOF
@echo off
"${node_win}" "${cli_win}" %*
EOF
  fi
  install_note "Wrote a Windows launcher shim at ${cmd_path}."
}

main() {
  ensure_node_runtime
  preflight_existing_install
  ensure_durable_source
  ensure_dependencies

  install_progress "Installing CLI..."
  install_cli_launcher

  local banner_script
  banner_script="$(dirname "${CLI}")/fireconnect-banner.mjs"
  node "${banner_script}" --context install
  node "${CLI}" help quick
  print_install_notes
  print_claude_restore_summary
}

main "$@"
