#!/usr/bin/env bash
#
# Covers the one genuinely dangerous thing install.sh still does: moving a
# previous install's state into the new location.
#
# Bivy used to install a self-contained tree at ~/.bivy/app with its state
# *inside* it (~/.bivy/app/.bivy). It now installs from npm, where the package
# directory is replaced on every update, so state lives at ~/.bivy. Existing
# users therefore get a one-time migration, and a migration that loses or
# clobbers state is the worst bug this script could have.
#
# npm is stubbed out: we're testing the migration and symlink logic, not npm.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$REPO_ROOT/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  ok  %s\n' "$1"
  else
    printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$3" "$2"
    FAILED=1
  fi
}

# A stub npm that satisfies `npm prefix -g` and `npm install -g`, creating the
# binary the installer expects to find afterwards.
mkdir -p "$WORK/stub"
cat > "$WORK/stub/npm" <<STUB
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "prefix" ]; then echo "$WORK/npm-prefix"; exit 0; fi
if [ "\${1:-}" = "install" ]; then
  mkdir -p "$WORK/npm-prefix/bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/npm-prefix/bin/bivy"
  chmod +x "$WORK/npm-prefix/bin/bivy"
  exit 0
fi
exit 0
STUB
chmod +x "$WORK/stub/npm"

run_installer() {
  # HOME is redirected so the installer's ~/.local symlink handling is contained.
  env -i \
    PATH="$WORK/stub:/usr/bin:/bin" \
    HOME="$WORK/home" \
    BIVY_DATA_DIR="$1" \
    BIVY_HOME="$2" \
    bash "$INSTALLER" >"$WORK/out.log" 2>&1
}

# ---------------------------------------------------------------- migration
LEGACY="$WORK/home/.bivy/app"
DATA="$WORK/home/.bivy"
mkdir -p "$LEGACY/.bivy/sessions" "$WORK/home/.local/bin"
echo '{"service":false,"port":4317}' > "$LEGACY/.bivy/cli.json"
echo 'node-identity' > "$LEGACY/.bivy/node.json"
echo 'relay-config' > "$LEGACY/.bivy/relay.json"
echo 'transcript' > "$LEGACY/.bivy/sessions/one.jsonl"
echo '{"version":"0.0.9"}' > "$LEGACY/.bivy/install.json"
ln -sf "$LEGACY/bin/bivy.mjs" "$WORK/home/.local/bin/bivy"

run_installer "$DATA" "$LEGACY" || true

check "cli.json migrated" "$(cat "$DATA/cli.json" 2>/dev/null)" '{"service":false,"port":4317}'
check "node identity migrated" "$(cat "$DATA/node.json" 2>/dev/null)" 'node-identity'
check "relay config migrated" "$(cat "$DATA/relay.json" 2>/dev/null)" 'relay-config'
check "session transcripts migrated" "$(cat "$DATA/sessions/one.jsonl" 2>/dev/null)" 'transcript'
check "stale install.json dropped" "$([ -e "$DATA/install.json" ] && echo present || echo gone)" 'gone'
check "legacy state left in place for rollback" "$([ -f "$LEGACY/.bivy/cli.json" ] && echo kept || echo removed)" 'kept'
check "stale symlink into old tree removed" "$([ -L "$WORK/home/.local/bin/bivy" ] && echo present || echo gone)" 'gone'

# ------------------------------------------------------- never clobber newer
# Re-running must not overwrite state that already exists at the destination.
echo '{"service":true,"port":9999}' > "$DATA/cli.json"
run_installer "$DATA" "$LEGACY" || true
check "second run leaves current state alone" "$(cat "$DATA/cli.json")" '{"service":true,"port":9999}'

# ------------------------------------------------- fresh install, no legacy
FRESH_HOME="$WORK/fresh"
mkdir -p "$FRESH_HOME"
env -i PATH="$WORK/stub:/usr/bin:/bin" HOME="$FRESH_HOME" \
  BIVY_DATA_DIR="$FRESH_HOME/.bivy" BIVY_HOME="$FRESH_HOME/.bivy/app" \
  bash "$INSTALLER" >"$WORK/fresh.log" 2>&1 || true
check "fresh install creates no phantom state" "$([ -f "$FRESH_HOME/.bivy/cli.json" ] && echo yes || echo no)" 'no'

if [ "$FAILED" != "0" ]; then
  echo "installer-migration: FAILED"
  echo "--- last installer output ---"
  tail -20 "$WORK/out.log" 2>/dev/null || true
  exit 1
fi
echo "installer-migration: passed"
