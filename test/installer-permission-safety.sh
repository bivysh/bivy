#!/usr/bin/env bash
# Verifies that `bivy update` (install.sh) refuses to update an existing install
# it cannot fully manage, and — crucially — leaves the working install untouched
# instead of moving it aside and aborting partway through.
#
# The real-world trigger is a node first installed with sudo/as root: ~/.bivy/app
# and its protected state end up owned by another user, so a later non-root
# update cannot move state out or delete the old copy. Here we reproduce the
# "not writable by the current user" condition with a read-only install dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() { chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$(id -u)" -eq 0 ]; then
  echo "installer-permission-safety: skipped (root bypasses filesystem permission checks)"
  exit 0
fi

HOME_DIR="$TMP/home"
INSTALL_HOME="$HOME_DIR/.bivy/app"
ARTIFACT_DIR="$TMP/artifact"
ARTIFACT="$TMP/bivy-latest.tar.gz"
mkdir -p "$INSTALL_HOME/.bivy" "$INSTALL_HOME/bin" "$ARTIFACT_DIR/bivy/bin"

cat > "$INSTALL_HOME/.bivy/cli.json" <<'JSON'
{ "workspace": "/home/mesh/workspace", "port": 4317, "service": false }
JSON
echo '{"nodeId":"node_do_not_lose_me"}' > "$INSTALL_HOME/.bivy/node.json"

cat > "$ARTIFACT_DIR/bivy/package.json" <<'JSON'
{ "name": "bivy-installer-test-artifact", "version": "0.0.0", "type": "module", "dependencies": {} }
JSON
printf '#!/usr/bin/env node\nprocess.exit(0)\n' > "$ARTIFACT_DIR/bivy/bin/bivy.mjs"
chmod +x "$ARTIFACT_DIR/bivy/bin/bivy.mjs"
tar -czf "$ARTIFACT" -C "$ARTIFACT_DIR" bivy
MANIFEST="$TMP/bivy-latest.json"
node -e 'const fs=require("fs"), crypto=require("crypto"); const p=process.argv[1]; const sha256=crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); fs.writeFileSync(process.argv[2], JSON.stringify({ sha256 }) + "\n");' "$ARTIFACT" "$MANIFEST"

# Make the existing install read-only for its owner, mimicking a dir owned by
# another user. The installer must detect it cannot manage this and bail early.
chmod 0500 "$INSTALL_HOME"

set +e
OUT="$(HOME="$HOME_DIR" \
  BIVY_HOME="$INSTALL_HOME" \
  BIVY_TARBALL_URL="file://$ARTIFACT" \
  BIVY_MANIFEST_URL="file://$MANIFEST" \
  BIVY_ALLOW_UNSIGNED_MANIFEST=1 \
  bash "$ROOT/install.sh" 2>&1)"
CODE=$?
set -e
chmod 0755 "$INSTALL_HOME"

if [ "$CODE" -eq 0 ]; then
  echo "Installer should have refused to update a non-writable install, but it succeeded" >&2
  echo "$OUT" >&2
  exit 1
fi

if ! printf '%s' "$OUT" | grep -qi "not writable"; then
  echo "Installer failed for the wrong reason (expected a 'not writable' refusal):" >&2
  echo "$OUT" >&2
  exit 1
fi

# The working install must be left exactly as it was — no half-move.
if [ ! -f "$INSTALL_HOME/.bivy/cli.json" ] || ! grep -q node_do_not_lose_me "$INSTALL_HOME/.bivy/node.json"; then
  echo "Installer damaged the existing install after refusing to update" >&2
  exit 1
fi
if find "$HOME_DIR/.bivy" -maxdepth 1 \( -name '.bivy-install.*' -o -name '.bivy-backup.*' \) | grep -q .; then
  echo "Installer left staging/backup directories behind after refusing to update" >&2
  find "$HOME_DIR/.bivy" -maxdepth 1 -print >&2
  exit 1
fi

echo "installer-permission-safety: passed"
