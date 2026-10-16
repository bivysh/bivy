#!/usr/bin/env bash
#
# Bivy — one-line installer.
#
#   curl -fsSL https://bivy.sh/install.sh | bash
#
# Installs the self-contained archive for this platform from GitHub Releases,
# then runs `bivy setup`, or restarts an existing background service. The
# archive brings its own Node runtime, so nothing else needs to be installed.
#
# The archive is checked against the release's SHA256SUMS before anything is
# replaced, and each one carries a GitHub build attestation:
#
#   gh attestation verify bivy-<version>-<platform>.tar.gz --repo bivysh/bivy
#
# Layout, shared with `bivy update` (bin/archive-install.mjs):
#
#   $INSTALL_DIR/versions/<version>-<target>/   one extracted archive each
#   $INSTALL_DIR/current -> versions/…          the active one
#   ~/.local/bin/bivy -> $INSTALL_DIR/current/bin/bivy
#
# Overrides:
#   BIVY_VERSION=0.22.0           install a specific release instead of the channel's newest
#   BIVY_CHANNEL=staging          follow the dev build of every merge to main; default `latest`
#   BIVY_INSTALL_DIR=…            where versions live (default ~/.local/share/bivy)
#   BIVY_RELEASES_URL=…           a mirror of github.com/bivysh/bivy/releases
#   BIVY_INSTALL_ALL_AGENTS=1     preinstall every known agent and its SDK bridge
#   BIVY_NO_RC_UPDATE=1           don't add the bin dir to ~/.bashrc or ~/.zshrc;
#                                 just print the manual `export PATH=...` line
#
set -euo pipefail

# Parse the whole installer before running anything. With curl | bash, a child
# that reads stdin must never consume the shell source and turn a partial
# install into a silent exit 0.
main() {

DATA_DIR="${BIVY_DATA_DIR:-$HOME/.bivy}"
STATE_DIR="$DATA_DIR"
INSTALL_DIR="${BIVY_INSTALL_DIR:-$HOME/.local/share/bivy}"
RELEASES_URL="${BIVY_RELEASES_URL:-https://github.com/bivysh/bivy/releases}"
BIN_DIR="$HOME/.local/bin"
BIVY_BIN="$BIN_DIR/bivy"

INSTALL_STARTED_SECONDS=$SECONDS

elapsed() { printf '%ss' "$((SECONDS - INSTALL_STARTED_SECONDS))"; }
info() { printf '\033[36m==>\033[0m [%s] %s\n' "$(elapsed)" "$1"; }
warn() { printf '\033[33m==>\033[0m [%s] %s\n' "$(elapsed)" "$1"; }
die()  { printf '\033[31mError:\033[0m [%s] %s\n' "$(elapsed)" "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required. Install it and re-run."
command -v tar >/dev/null 2>&1 || die "tar is required. Install it and re-run."

# ------------------------------------------------------------------ install

archive_target() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) return 1 ;; esac
  printf '%s-%s' "$os" "$arch"
}

# The release download directory for BIVY_VERSION, or for the channel.
archive_base() {
  if [ -n "${BIVY_VERSION:-}" ]; then printf '%s/download/v%s' "$RELEASES_URL" "${BIVY_VERSION#v}"
  elif [ "${BIVY_CHANNEL:-latest}" = "latest" ]; then printf '%s/latest/download' "$RELEASES_URL"
  else printf '%s/download/%s' "$RELEASES_URL" "$BIVY_CHANNEL"
  fi
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

extract_tarball() {
  # GNU tar warns about macOS-created archives carrying extended-attribute
  # headers; it can ignore them quietly, and other tars never warn at all.
  if tar --version 2>/dev/null | grep -qi 'gnu tar'; then
    tar --warning=no-unknown-keyword --no-same-owner -xzf "$1" -C "$2"
  else
    tar -xzf "$1" -C "$2"
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TARGET="$(archive_target)" || die "Bivy has no build for $(uname -s) $(uname -m) yet."
BASE="$(archive_base)"
SUMS="$(curl -fsSL "$BASE/SHA256SUMS")" || die "Could not read $BASE/SHA256SUMS. Check the version or channel and your connection."
LINE="$(printf '%s\n' "$SUMS" | grep -E "^[0-9a-f]{64}  bivy-[^ ]+-${TARGET}\.tar\.gz$" | head -n1 || true)"
[ -n "$LINE" ] || die "That release has no build for $TARGET."
WANT="${LINE%% *}"
FILE="${LINE##* }"
NAME="${FILE%.tar.gz}"
VERSION="${NAME#bivy-}"
VERSION="${VERSION%-"$TARGET"}"

info "Downloading Bivy $VERSION for $TARGET"
curl -fSL --progress-bar -o "$TMP_DIR/$FILE" "$BASE/$FILE" || die "Could not download $BASE/$FILE."
GOT="$(file_sha256 "$TMP_DIR/$FILE")"
[ "$GOT" = "$WANT" ] || die "$FILE failed verification (sha256 $GOT, SHA256SUMS says $WANT). Nothing was changed; re-run to retry."

mkdir -p "$INSTALL_DIR/versions"
STAGE="$(mktemp -d "$INSTALL_DIR/versions/.stage-XXXXXX")"
trap 'rm -rf "$TMP_DIR" "$STAGE"' EXIT
extract_tarball "$TMP_DIR/$FILE" "$STAGE" || die "Could not extract $FILE. Nothing was changed."
[ -f "$STAGE/$NAME/bivy-archive.json" ] || die "$FILE is not a Bivy release archive. Nothing was changed."
"$STAGE/$NAME/bin/bivy" --version </dev/null >/dev/null 2>&1 || die "Bivy $VERSION does not run on this machine ($TARGET). Nothing was changed."

# Quiesce a running node before swapping; the restart below brings it back.
if command -v bivy >/dev/null 2>&1; then
  info "Stopping the running Bivy node"
  bivy stop </dev/null >/dev/null 2>&1 || true
fi

DEST="$INSTALL_DIR/versions/$VERSION-$TARGET"
PREVIOUS="$(readlink "$INSTALL_DIR/current" 2>/dev/null || true)"
if [ -e "$DEST" ]; then mv "$DEST" "$DEST.old-$$"; fi
mv "$STAGE/$NAME" "$DEST"
rm -rf "$DEST.old-$$"
ln -sfn "versions/$VERSION-$TARGET" "$INSTALL_DIR/current"
# Keep the version before this one for rollback; drop anything older.
for dir in "$INSTALL_DIR"/versions/* "$INSTALL_DIR"/versions/.stage-*; do
  [ -e "$dir" ] || continue
  case "$dir" in "$DEST" | "$INSTALL_DIR/$PREVIOUS") ;; *) rm -rf "$dir" ;; esac
done

mkdir -p "$BIN_DIR"
ln -sfn "$INSTALL_DIR/current/bin/bivy" "$BIVY_BIN"
NODE_CMD="$INSTALL_DIR/current/runtime/bin/node"
info "Installed Bivy $VERSION into $INSTALL_DIR"

# An older bivy (say, from npm) earlier on PATH would still be what runs.
SHADOW="$(PATH="$(printf '%s' "$PATH" | tr ':' '\n' | awk -v b="$BIN_DIR" '$0 == b {exit} {print}' | paste -sd: -)" command -v bivy 2>/dev/null || true)"
if [ -n "$SHADOW" ]; then
  warn "$SHADOW comes before $BIN_DIR on PATH, so 'bivy' still runs that copy."
  warn "Remove it (for an npm install: npm rm -g @bivy/bivy), or put $BIN_DIR first."
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

# Record the release channel (latest | staging) next to the node's state so
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
  "$NODE_CMD" -e '
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

# The Connect a Machine command's account token. Its old name, BIVY_SESSION_TOKEN,
# is also every agent session's own route token, so it only counts outside an
# agent session (BIVY_SESSION_ID unset); `bivy setup` applies the same rule.
if [ -z "${BIVY_ACCOUNT_TOKEN:-}" ] && [ -z "${BIVY_SESSION_ID:-}" ] && [ -n "${BIVY_SESSION_TOKEN:-}" ]; then
  export BIVY_ACCOUNT_TOKEN="$BIVY_SESSION_TOKEN"
fi

if [ -f "$STATE_DIR/cli.json" ]; then
  if [ -n "${BIVY_ACCOUNT_TOKEN:-}${BIVY_NODE_CLAIM_CODE:-}" ]; then
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
  if ( : </dev/tty ) 2>/dev/null; then
    "$BIVY_BIN" setup </dev/tty || die "Setup did not complete. Re-run: bivy setup"
  else
    warn "No interactive terminal detected. Finish setup by running:"
    echo "  bivy setup"
  fi
fi

AGENT_CMD="$(first_agent_command)"
echo ""
info "First thing to try: cd your-repo && bivy run $AGENT_CMD   (then: bivy open)"
info "Installer finished in $(elapsed)"
}

main "$@"
