#!/usr/bin/env bash
#
# Bivy — one-line installer.
#
#   curl -fsSL https://bivy.sh/install.sh | bash
#
# This script does three things:
#   1. makes sure a supported Node.js is present (installing it on Debian/Ubuntu),
#   2. installs the `@bivy/bivy` package from npm,
#   3. runs `bivy setup`, or restarts an existing background service.
#
# Distribution integrity is npm's: the registry serves content-addressed
# tarballs and npm verifies each package's integrity hash on install. Releases
# are published from CI with provenance attestations, so you can check where a
# given version was built:
#
#   npm audit signatures
#   npm view @bivy/bivy dist.integrity
#
# If the package is not on the registry yet, the script falls back to the
# self-hosted release tarball (see "Tarball fallback" below) so that a fresh
# install — and `bivy update`, which shells out to this script for packaged
# installs — keeps working through the cutover to npm.
#
# Overrides:
#   BIVY_VERSION=0.1.0            install a specific version instead of latest
#   BIVY_CHANNEL=staging          install the latest dev build off the `staging`
#                                 dist-tag (every merge to main); default `latest`
#   BIVY_NPM_PREFIX=~/.local      install into a user-owned npm prefix (no sudo)
#   BIVY_NPM_LOGLEVEL=warn        reduce npm's live install output (default: info)
#   BIVY_INSTALL_ALL_AGENTS=1     preinstall every bundled agent runtime
#   BIVY_NO_TARBALL_FALLBACK=1    fail instead of falling back to the tarball
#   BIVY_NO_RC_UPDATE=1           don't add BIN_DIR to ~/.bashrc or ~/.zshrc;
#                                 just print the manual `export PATH=...` line
#
set -euo pipefail

# BIVY_VERSION pins an exact version; BIVY_CHANNEL selects a dist-tag
# (latest | staging). BIVY_VERSION wins if both are set.
PKG_VERSION="${BIVY_VERSION:-${BIVY_CHANNEL:-latest}}"
NPM_PACKAGE="@bivy/bivy"
DATA_DIR="${BIVY_DATA_DIR:-$HOME/.bivy}"
# Also the destination for a tarball-fallback install, whose state lives inside
# the app directory rather than at $DATA_DIR.
LEGACY_APP_DIR="${BIVY_HOME:-$HOME/.bivy/app}"
TARBALL_URL="${BIVY_TARBALL_URL:-https://bivy.sh/downloads/bivy-latest.tar.gz}"
MANIFEST_URL="${BIVY_MANIFEST_URL:-https://bivy.sh/downloads/bivy-latest.json}"
# "npm" until install_globally decides otherwise; the post-install steps differ
# because a tarball install keeps a different layout.
INSTALL_MODE="npm"

INSTALL_STARTED_SECONDS=$SECONDS

elapsed() { printf '%ss' "$((SECONDS - INSTALL_STARTED_SECONDS))"; }
info() { printf '\033[36m==>\033[0m [%s] %s\n' "$(elapsed)" "$1"; }
warn() { printf '\033[33m==>\033[0m [%s] %s\n' "$(elapsed)" "$1"; }
die()  { printf '\033[31mError:\033[0m [%s] %s\n' "$(elapsed)" "$1" >&2; exit 1; }

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

# Provider-agnostic fallback: install the official Node.js 22 binary straight
# from nodejs.org into /usr/local. This is what keeps a headless/ephemeral
# machine (Fly, or any minimal image) working when the nodesource apt path is
# unavailable — as of this writing deb.nodesource.com/setup_22.x returns 403, so
# apt otherwise falls back to the distro's Node 18, which is too old for Bivy.
# The download is sha256-verified against the release's SHASUMS256.txt (same
# integrity posture as the Bivy tarball fallback). Uses the .tar.gz build so no
# xz-utils is needed on a bare image.
install_node22_tarball() {
  local os arch base shasums name want got tmp dir
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  command -v curl >/dev/null 2>&1 || return 1
  command -v tar >/dev/null 2>&1 || return 1
  info "Installing Node.js 22 from nodejs.org"
  base="https://nodejs.org/dist/latest-v22.x"
  shasums="$(curl -fsSL "$base/SHASUMS256.txt")" || return 1
  name="$(printf '%s\n' "$shasums" | grep -oE "node-v22\.[0-9.]+-${os}-${arch}\.tar\.gz" | head -n1)"
  [ -n "$name" ] || return 1
  tmp="$(mktemp -d)" || return 1
  curl -fsSL -o "$tmp/$name" "$base/$name" || { rm -rf "$tmp"; return 1; }
  want="$(printf '%s\n' "$shasums" | awk -v n="$name" '$2==n{print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$tmp/$name" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$tmp/$name" | awk '{print $1}')"
  fi
  if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then
    rm -rf "$tmp"
    die "Node.js download failed sha256 verification (expected $want, got $got)."
  fi
  run_sudo mkdir -p /usr/local/lib/nodejs
  run_sudo tar -xzf "$tmp/$name" -C /usr/local/lib/nodejs || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  dir="/usr/local/lib/nodejs/${name%.tar.gz}"
  local b
  for b in node npm npx; do
    run_sudo ln -sf "$dir/bin/$b" "/usr/local/bin/$b"
  done
  command -v node >/dev/null 2>&1 || export PATH="/usr/local/bin:$PATH"
}

node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -p 'const [M]=process.versions.node.split(".").map(Number); +(M>=20)' 2>/dev/null)" = "1" ]
}

# Keep the common path fast: build tools are needed only when optional native
# dependencies (notably node-pty) cannot use a prebuilt binary, so do not run an
# unconditional apt-get update here.
command -v curl >/dev/null 2>&1 || die "curl is required. Install it and re-run."

if ! node_is_supported; then
  install_ubuntu_node22 || true
fi
# When the distro path can't get us a supported Node (e.g. nodesource is
# unreachable and apt only offers an old Node), pull the official binary.
if ! node_is_supported; then
  install_node22_tarball || true
  hash -r 2>/dev/null || true
fi
if ! node_is_supported; then
  if command -v node >/dev/null 2>&1; then
    die "Node.js 20+ is required (found $(node -v)). Upgrade from https://nodejs.org and re-run."
  fi
  die "Node.js 20+ is required but was not found. Install it from https://nodejs.org and re-run."
fi
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."
info "Node $(node -v) and npm $(npm -v) ready"

if command -v apt-get >/dev/null 2>&1 && { ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; }; then
  warn "Build tools are missing. Interactive terminal support may be unavailable if node-pty cannot use a prebuilt binary. Install them with: sudo apt-get update && sudo apt-get install -y build-essential python3"
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

# ------------------------------------------------------------ tarball fallback
#
# npm is the distribution channel, but a registry 404 — the package is not
# published yet, or was unpublished — must not leave users stranded. It would
# strand two groups at once: anyone running this script for a fresh install,
# and every existing *packaged* install, because `bivy update` shells out to
# this very script for those (see runUpdate() in bin/bivy.mjs).
#
# So fall back to the self-hosted release archive, verified against the sha256
# in its manifest. Deliberately integrity-checked but unsigned: the manifest
# carries a sha256 and no signature, which is what the pre-npm installer
# enforced in practice — its signature branch needed a verification key that
# was never embedded. This therefore reintroduces no key to guard or rotate.

extract_tarball() {
  # GNU tar warns about macOS-created archives carrying extended-attribute
  # headers; it can ignore them quietly, and other tars never warn at all.
  if tar --version 2>/dev/null | grep -qi 'gnu tar'; then
    tar --warning=no-unknown-keyword --no-same-owner -xzf "$1" -C "$2"
  else
    tar -xzf "$1" -C "$2"
  fi
}

sha256_of() {
  node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}

install_from_tarball() {
  INSTALL_MODE="tarball"
  local parent stage staged backup expected actual
  parent="$(dirname "$LEGACY_APP_DIR")"

  # A previous install owned by another user (the classic cause: a first
  # install run under sudo) cannot be replaced by us. Detect it now, while the
  # working install is still untouched, rather than partway through the swap.
  if [ -e "$LEGACY_APP_DIR" ] && [ "$(id -u)" -ne 0 ] && [ ! -w "$LEGACY_APP_DIR" ]; then
    die "Cannot install: $LEGACY_APP_DIR is not writable by $(id -un) — it was likely installed with sudo or as another user. Re-run as the owner, or reclaim it with 'sudo chown -R $(id -un) $LEGACY_APP_DIR'. Your current install was left untouched."
  fi

  info "Downloading the release archive"
  curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/bivy.tar.gz" || die "Could not download $TARBALL_URL."

  expected=""
  if curl -fsSL "$MANIFEST_URL" -o "$TMP_DIR/bivy-latest.json" 2>/dev/null && [ -s "$TMP_DIR/bivy-latest.json" ]; then
    expected="$(node -e 'const fs=require("fs");try{const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof m.sha256==="string"?m.sha256:"")}catch{}' "$TMP_DIR/bivy-latest.json")"
  fi
  if [ -n "$expected" ]; then
    actual="$(sha256_of "$TMP_DIR/bivy.tar.gz")"
    [ "$actual" = "$expected" ] || die "Release archive checksum mismatch (expected $expected, got $actual). Refusing to install; please re-run."
  elif [ "${BIVY_ALLOW_UNVERIFIED_INSTALL:-}" = "1" ]; then
    warn "No sha256 available for the release archive; continuing because BIVY_ALLOW_UNVERIFIED_INSTALL=1."
  else
    die "Could not verify the release archive: no sha256 in $MANIFEST_URL. Re-run, or set BIVY_ALLOW_UNVERIFIED_INSTALL=1 only if you trust $TARBALL_URL."
  fi

  mkdir -p "$parent"
  stage="$(mktemp -d "$parent/.bivy-install.XXXXXX")"
  extract_tarball "$TMP_DIR/bivy.tar.gz" "$stage"
  staged="$stage/bivy"
  [ -d "$staged" ] || die "The release archive did not contain a bivy/ directory."
  chmod +x "$staged/bin/bivy.mjs"

  info "Installing production dependencies"
  local omit_flags=(--omit=dev)
  if [ "${BIVY_INSTALL_OPTIONAL_DEPS:-}" != "1" ]; then
    omit_flags+=(--omit=optional)
  fi
  if ! ( cd "$staged" && if [ -f package-lock.json ]; then npm ci "${omit_flags[@]}" --no-audit --no-fund; else npm install "${omit_flags[@]}" --no-audit --no-fund; fi ); then
    rm -rf "$stage"
    die "Could not install Bivy's dependencies. Your current install was left untouched."
  fi

  # Swap it in: move any existing install aside, carry its state across, then
  # move the new tree into place — restoring the old one if any step fails, so
  # a failure can never leave the node with no app directory.
  backup=""
  if [ -e "$LEGACY_APP_DIR" ]; then
    backup="$parent/.bivy-backup.$$"
    rm -rf "$backup"
    if ! mv "$LEGACY_APP_DIR" "$backup"; then
      rm -rf "$stage"
      die "Could not move the existing install at $LEGACY_APP_DIR aside (it may be a mount point or on a separate filesystem). Your current install was left untouched."
    fi
    if [ -d "$backup/.bivy" ]; then
      info "Carrying existing local state into the new release"
      rm -rf "$staged/.bivy"
      if ! mv "$backup/.bivy" "$staged/.bivy"; then
        mv "$backup" "$LEGACY_APP_DIR"
        rm -rf "$stage"
        die "Could not carry your existing state (.bivy) into the new release; the previous install was restored."
      fi
    fi
  fi

  mkdir -p "$staged/.bivy"
  if [ -s "$TMP_DIR/bivy-latest.json" ]; then
    cp "$TMP_DIR/bivy-latest.json" "$staged/.bivy/install.json"
    chmod 600 "$staged/.bivy/install.json" 2>/dev/null || true
  fi

  if ! mv "$staged" "$LEGACY_APP_DIR"; then
    if [ -n "$backup" ]; then
      # Put the preserved state back before restoring, or it would be lost.
      if [ -d "$staged/.bivy" ] && [ ! -e "$backup/.bivy" ]; then
        mv "$staged/.bivy" "$backup/.bivy" 2>/dev/null || true
      fi
      mv "$backup" "$LEGACY_APP_DIR"
    fi
    rm -rf "$stage"
    die "Could not move the new release into $LEGACY_APP_DIR; the previous install was restored."
  fi

  rm -rf "$stage"
  if [ -n "$backup" ]; then rm -rf "$backup"; fi

  mkdir -p "$HOME/.local/bin"
  ln -sfn "$LEGACY_APP_DIR/bin/bivy.mjs" "$HOME/.local/bin/bivy"
  BIN_DIR="$HOME/.local/bin"
  BIVY_BIN="$BIN_DIR/bivy"
  info "Installed Bivy into $LEGACY_APP_DIR"
}

# npm leaves ".<pkg>-XXXXXX" temp dirs behind when an install is interrupted;
# a leftover collides with the next atomic rename and fails the WHOLE install
# with ENOTEMPTY. They are always abandoned artifacts, so clear them before
# installing. Best-effort and scoped to Bivy's own npm temp dirs.
clear_stale_npm_temp() {
  local scope="${1:-}/lib/node_modules/@bivy"
  { [ -n "${1:-}" ] && [ -d "$scope" ] && find "$scope" -maxdepth 1 -name '.bivy-*' -exec rm -rf {} + 2>/dev/null; } || true
}

# Keep npm's output visible while also retaining it for the permission/404
# diagnostics below. Redirecting stderr only to ERR_LOG made a healthy install
# look frozen for minutes because npm writes all fetch and lifecycle progress
# there. `tee` gives the user live activity without sacrificing those checks.
run_npm_install() {
  npm "$@" 2>&1 | tee "$ERR_LOG"
  return "${PIPESTATUS[0]}"
}

install_globally() {
  local args=(install -g "${NPM_PACKAGE}@${PKG_VERSION}" --no-audit --no-fund --loglevel="${BIVY_NPM_LOGLEVEL:-info}")
  if [ "${BIVY_INSTALL_OPTIONAL_DEPS:-}" != "1" ]; then
    args+=(--omit=optional)
  fi
  if [ -n "${BIVY_NPM_PREFIX:-}" ]; then
    info "Installing ${NPM_PACKAGE}@${PKG_VERSION} into ${BIVY_NPM_PREFIX}"
    clear_stale_npm_temp "$BIVY_NPM_PREFIX"
    npm "${args[@]}" --prefix "$BIVY_NPM_PREFIX"
    return
  fi
  info "Installing ${NPM_PACKAGE}@${PKG_VERSION} from npm"
  clear_stale_npm_temp "$(npm prefix -g 2>/dev/null)"
  if run_npm_install "${args[@]}"; then
    return 0
  fi
  # The classic failure: the global prefix is root-owned. Rather than silently
  # escalating with sudo (which then leaves root-owned files the user cannot
  # update later), fall back to a user-owned prefix and tell them about it.
  if grep -qiE 'EACCES|permission denied' "$ERR_LOG"; then
    warn "No write access to npm's global prefix ($(npm prefix -g 2>/dev/null))."
    info "Installing into $HOME/.local instead — no sudo required."
    BIVY_NPM_PREFIX="$HOME/.local"
    clear_stale_npm_temp "$BIVY_NPM_PREFIX"
    npm "${args[@]}" --prefix "$BIVY_NPM_PREFIX"
    return
  fi
  # The package is not on the registry. Confirm with a direct lookup rather
  # than trusting the error text alone — a 404 in the install log could just as
  # easily come from a missing transitive dependency, which the tarball (built
  # from the same package.json) would not fix either.
  if grep -qiE 'E404|404 Not Found' "$ERR_LOG" && ! npm view "${NPM_PACKAGE}@${PKG_VERSION}" version >/dev/null 2>&1; then
    if [ "${BIVY_NO_TARBALL_FALLBACK:-}" = "1" ]; then
      cat "$ERR_LOG" >&2
      die "${NPM_PACKAGE}@${PKG_VERSION} is not published on npm, and BIVY_NO_TARBALL_FALLBACK=1."
    fi
    warn "${NPM_PACKAGE}@${PKG_VERSION} is not on the npm registry yet — using the release archive instead."
    install_from_tarball
    return
  fi
  cat "$ERR_LOG" >&2
  die "npm could not install ${NPM_PACKAGE}. See the error above."
}

ERR_LOG="$(mktemp)"
TMP_DIR="$(mktemp -d)"
trap 'rm -f "$ERR_LOG"; rm -rf "$TMP_DIR"' EXIT
# Quiesce any already-running node before reinstalling. A crash-looping service
# auto-restarts every few seconds and races the npm extraction — which is how an
# install gets corrupted (half-written deps / leftover temp dirs) in the first
# place. Best-effort and only when a bivy is already on PATH; a fresh install has
# nothing to stop, and the existing-config branch below restarts it afterward.
if command -v bivy >/dev/null 2>&1; then
  info "Stopping any existing Bivy node before updating"
  bivy stop >/dev/null 2>&1 || true
fi
install_globally
info "Bivy package installed"

# A tarball fallback has already set BIN_DIR/BIVY_BIN to the install it made.
if [ "$INSTALL_MODE" = "npm" ]; then
  if [ -n "${BIVY_NPM_PREFIX:-}" ]; then
    BIN_DIR="$BIVY_NPM_PREFIX/bin"
  else
    BIN_DIR="$(npm_global_bin)"
  fi
  BIVY_BIN="$BIN_DIR/bivy"
fi
# The install can "succeed" yet leave no runnable `bivy`. By far the most common
# cause before launch is that the requested channel points at a PLACEHOLDER
# release with no executable — e.g. `latest` is a 0.0.0 stub until a production
# release is promoted. npm installs that happily, then has nothing to link, and a
# bare "no executable at <path>" sends people hunting for a PATH bug that isn't
# there. Diagnose the two real cases (binless release vs. prefix/PATH mismatch)
# and say what to do.
if [ ! -x "$BIVY_BIN" ]; then
  pkg_json=""
  if [ "$INSTALL_MODE" = "npm" ]; then
    if [ -n "${BIVY_NPM_PREFIX:-}" ]; then
      pkg_json="$BIVY_NPM_PREFIX/lib/node_modules/${NPM_PACKAGE}/package.json"
    else
      pkg_json="$(npm root -g 2>/dev/null)/${NPM_PACKAGE}/package.json"
    fi
  fi
  # Binless-release case: the package installed but declares no `bin`.
  if [ -n "$pkg_json" ] && [ -f "$pkg_json" ] \
     && ! node -e 'const b=require(process.argv[1]).bin;process.exit(b&&(typeof b==="string"||Object.keys(b).length)?0:1)' "$pkg_json" 2>/dev/null; then
    ver="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).version||"?"))}catch(e){process.stdout.write("?")}' "$pkg_json" 2>/dev/null || echo "?")"
    warn "${NPM_PACKAGE}@${PKG_VERSION} resolved to version ${ver}, which ships no 'bivy' executable —"
    warn "that channel only has a placeholder release so far, so there is nothing to run yet."
    if [ "${BIVY_CHANNEL:-latest}" != "staging" ] && [ -z "${BIVY_VERSION:-}" ]; then
      die "No published build on the '${BIVY_CHANNEL:-latest}' channel yet. Install the current dev build:
    npm i -g ${NPM_PACKAGE}@staging
  (or re-run this installer with BIVY_CHANNEL=staging, once a channel-aware install.sh is served)."
    fi
    die "The '${PKG_VERSION}' release ships no executable. Pick a channel/version with a published build — see: npm view ${NPM_PACKAGE} dist-tags"
  fi
  # Otherwise the package has a bin but it isn't where we looked: a prefix/PATH mismatch.
  die "bivy installed but no executable was found at $BIVY_BIN.
Your npm global bin dir may differ from '$BIN_DIR' — check: npm prefix -g   (its bin/ must be on PATH)."
fi

# ------------------------------------------------------- migrate legacy state
#
# Installs made by the previous tarball installer keep their state *inside* the
# app directory (~/.bivy/app/.bivy). A global npm package directory is replaced
# on every update, so state now lives at ~/.bivy. Move it once, and only when
# the destination is empty, so this can never clobber newer state.

if [ "$INSTALL_MODE" = "npm" ] && [ -d "$LEGACY_APP_DIR/.bivy" ] && [ ! -f "$DATA_DIR/cli.json" ]; then
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
if [ "$INSTALL_MODE" = "npm" ] && [ -L "$STALE_LINK" ]; then
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

# --------------------------------------------------------------- PATH on rerun
#
# A child process (this script) cannot change its parent shell's PATH, so if
# BIN_DIR isn't already on PATH, the *current* terminal will never see 'bivy'
# no matter what we do here. Printing an `export PATH=...` line for the user to
# copy-paste used to be the whole fix — but nobody re-runs that in every new
# terminal either, so 'bivy' silently stayed missing forever after install,
# which is exactly the bug this section exists to close (#69). Persist the fix
# into the interactive shell's rc file (idempotently, in a marked block) so
# every *future* shell has it, and only fall back to the manual instruction
# when we don't recognize the shell or can't write its rc file.

PATH_BLOCK_START="# >>> bivy path >>>"
PATH_BLOCK_END="# <<< bivy path <<<"

# Resolve which rc file an interactive shell for $SHELL would source. Returns
# nothing (caller falls back to manual instructions) for shells we don't know.
rc_file_for_shell() {
  case "$(basename "${SHELL:-}")" in
    zsh) printf '%s' "$HOME/.zshrc" ;;
    bash) printf '%s' "$HOME/.bashrc" ;;
  esac
}

# Strip any previously-written block from $1, in place. Safe to call when no
# block (or no file) exists.
remove_path_block() {
  [ -f "$1" ] || return 0
  awk -v s="$PATH_BLOCK_START" -v e="$PATH_BLOCK_END" '
    $0 == s { inblock=1; next }
    inblock && $0 == e { inblock=0; next }
    inblock { next }
    { print }
  ' "$1" > "$1.bivy-tmp" && mv "$1.bivy-tmp" "$1"
}

# Append a block to $1 that puts BIN_DIR on PATH, guarded so re-sourcing it
# never adds a duplicate entry.
add_path_block() {
  {
    printf '\n%s\n' "$PATH_BLOCK_START"
    printf '# Added by the Bivy installer so the '\''bivy'\'' command is on PATH.\n'
    printf '# Safe to remove if you manage PATH yourself; regenerated on reinstall.\n'
    printf 'case ":$PATH:" in\n'
    printf '  *":%s:"*) ;;\n' "$BIN_DIR"
    printf '  *) export PATH="%s:$PATH" ;;\n' "$BIN_DIR"
    printf 'esac\n'
    printf '%s\n' "$PATH_BLOCK_END"
  } >> "$1"
}

warn_path_manually() {
  warn "Add $BIN_DIR to your PATH to use the 'bivy' command:"
  printf '     export PATH="%s:$PATH"\n' "$BIN_DIR"
}

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    RC_FILE="$(rc_file_for_shell)"
    if [ -n "$RC_FILE" ] && [ "${BIVY_NO_RC_UPDATE:-}" != "1" ] \
       && { mkdir -p "$(dirname "$RC_FILE")" && touch "$RC_FILE"; } 2>/dev/null && [ -w "$RC_FILE" ]; then
      remove_path_block "$RC_FILE"
      add_path_block "$RC_FILE"
      info "Added $BIN_DIR to PATH in $RC_FILE."
      echo "     Open a new terminal (or run: source $RC_FILE) to use the 'bivy' command."
    else
      warn_path_manually
    fi
    ;;
esac

# ------------------------------------------------------------------- finish

# An npm install keeps state at $DATA_DIR; a tarball install keeps it inside
# the app directory, which is also where its state was just carried across to.
if [ "$INSTALL_MODE" = "tarball" ]; then
  STATE_DIR="$LEGACY_APP_DIR/.bivy"
else
  STATE_DIR="$DATA_DIR"
fi

# Record the release channel (npm dist-tag) next to the node's state so
# `bivy update` keeps tracking it instead of snapping back to `latest`. A staging
# tester who installed with BIVY_CHANNEL=staging should stay on staging across
# updates. BIVY_VERSION pins an exact version rather than a channel, so skip the
# record then and leave any existing marker untouched. Best-effort — an
# unwritable state dir just means update falls back to the default channel.
if [ -z "${BIVY_VERSION:-}" ]; then
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s\n' "${BIVY_CHANNEL:-latest}" > "$STATE_DIR/channel" 2>/dev/null || true
fi

if [ "${BIVY_INSTALL_ALL_AGENTS:-}" = "1" ]; then
  info "Installing all bundled agent runtimes"
  "$BIVY_BIN" agents:install || warn "Could not install every bundled agent runtime. Bivy still works; run 'bivy agents:install' later to retry."
fi

first_agent_command() {
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const map = { "claude-code-sdk": "claude", "codex-approvals": "codex", opencode: "opencode", gemini: "gemini", qwen: "qwen", pi: "pi", aider: "aider", cline: "cline", crush: "crush" };
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const id = String(cfg.env?.BIVY_RUNTIME || cfg.defaults?.agent || "claude-code-sdk").toLowerCase();
      process.stdout.write(map[id] || id || "claude");
    } catch { process.stdout.write("claude"); }
  ' "$STATE_DIR/cli.json" 2>/dev/null || printf 'claude'
}

if [ -f "$STATE_DIR/cli.json" ]; then
  if [ -n "${BIVY_SESSION_TOKEN:-}${BIVY_NODE_CLAIM_CODE:-}" ]; then
    info "Existing Bivy configuration found; enrolling with the provided account token."
    # The hosted "Connect a Machine" command intentionally includes a fresh
    # account session/claim. Treat that as an explicit re-pair request even when
    # this machine already has local Bivy state; otherwise the installer would
    # only update/restart the old enrollment and the browser would keep waiting.
    "$BIVY_BIN" relay:setup || warn "Could not enroll with the provided account token. Existing configuration was left in place."
  else
    info "Existing Bivy configuration found; applying the update."
  fi
  # A Bivy node is remote-only — it has to keep running to stay reachable through
  # the relay — so an update/re-enroll RESTARTS the background service to pick up
  # the new build and reconnect. It never drops you at a local 'bivy start'.
  # `bivy restart` exits non-zero when there is no service to restart; in that
  # case install one so the node keeps running. (Don't gate on cli.json's
  # `service` flag: a box can have an active service while that flag is unset,
  # which is exactly how an update used to silently do nothing.)
  if "$BIVY_BIN" restart; then
    :
  else
    info "No background service yet — installing one so the node keeps running…"
    "$BIVY_BIN" service install || warn "Could not install the background service automatically. Finish with: bivy setup"
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

AGENT_CMD="$(first_agent_command)"
echo ""
info "First thing to try: cd your-repo && bivy run $AGENT_CMD   (then: bivy open)"
info "Installer finished in $(elapsed)"
