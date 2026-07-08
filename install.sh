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
    read -r -p "Install Node.js with Homebrew now? [y/N] " install_node
    if [[ ! "${install_node}" =~ ^[Yy]$ ]]; then
      print_node_upgrade_instructions
      exit 1
    fi

    echo "Installing Node.js with Homebrew..."
    brew install node
  else
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
  echo "Installing dependencies..."
  if ! (cd "${setup_dir}" && npm install --omit=dev --no-fund --no-audit); then
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
      echo "Updated ${shell_config} to include ${bin_dir} on PATH."
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

  add_bin_dir_to_path
}

main() {
  ensure_node_runtime
  ensure_durable_source
  ensure_dependencies

  install_cli_launcher

  echo
  echo "FireConnect is installed."
  echo
  node "${CLI}" help
  echo
  echo "Sign in to get started:        fireconnect login"
  echo "Then enable a harness:         fireconnect claude on"
}

main "$@"
