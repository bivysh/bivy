#!/usr/bin/env bash
# Run ONLY inside a disposable Debian/Ubuntu guest. CI supplies the exact built
# npm tarball and this checkout's installer; no published release is changed.
set -euo pipefail
[ "${BIVY_INSTALL_SMOKE:-}" = 1 ] || { echo 'Requires a disposable guest and BIVY_INSTALL_SMOKE=1' >&2; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT="${1:?Usage: smoke-installer.sh /absolute/path/to/bivy-npm.tgz}"
[ -f "$ARTIFACT" ]
for cmd in node npm bivy; do
  if command -v "$cmd"; then echo "Guest is not fresh: $cmd already exists" >&2; exit 1; fi
done
# Only bootstrap the prerequisites for curl itself. In particular, no Node,
# timezone, or native build packages are preinstalled by the test harness.
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates
export BIVY_VERSION="file:$ARTIFACT" SHELL=/bin/bash
# Use curl's file transport for the candidate installer, preserving the public
# command's pipe semantics without deploying unreviewed code to bivy.sh.
curl -fsSL "file:$DIR/../install.sh" | bash
bivy --version
bivy --help >/dev/null
node "$DIR/smoke-pty.mjs" "$(npm root -g)/@bivy/bivy"
# No account/model credentials or systemd needed to verify the local data plane.
export PORT=18437 BIVY_HOST=127.0.0.1 BIVY_DATA_DIR=/tmp/bivy-installer-smoke-state
# Model the local-only config normally saved by setup. Persist the port for CLI
# clients too, so a PRoot run cannot accidentally contact a host's default node.
mkdir -p "$BIVY_DATA_DIR" /tmp/bivy-smoke-workspace
node -e 'require("fs").writeFileSync(process.env.BIVY_DATA_DIR + "/cli.json", JSON.stringify({port: Number(process.env.PORT), workspace: "/tmp/bivy-smoke-workspace", env: {}}), {mode: 0o600})'
# Kill the CLI AND its server child, including in PRoot (which waits for every
# traced descendant). Killing only the CLI leaves the data plane orphaned.
setsid bivy start > /tmp/bivy-smoke-daemon.log 2>&1 &
daemon=$!
trap 'kill -- -"$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true' EXIT
ready=0
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" > /tmp/bivy-smoke-health.json 2>/dev/null; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then cat /tmp/bivy-smoke-daemon.log; exit 1; fi
node -e 'if(!require("/tmp/bivy-smoke-health.json").ok) process.exit(1)'
timeout 30 bivy run -- /bin/sh -c 'printf bivy-run-ok' | tee /tmp/bivy-smoke-run.log
grep -q 'bivy-run-ok' /tmp/bivy-smoke-run.log
echo 'Clean curl installer, CLI, terminal, native run, and daemon smoke: passed'
