#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

HOME_DIR="$TMP/home"
INSTALL_HOME="$HOME_DIR/.bivy/app"
ARTIFACT_DIR="$TMP/artifact"
ARTIFACT="$TMP/bivy-latest.tar.gz"
mkdir -p "$ARTIFACT_DIR/bivy/bin"

cat > "$ARTIFACT_DIR/bivy/package.json" <<'JSON'
{ "name": "bivy-installer-verification-test", "version": "0.0.0", "type": "module", "dependencies": {} }
JSON
printf '#!/usr/bin/env node\nprocess.exit(0)\n' > "$ARTIFACT_DIR/bivy/bin/bivy.mjs"
chmod +x "$ARTIFACT_DIR/bivy/bin/bivy.mjs"
tar -czf "$ARTIFACT" -C "$ARTIFACT_DIR" bivy

run_install() {
  set +e
  OUT="$(HOME="$HOME_DIR" BIVY_HOME="$INSTALL_HOME" BIVY_TARBALL_URL="file://$ARTIFACT" BIVY_MANIFEST_URL="$1" bash "$ROOT/install.sh" 2>&1)"
  CODE=$?
  set -e
}

# Missing manifest must fail unless the caller explicitly opts out.
run_install "file://$TMP/missing.json"
if [ "$CODE" -eq 0 ] || ! printf '%s' "$OUT" | grep -qi "manifest"; then
  echo "missing manifest did not fail closed" >&2
  echo "$OUT" >&2
  exit 1
fi

BAD_MANIFEST="$TMP/bad.json"
printf '{"sha256":"deadbeef"}\n' > "$BAD_MANIFEST"
run_install "file://$BAD_MANIFEST"
if [ "$CODE" -eq 0 ] || ! printf '%s' "$OUT" | grep -qi "checksum mismatch"; then
  echo "bad checksum did not fail closed" >&2
  echo "$OUT" >&2
  exit 1
fi

UNSIGNED_MANIFEST="$TMP/unsigned.json"
node -e 'const fs=require("fs"), crypto=require("crypto"); const p=process.argv[1]; const sha256=crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); fs.writeFileSync(process.argv[2], JSON.stringify({ sha256 }) + "\n");' "$ARTIFACT" "$UNSIGNED_MANIFEST"
run_install "file://$UNSIGNED_MANIFEST"
if [ "$CODE" -eq 0 ] || ! printf '%s' "$OUT" | grep -qi "signature verification key"; then
  echo "unsigned manifest without a release key did not fail closed" >&2
  echo "$OUT" >&2
  exit 1
fi

# Internal/test artifacts can opt out of signature verification but still keep
# checksum verification. This is what the other installer tests use.
HOME="$HOME_DIR" \
BIVY_HOME="$INSTALL_HOME" \
BIVY_TARBALL_URL="file://$ARTIFACT" \
BIVY_MANIFEST_URL="file://$UNSIGNED_MANIFEST" \
BIVY_ALLOW_UNSIGNED_MANIFEST=1 \
bash "$ROOT/install.sh" >/dev/null

if [ ! -x "$INSTALL_HOME/bin/bivy.mjs" ]; then
  echo "unsigned opt-out install did not complete" >&2
  exit 1
fi

echo "installer-verification: passed"
