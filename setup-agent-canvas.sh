#!/usr/bin/env sh
set -eu

INSTALL_OPTIONAL=0
SKIP_NPM_INSTALL=0
CHECK_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-optional)
      INSTALL_OPTIONAL=1
      ;;
    --skip-npm-install)
      SKIP_NPM_INSTALL=1
      ;;
    --check-only)
      CHECK_ONLY=1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

have() {
  command -v "$1" >/dev/null 2>&1
}

node_major() {
  if have node; then
    node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0'
  else
    printf '0'
  fi
}

sudo_prefix() {
  if [ "$(id -u)" -eq 0 ]; then
    printf ''
  else
    printf 'sudo '
  fi
}

pm() {
  if have apt-get; then
    printf 'apt'
  elif have dnf; then
    printf 'dnf'
  elif have pacman; then
    printf 'pacman'
  elif have brew; then
    printf 'brew'
  else
    printf 'unknown'
  fi
}

install_packages() {
  manager=$(pm)
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "[check] Would install packages with $manager: $*"
    return
  fi
  case "$manager" in
    apt)
      sh -c "$(sudo_prefix)apt-get update"
      sh -c "$(sudo_prefix)apt-get install -y $*"
      ;;
    dnf)
      sh -c "$(sudo_prefix)dnf install -y $*"
      ;;
    pacman)
      sh -c "$(sudo_prefix)pacman -Sy --needed --noconfirm $*"
      ;;
    brew)
      brew install "$@"
      ;;
    *)
      echo "No supported package manager found. Install Node.js 20+ and Git manually." >&2
      exit 1
      ;;
  esac
}

install_node_apt() {
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "[check] Would install Node.js 22.x from NodeSource"
    return
  fi
  sh -c "$(sudo_prefix)apt-get update"
  sh -c "$(sudo_prefix)apt-get install -y ca-certificates curl gnupg"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sh -c "$(sudo_prefix)bash -"
  sh -c "$(sudo_prefix)apt-get install -y nodejs"
}

ensure_node() {
  major=$(node_major)
  if [ "$major" -ge 20 ] 2>/dev/null; then
    echo "[ok] Node.js $(node -v)"
    return
  fi

  manager=$(pm)
  case "$manager" in
    apt)
      install_node_apt
      ;;
    dnf)
      install_packages nodejs npm
      ;;
    pacman)
      install_packages nodejs npm
      ;;
    brew)
      install_packages node
      ;;
    *)
      echo "Node.js 20+ was not found and no supported package manager is available." >&2
      exit 1
      ;;
  esac
}

ensure_git() {
  if have git; then
    echo "[ok] Git"
  else
    install_packages git
  fi
}

try_install_optional() {
  package="$1"
  label="$2"
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "[check] Optional package: $label"
    return
  fi
  set +e
  install_packages "$package"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "[optional] Could not install $label automatically; install it manually if needed."
  fi
}

show_optional_status() {
  command_name="$1"
  label="$2"
  hint="$3"
  if have "$command_name"; then
    echo "[ok] $label"
  else
    echo "[optional] $label not found. $hint"
  fi
}

echo "== Agent Canvas dependency setup =="
ensure_node
ensure_git

if [ "$INSTALL_OPTIONAL" -eq 1 ]; then
  if [ "$(pm)" = "apt" ] || [ "$(pm)" = "dnf" ] || [ "$(pm)" = "pacman" ]; then
    try_install_optional bubblewrap "bubblewrap"
    try_install_optional zenity "zenity"
  elif [ "$(pm)" = "brew" ]; then
    try_install_optional gh "GitHub CLI"
  fi
fi

if [ "$CHECK_ONLY" -ne 1 ] && [ "$SKIP_NPM_INSTALL" -ne 1 ]; then
  if ! have npm; then
    echo "npm was not found after Node.js setup. Restart the shell and rerun this script." >&2
    exit 1
  fi
  echo "Installing npm workspace dependencies..."
  npm install
fi

show_optional_status codex "Codex CLI" "Install Codex, then run 'codex login'."
show_optional_status claude "Claude Code / Claude CLI" "Install Claude Code/CLI or set ANTHROPIC_API_KEY."
show_optional_status gh "GitHub CLI" "Install it if agents should create or merge PRs with gh."
show_optional_status code "VS Code CLI" "Install it if you want file/workspace open buttons."
show_optional_status bwrap "bubblewrap" "Recommended for Codex sandbox support on Linux/WSL."

echo
echo "Done. Next steps:"
echo "  1. Authenticate at least one agent backend: codex login, claude login, or ANTHROPIC_API_KEY."
echo "  2. Start Agent Canvas: npm run start:app -- --no-browser"
