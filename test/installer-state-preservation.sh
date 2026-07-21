#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

INSTALL_HOME="$TMP/home/.bivy/app"
ARTIFACT_DIR="$TMP/artifact"
ARTIFACT="$TMP/bivy-latest.tar.gz"
mkdir -p "$INSTALL_HOME/.bivy" "$ARTIFACT_DIR/bivy/bin" "$TMP/home/.bivy/state-backups/state-old.bivy" "$TMP/home/.bivy/.bivy-install.old" "$TMP/home/.bivy/.bivy-backup.old"

cat > "$INSTALL_HOME/.bivy/cli.json" <<'JSON'
{
  "workspace": "/home/mesh/workspace",
  "port": 4317,
  "service": false,
  "env": { "BIVY_GITHUB_TOKEN": "preserve-me" }
}
JSON
cat > "$INSTALL_HOME/.bivy/node.json" <<'JSON'
{
  "nodeId": "node_preserve_me",
  "name": "preserved node",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "devices": [{ "id": "dev_1", "name": "phone", "tokenHash": "hash", "createdAt": "2026-01-01T00:00:00.000Z", "lastSeenAt": null }]
}
JSON
cat > "$INSTALL_HOME/.bivy/relay.json" <<'JSON'
{
  "url": "wss://relay.example.test",
  "controlPlaneUrl": "https://app.example.test",
  "clientBaseUrl": "https://app.example.test",
  "enrollmentToken": "enr_preserve_me",
  "e2eKey": "room-key-preserve-me"
}
JSON
cat > "$INSTALL_HOME/.bivy/pi-state.json" <<'JSON'
{ "session": "preserve arbitrary extra state too" }
JSON

cat > "$ARTIFACT_DIR/bivy/package.json" <<'JSON'
{
  "name": "bivy-installer-test-artifact",
  "version": "0.0.0",
  "type": "module",
  "dependencies": {}
}
JSON
cat > "$ARTIFACT_DIR/bivy/bin/bivy.mjs" <<'EOF2'
#!/usr/bin/env node
if (process.argv[2] === "restart") process.exit(0);
if (process.argv[2] === "setup") process.exit(0);
console.log("fake bivy");
EOF2
chmod +x "$ARTIFACT_DIR/bivy/bin/bivy.mjs"

tar -czf "$ARTIFACT" -C "$ARTIFACT_DIR" bivy
MANIFEST="$TMP/bivy-latest.json"
node -e 'const fs=require("fs"), crypto=require("crypto"); const p=process.argv[1]; const sha256=crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); fs.writeFileSync(process.argv[2], JSON.stringify({ sha256 }) + "\n");' "$ARTIFACT" "$MANIFEST"

ORIG_STATE="$TMP/original-state"
cp -a "$INSTALL_HOME/.bivy" "$ORIG_STATE"

HOME="$TMP/home" \
BIVY_HOME="$INSTALL_HOME" \
BIVY_TARBALL_URL="file://$ARTIFACT" \
BIVY_MANIFEST_URL="file://$MANIFEST" \
BIVY_ALLOW_UNSIGNED_MANIFEST=1 \
bash "$ROOT/install.sh" >/tmp/bivy-installer-test.log

for f in cli.json node.json relay.json pi-state.json; do
  if ! cmp -s "$ORIG_STATE/$f" "$INSTALL_HOME/.bivy/$f"; then
    echo "State file was not preserved exactly: $f" >&2
    echo "Installer output:" >&2
    cat /tmp/bivy-installer-test.log >&2
    exit 1
  fi
done

if find "$TMP/home/.bivy" -maxdepth 1 \( -name 'state-backups' -o -name '.bivy-install.*' -o -name '.bivy-backup.*' \) | grep -q .; then
  echo "Installer left duplicate install/state directories behind" >&2
  find "$TMP/home/.bivy" -maxdepth 1 -print >&2
  exit 1
fi

if [ ! -x "$INSTALL_HOME/bin/bivy.mjs" ]; then
  echo "New app executable was not installed" >&2
  exit 1
fi

if [ ! -L "$TMP/home/.local/bin/bivy" ]; then
  echo "bivy symlink was not recreated" >&2
  exit 1
fi

echo "installer-state-preservation: passed"
