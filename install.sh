#!/usr/bin/env bash
#
# Bivy — one-line installer for the packaged app.
#
#   curl -fsSL https://bivy.sh/install.sh | bash
#
# The source repo can stay private: this script downloads the prebuilt release
# artifact, installs production dependencies, and launches `bivy setup`.
#
# Overrides:
#   BIVY_TARBALL_URL=https://example.com/bivy.tar.gz BIVY_HOME=~/.bivy/app bash install.sh
#
set -euo pipefail

TARBALL_URL="${BIVY_TARBALL_URL:-https://bivy.sh/downloads/bivy-latest.tar.gz}"
MANIFEST_URL="${BIVY_MANIFEST_URL:-https://bivy.sh/downloads/bivy-latest.json}"
BIVY_HOME="${BIVY_HOME:-$HOME/.bivy/app}"
TMP_DIR="$(mktemp -d)"
STAGE_DIR=""
BACKUP_DIR=""
PRESERVED_STATE_MOVED=0
STATE_FILES_TO_CHECK=""
# Production releases should embed Bivy's Ed25519 release-verification public
# key here. Until that key is provisioned, unsigned local/test installs must opt
# in explicitly with BIVY_ALLOW_UNSIGNED_MANIFEST=1 (or the broader
# BIVY_ALLOW_UNVERIFIED_INSTALL=1 escape hatch).
EMBEDDED_RELEASE_VERIFY_KEY_PEM="${BIVY_EMBEDDED_RELEASE_VERIFY_KEY_PEM:-}"

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$1" >&2; exit 1; }
cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
}
trap cleanup EXIT

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then "$@";
  elif command -v sudo >/dev/null 2>&1; then sudo "$@";
  else return 1;
  fi
}

install_ubuntu_prereqs() {
  command -v apt-get >/dev/null 2>&1 || return 0
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  info "Installing Ubuntu build prerequisites"
  run_sudo apt-get update
  run_sudo apt-get install -y curl ca-certificates tar build-essential python3
}

install_ubuntu_node22() {
  command -v apt-get >/dev/null 2>&1 || return 1
  info "Installing Node.js 22"
  run_sudo apt-get update
  run_sudo apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | run_sudo bash -
  run_sudo apt-get install -y nodejs
}

install_ubuntu_prereqs || true
command -v curl >/dev/null 2>&1 || die "curl is required. Install it and re-run."
command -v tar >/dev/null 2>&1 || die "tar is required. Install it and re-run."

if ! command -v node >/dev/null 2>&1; then
  install_ubuntu_node22 || die "Node.js 22.19+ is required but not found. Install it from https://nodejs.org and re-run."
fi
NODE_OK="$(node -p 'const [M,m]=process.versions.node.split(".").map(Number); +(M>22 || (M===22 && m>=19))')"
if [ "$NODE_OK" != "1" ]; then
  install_ubuntu_node22 || die "Node.js 22.19+ is required (found $(node -v)). Please upgrade and re-run."
fi
NODE_OK="$(node -p 'const [M,m]=process.versions.node.split(".").map(Number); +(M>22 || (M===22 && m>=19))')"
if [ "$NODE_OK" != "1" ]; then
  die "Node.js 22.19+ is required (found $(node -v)). Please upgrade and re-run."
fi
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

if command -v apt-get >/dev/null 2>&1 && { ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; }; then
  die "Build tools are missing. Install them with: sudo apt-get update && sudo apt-get install -y build-essential python3"
fi

# macOS: Bivy's native module (node-pty) may need to compile, which requires the
# Xcode Command Line Tools. Warn early with the exact fix so a build failure in
# `npm ci` below isn't a cryptic node-gyp error. (Left as a warning, not a hard
# stop, because a matching prebuilt binary may avoid compilation entirely.)
if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools not detected. If the dependency install below fails building node-pty, run 'xcode-select --install' and re-run this installer."
fi

extract_tarball() {
  # Older artifacts built on macOS may contain Apple extended-attribute pax
  # headers. GNU tar can ignore them quietly; other tar implementations already
  # ignore them without the noisy warning.
  if tar --version 2>/dev/null | grep -qi 'gnu tar'; then
    tar --warning=no-unknown-keyword --no-same-owner -xzf "$1" -C "$2"
  else
    tar -xzf "$1" -C "$2"
  fi
}

info "Downloading Bivy from $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/bivy.tar.gz"
if ! curl -fsSL "$MANIFEST_URL" -o "$TMP_DIR/bivy-latest.json"; then
  if [ "${BIVY_ALLOW_UNVERIFIED_INSTALL:-}" = "1" ]; then
    warn "Could not download release manifest; continuing because BIVY_ALLOW_UNVERIFIED_INSTALL=1."
  else
    die "Could not download release manifest for verification. Re-run, or set BIVY_ALLOW_UNVERIFIED_INSTALL=1 only if you trust $TARBALL_URL."
  fi
fi
if [ -s "$TMP_DIR/bivy-latest.json" ]; then
  MANIFEST_SHA="$(node -e 'const fs=require("fs"); try { const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(typeof m.sha256 === "string" ? m.sha256 : ""); } catch {}' "$TMP_DIR/bivy-latest.json")"
  if [ -z "$MANIFEST_SHA" ]; then
    if [ "${BIVY_ALLOW_UNVERIFIED_INSTALL:-}" = "1" ]; then
      warn "Release manifest has no sha256; continuing because BIVY_ALLOW_UNVERIFIED_INSTALL=1."
    else
      die "Release manifest is missing sha256; refusing to install an unverified archive."
    fi
  else
    ACTUAL_SHA="$(node -e 'const fs=require("fs"), crypto=require("crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "$TMP_DIR/bivy.tar.gz")"
    [ "$ACTUAL_SHA" = "$MANIFEST_SHA" ] || die "Downloaded archive checksum mismatch. Please re-run the installer."
  fi
  VERIFY_KEY="${BIVY_RELEASE_VERIFY_KEY_PEM:-$EMBEDDED_RELEASE_VERIFY_KEY_PEM}"
  if [ -z "$VERIFY_KEY" ] && [ "${BIVY_ALLOW_UNSIGNED_MANIFEST:-}" != "1" ] && [ "${BIVY_ALLOW_UNVERIFIED_INSTALL:-}" != "1" ]; then
    die "Release signature verification key is not configured. This installer is not ready for production until Bivy embeds its release public key."
  fi
  if [ -n "$VERIFY_KEY" ]; then
    BIVY_RELEASE_VERIFY_KEY_PEM="$VERIFY_KEY" node -e 'const fs=require("fs"), crypto=require("crypto"); const p=process.argv[1]; const key=process.env.BIVY_RELEASE_VERIFY_KEY_PEM; const m=JSON.parse(fs.readFileSync(p,"utf8")); const sig=m.signature && m.signature.value; if(!sig) process.exit(42); const body={...m}; delete body.signature; const ok=crypto.verify(null, Buffer.from(JSON.stringify(body)), key, Buffer.from(sig,"base64")); process.exit(ok?0:43);' "$TMP_DIR/bivy-latest.json" || die "Release manifest signature verification failed."
  elif [ "${BIVY_ALLOW_UNSIGNED_MANIFEST:-}" = "1" ]; then
    warn "Skipping manifest signature verification because BIVY_ALLOW_UNSIGNED_MANIFEST=1."
  fi
else
  [ "${BIVY_ALLOW_UNVERIFIED_INSTALL:-}" = "1" ] || die "Release manifest is empty; refusing to install an unverified archive."
fi
INSTALL_PARENT="$(dirname "$BIVY_HOME")"
mkdir -p "$INSTALL_PARENT"
STAGE_DIR="$(mktemp -d "$INSTALL_PARENT/.bivy-install.XXXXXX")"
extract_tarball "$TMP_DIR/bivy.tar.gz" "$STAGE_DIR"
STAGED_APP="$STAGE_DIR/bivy"
[ -d "$STAGED_APP" ] || die "Downloaded archive did not contain a bivy/ directory."

HAD_CONFIG=0
if [ -f "$BIVY_HOME/.bivy/cli.json" ]; then
  HAD_CONFIG=1
fi

# If a previous install exists but the current user cannot write to it, updating
# would fail partway through — after moving the old install aside but before the
# new one is in place — leaving the node with no app directory. This happens when
# Bivy was first installed with sudo (or as a different user), so ~/.bivy/app and
# its protected state files are owned by root. Detect it up front and stop while
# the working install is still untouched, with a clear way forward.
if [ -e "$BIVY_HOME" ] && [ "$(id -u)" -ne 0 ] && [ ! -w "$BIVY_HOME" ]; then
  die "Cannot update: $BIVY_HOME is not writable by $(id -un) — it was likely installed with sudo or as another user. Re-run as the owner (e.g. 'sudo bivy update') or reclaim it with 'sudo chown -R $(id -un) $BIVY_HOME' and try again. Your current install was left untouched."
fi

cd "$STAGED_APP"
chmod +x bin/bivy.mjs
if [ -f "$TMP_DIR/bivy-latest.json" ]; then
  mkdir -p .bivy
  cp "$TMP_DIR/bivy-latest.json" .bivy/install.json
  chmod 600 .bivy/install.json 2>/dev/null || true
fi

info "Installing production dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

restore_previous_install() {
  if [ "$PRESERVED_STATE_MOVED" = "1" ] && [ -n "$BACKUP_DIR" ] && [ -d "$STAGED_APP/.bivy" ] && [ ! -e "$BACKUP_DIR/.bivy" ]; then
    mv "$STAGED_APP/.bivy" "$BACKUP_DIR/.bivy" 2>/dev/null || true
  fi
  if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ]; then
    # Clear the destination for the restore. Removing it may fail if it holds
    # files the current user cannot delete (e.g. root-owned state), so move it
    # aside first — a rename only needs write on the parent — and the previous
    # install always comes back cleanly.
    if [ -e "$BIVY_HOME" ]; then
      mv "$BIVY_HOME" "$BIVY_HOME.failed.$$" 2>/dev/null || rm -rf "$BIVY_HOME" 2>/dev/null || true
    fi
    mv "$BACKUP_DIR" "$BIVY_HOME"
    rm -rf "$BIVY_HOME.failed.$$" 2>/dev/null || true
  fi
}

info "Installing Bivy into $BIVY_HOME"
BACKUP_DIR="$INSTALL_PARENT/.bivy-backup.$(date +%s).$$"
if [ -e "$BIVY_HOME" ]; then
  if ! mv "$BIVY_HOME" "$BACKUP_DIR"; then
    rm -rf "$BACKUP_DIR" 2>/dev/null || true
    BACKUP_DIR=""
    die "Could not move the existing install at $BIVY_HOME aside (it may be a mount point or on a separate filesystem). Your current install was left untouched."
  fi
fi
if [ -d "$BACKUP_DIR/.bivy" ]; then
  info "Moving existing local state into the new release"
  for f in cli.json node.json relay.json; do
    if [ -e "$BACKUP_DIR/.bivy/$f" ]; then STATE_FILES_TO_CHECK="$STATE_FILES_TO_CHECK $f"; fi
  done
  if [ -f "$STAGED_APP/.bivy/install.json" ]; then cp "$STAGED_APP/.bivy/install.json" "$TMP_DIR/install.json"; fi
  rm -rf "$STAGED_APP/.bivy"
  if ! mv "$BACKUP_DIR/.bivy" "$STAGED_APP/.bivy"; then
    restore_previous_install
    die "Could not carry your existing state (.bivy) into the new release; the previous install was restored. If Bivy was installed with sudo, re-run with 'sudo bivy update'."
  fi
  PRESERVED_STATE_MOVED=1
  if [ -f "$TMP_DIR/install.json" ]; then
    cp "$TMP_DIR/install.json" "$STAGED_APP/.bivy/install.json"
    chmod 600 "$STAGED_APP/.bivy/install.json" 2>/dev/null || true
  fi
fi
if ! mv "$STAGED_APP" "$BIVY_HOME"; then
  restore_previous_install
  die "Could not move the new Bivy release into place; the previous install was restored."
fi
for f in $STATE_FILES_TO_CHECK; do
  if [ ! -e "$BIVY_HOME/.bivy/$f" ]; then
    restore_previous_install
    die "Installed release is missing preserved state file .bivy/$f; the previous install was restored."
  fi
done
rmdir "$STAGE_DIR" 2>/dev/null || true
STAGE_DIR=""
if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR" 2>/dev/null || true; fi
find "$INSTALL_PARENT" -maxdepth 1 \( -name '.bivy-install.*' -o -name '.bivy-backup.*' \) -type d -exec rm -rf {} + 2>/dev/null || true
if [ -d "$INSTALL_PARENT/state-backups" ]; then
  find "$INSTALL_PARENT/state-backups" -maxdepth 1 -name 'state-*.bivy' -type d -exec rm -rf {} + 2>/dev/null || true
  rmdir "$INSTALL_PARENT/state-backups" 2>/dev/null || true
fi
cd "$BIVY_HOME"

if [ "${BIVY_INSTALL_ALL_AGENTS:-}" = "1" ]; then
  info "Installing all bundled agent runtimes"
  node bin/bivy.mjs agents:install || warn "Could not install every bundled agent runtime. Bivy still works; run 'bivy agents:install' later to retry."
else
  info "Skipping full agent preinstall (setup installs your chosen default agent; set BIVY_INSTALL_ALL_AGENTS=1 to install every bundled runtime)."
fi

LINK_DIR="$HOME/.local/bin"
if mkdir -p "$LINK_DIR" 2>/dev/null; then
  ln -sf "$BIVY_HOME/bin/bivy.mjs" "$LINK_DIR/bivy"
  case ":$PATH:" in
    *":$LINK_DIR:"*) : ;;
    *) warn "Add $LINK_DIR to your PATH to use the 'bivy' command directly." ;;
  esac
fi

if [ "$HAD_CONFIG" = "1" ]; then
  info "Existing Bivy configuration found; skipping first-run setup."
  if node -e 'const fs=require("fs"); const p=".bivy/cli.json"; process.exit(JSON.parse(fs.readFileSync(p,"utf8")).service===true ? 0 : 1)' 2>/dev/null; then
    info "Restarting existing background service…"
    node bin/bivy.mjs restart || warn "Could not restart the service automatically. Run: bivy restart"
  else
    info "Update complete. Start Bivy with: bivy start"
  fi
else
  info "Launching setup…"
  if [ -r /dev/tty ] && node bin/bivy.mjs setup </dev/tty; then
    :
  else
    warn "No interactive terminal detected. Finish setup manually:"
    echo "  cd $BIVY_HOME && node bin/bivy.mjs setup"
  fi
fi
