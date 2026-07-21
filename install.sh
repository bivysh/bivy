#!/usr/bin/env bash
#
# Bivy — one-line installer.
#
#   curl -fsSL https://bivy.sh/install.sh | bash
#
# This script does three things:
#   1. makes sure a supported Node.js is present (installing it on Debian/Ubuntu),
#   2. installs the `bivy` package from npm,
#   3. runs `bivy setup`, or restarts an existing background service.
#
# Distribution integrity is npm's: the registry serves content-addressed
# tarballs and npm verifies each package's integrity hash on install. Releases
# are published from CI with provenance attestations, so you can check where a
# given version was built:
#
#   npm audit signatures
#   npm view bivy dist.integrity
#
# Overrides:
#   BIVY_VERSION=0.1.0            install a specific version instead of latest
#   BIVY_NPM_PREFIX=~/.local      install into a user-owned npm prefix (no sudo)
#   BIVY_INSTALL_ALL_AGENTS=1     preinstall every bundled agent runtime
#
set -euo pipefail

PKG_VERSION="${BIVY_VERSION:-latest}"
DATA_DIR="${BIVY_DATA_DIR:-$HOME/.bivy}"
LEGACY_APP_DIR="${BIVY_HOME:-$HOME/.bivy/app}"

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then "$@";
  elif command -v sudo >/dev/null 2>&1; then sudo "$@";
  else return 1;
  fi
}

# ---------------------------------------------------------------- prerequisites

install_ubuntu_prereqs() {
  command -v apt-get >/dev/null 2>&1 || return 0
  if command -v curl >/dev/null 2>&1 && command -v make >/dev/null 2>&1 \
     && command -v g++ >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  info "Installing build prerequisites"
  run_sudo apt-get update
  run_sudo apt-get install -y curl ca-certificates build-essential python3
}

install_ubuntu_node22() {
  command -v apt-get >/dev/null 2>&1 || return 1
  info "Installing Node.js 22"
  run_sudo apt-get update
  run_sudo apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | run_sudo bash -
  run_sudo apt-get install -y nodejs
}

node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -p 'const [M,m]=process.versions.node.split(".").map(Number); +(M>22 || (M===22 && m>=19))' 2>/dev/null)" = "1" ]
}

install_ubuntu_prereqs || true
command -v curl >/dev/null 2>&1 || die "curl is required. Install it and re-run."

if ! node_is_supported; then
  install_ubuntu_node22 || true
fi
if ! node_is_supported; then
  if command -v node >/dev/null 2>&1; then
    die "Node.js 22.19+ is required (found $(node -v)). Upgrade from https://nodejs.org and re-run."
  fi
  die "Node.js 22.19+ is required but was not found. Install it from https://nodejs.org and re-run."
fi
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

if command -v apt-get >/dev/null 2>&1 && { ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; }; then
  die "Build tools are missing. Install them with: sudo apt-get update && sudo apt-get install -y build-essential python3"
fi

# macOS: node-pty may need to compile, which requires the Xcode Command Line
# Tools. Warn early with the exact fix rather than letting npm fail with a
# node-gyp backtrace. A matching prebuilt binary may avoid compilation entirely,
# so this is a warning, not a hard stop.
if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools not detected. If the install below fails building node-pty, run 'xcode-select --install' and re-run."
fi

# ------------------------------------------------------------------ install

npm_global_bin() {
  local prefix
  prefix="$(npm prefix -g 2>/dev/null || true)"
  [ -n "$prefix" ] && printf '%s/bin' "$prefix"
}

install_globally() {
  local args=(install -g "bivy@${PKG_VERSION}" --no-audit --no-fund)
  if [ -n "${BIVY_NPM_PREFIX:-}" ]; then
    info "Installing bivy@${PKG_VERSION} into ${BIVY_NPM_PREFIX}"
    npm "${args[@]}" --prefix "$BIVY_NPM_PREFIX"
    return
  fi
  info "Installing bivy@${PKG_VERSION} from npm"
  if npm "${args[@]}" 2>"$ERR_LOG"; then
    return 0
  fi
  # The classic failure: the global prefix is root-owned. Rather than silently
  # escalating with sudo (which then leaves root-owned files the user cannot
  # update later), fall back to a user-owned prefix and tell them about it.
  if grep -qiE 'EACCES|permission denied' "$ERR_LOG"; then
    warn "No write access to npm's global prefix ($(npm prefix -g 2>/dev/null))."
    info "Installing into $HOME/.local instead — no sudo required."
    BIVY_NPM_PREFIX="$HOME/.local"
    npm "${args[@]}" --prefix "$BIVY_NPM_PREFIX"
    return
  fi
  cat "$ERR_LOG" >&2
  die "npm could not install bivy. See the error above."
}

ERR_LOG="$(mktemp)"
trap 'rm -f "$ERR_LOG"' EXIT
install_globally

if [ -n "${BIVY_NPM_PREFIX:-}" ]; then
  BIN_DIR="$BIVY_NPM_PREFIX/bin"
else
  BIN_DIR="$(npm_global_bin)"
fi
BIVY_BIN="$BIN_DIR/bivy"
[ -x "$BIVY_BIN" ] || die "bivy was installed but no executable was found at $BIVY_BIN."

# ------------------------------------------------------- migrate legacy state
#
# Installs made by the previous tarball installer keep their state *inside* the
# app directory (~/.bivy/app/.bivy). A global npm package directory is replaced
# on every update, so state now lives at ~/.bivy. Move it once, and only when
# the destination is empty, so this can never clobber newer state.

if [ -d "$LEGACY_APP_DIR/.bivy" ] && [ ! -f "$DATA_DIR/cli.json" ]; then
  info "Migrating existing Bivy state to $DATA_DIR"
  mkdir -p "$DATA_DIR"
  if ! (cd "$LEGACY_APP_DIR/.bivy" && tar cf - .) | (cd "$DATA_DIR" && tar xf -); then
    die "Could not migrate state from $LEGACY_APP_DIR/.bivy to $DATA_DIR. Your old install is untouched; copy it across manually and re-run."
  fi
  # install.json described the old tarball release; it means nothing now.
  rm -f "$DATA_DIR/install.json"
  info "Migrated. The previous install at $LEGACY_APP_DIR is no longer used."
  warn "Once you've confirmed things work, remove it with: rm -rf $LEGACY_APP_DIR"
fi

# A stale symlink from the old installer can shadow the npm-installed binary if
# ~/.local/bin comes first on PATH. Remove it only if it points at the old tree.
STALE_LINK="$HOME/.local/bin/bivy"
if [ -L "$STALE_LINK" ]; then
  TARGET="$(readlink "$STALE_LINK" || true)"
  case "$TARGET" in
    "$LEGACY_APP_DIR"/*)
      if [ "$STALE_LINK" != "$BIVY_BIN" ]; then
        info "Removing stale 'bivy' symlink from the previous install"
        rm -f "$STALE_LINK"
      fi
      ;;
  esac
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "Add $BIN_DIR to your PATH to use the 'bivy' command:"
     printf '     export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
esac

# ------------------------------------------------------------------- finish

if [ "${BIVY_INSTALL_ALL_AGENTS:-}" = "1" ]; then
  info "Installing all bundled agent runtimes"
  "$BIVY_BIN" agents:install || warn "Could not install every bundled agent runtime. Bivy still works; run 'bivy agents:install' later to retry."
fi

if [ -f "$DATA_DIR/cli.json" ]; then
  info "Existing Bivy configuration found; skipping first-run setup."
  if node -e 'const fs=require("fs");process.exit(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).service===true?0:1)' "$DATA_DIR/cli.json" 2>/dev/null; then
    info "Restarting the background service…"
    "$BIVY_BIN" restart || warn "Could not restart the service automatically. Run: bivy restart"
  else
    info "Update complete. Start Bivy with: bivy start"
  fi
else
  info "Launching setup…"
  if [ -r /dev/tty ] && "$BIVY_BIN" setup </dev/tty; then
    :
  else
    warn "No interactive terminal detected. Finish setup by running:"
    echo "  bivy setup"
  fi
fi
