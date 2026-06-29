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

ensure_node_runtime() {
  if command -v node >/dev/null 2>&1; then
    return
  fi

  echo "Node.js is required for setup."
  echo "The installer uses Node to update settings; it does not install or update npm packages."

  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    read -r -p "Install Node.js with Homebrew now? [y/N] " install_node
    if [[ ! "${install_node}" =~ ^[Yy]$ ]]; then
      echo "Install Node.js from https://nodejs.org or with Homebrew, then rerun this installer." >&2
      exit 1
    fi

    echo "Installing Node.js with Homebrew..."
    brew install node
  elif [[ "$(uname -s)" == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
    read -r -p "Install Node.js with apt now? [y/N] " install_node
    if [[ ! "${install_node}" =~ ^[Yy]$ ]]; then
      echo "Install Node.js from https://nodejs.org or with your package manager, then rerun this installer." >&2
      exit 1
    fi

    echo "Installing Node.js with apt..."
    sudo apt-get update
    sudo apt-get install -y nodejs
  else
    echo "Could not automatically install Node.js." >&2
    echo "Install Node.js from https://nodejs.org, then rerun this installer." >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Missing required command: node" >&2
    exit 1
  fi
}

# The CLI launcher needs a durable copy of the repo; a curl | bash checkout in
# /tmp does not survive reboots, so keep one under ~/.fireconnect/cli.
ensure_durable_source() {
  if [[ -f "${CLI}" ]]; then
    return
  fi

  local install_dir="${HOME}/.fireconnect/cli"
  echo "Downloading FireConnect..."

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

read_api_key() {
  if [[ -n "${FIREWORKS_API_KEY:-}" ]]; then
    return
  fi

  echo "Create a Fireworks API key here:"
  echo "https://app.fireworks.ai/settings/users/api-keys"
  echo "(Fire Pass users: paste your fpk_... key directly.)"
  echo

  # Support interactive, piped (`curl | bash`), and non-interactive stdin flows.
  local read_status=0
  if [[ -t 0 ]]; then
    read -r -s -p "Fireworks API key: " FIREWORKS_API_KEY || read_status=$?
    echo
  else
    IFS= read -r FIREWORKS_API_KEY || read_status=$?
    if [[ -z "${FIREWORKS_API_KEY:-}" ]] && { exec 3<> /dev/tty; } 2>/dev/null; then
      read -r -s -p "Fireworks API key: " FIREWORKS_API_KEY <&3 || read_status=$?
      echo >&3
      exec 3>&-
    fi
  fi

  if [[ ${read_status} -ne 0 && -z "${FIREWORKS_API_KEY:-}" ]]; then
    echo "Failed to read Fireworks API key from terminal." >&2
    echo "Set FIREWORKS_API_KEY in your environment and rerun the installer." >&2
    exit 1
  fi

  FIREWORKS_API_KEY="${FIREWORKS_API_KEY//$'\r'/}"
  if [[ -z "${FIREWORKS_API_KEY//[[:space:]]/}" ]]; then
    echo "Fireworks API key is required." >&2
    exit 1
  fi

  export FIREWORKS_API_KEY
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
      echo "Updated ${shell_config} to include ${bin_dir} on PATH."
    fi
  fi
}

install_cli_launcher() {
  local bin_dir="${HOME}/.local/bin"
  local launcher_path="${bin_dir}/fireconnect"

  mkdir -p "${bin_dir}"

  cat > "${launcher_path}" <<EOF
#!/usr/bin/env bash
# Suppress Node's ExperimentalWarning for node:sqlite (used on Node >= 22).
# --disable-warning landed in Node 21.3.0, so only pass it on >= 22 where the
# warning can actually appear; older Node would reject the flag.
node_flags=""
if node_major=\$(node -p "process.versions.node.split('.')[0]" 2>/dev/null) && [ "\${node_major}" -ge 22 ] 2>/dev/null; then
  node_flags="--disable-warning=ExperimentalWarning"
fi
exec node \${node_flags} "${CLI}" "\$@"
EOF
  chmod +x "${launcher_path}"

  add_bin_dir_to_path
}

main() {
  ensure_node_runtime
  ensure_durable_source

  read_api_key
  node "${CLI}" configure --api-key "${FIREWORKS_API_KEY}" --harnesses claude,opencode
  install_cli_launcher

  echo
  echo "FireConnect is installed."
  echo
  node "${CLI}" help
  echo
  echo "Enable a harness to get started: fireconnect claude on"
}

main "$@"
