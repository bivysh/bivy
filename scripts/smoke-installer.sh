#!/usr/bin/env bash
# Run ONLY inside a disposable Debian/Ubuntu guest. CI supplies this run's
# release archives and this checkout's installer; no published release is changed.
set -euo pipefail
[ "${BIVY_INSTALL_SMOKE:-}" = 1 ] || { echo 'Requires a disposable guest and BIVY_INSTALL_SMOKE=1' >&2; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVES="${1:?Usage: smoke-installer.sh /absolute/path/to/release-archives}"
[ -f "$ARCHIVES/SHA256SUMS" ]
for cmd in node npm bivy; do
  if command -v "$cmd"; then echo "Guest is not fresh: $cmd already exists" >&2; exit 1; fi
done
# Optional CI download cache: retain .deb archives, but never an installed
# package database. Node/build tools must still be absent and installed by the
# candidate installer. Ubuntu's Docker cleanup hook otherwise deletes archives.
if [ "${BIVY_INSTALL_SMOKE_CACHE:-}" = 1 ]; then
  rm -f /etc/apt/apt.conf.d/docker-clean
  printf 'Binary::apt::APT::Keep-Downloaded-Packages "true";\n' > /etc/apt/apt.conf.d/keep-downloads
fi
# Only bootstrap the prerequisites for curl itself. The archive must bring
# everything else: no Node or native build packages exist on the guest.
if ! command -v curl >/dev/null || [ ! -f /etc/ssl/certs/ca-certificates.crt ]; then
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates
fi
# Serve this run's archives as the `staging` channel through curl's file transport.
releases=/tmp/bivy-releases
mkdir -p "$releases/download/staging"
cp "$ARCHIVES"/* "$releases/download/staging/"
export BIVY_RELEASES_URL="file://$releases" BIVY_CHANNEL=staging SHELL=/bin/bash
# Use curl's file transport for the candidate installer, preserving the public
# command's pipe semantics without deploying unreviewed code to bivy.sh.
curl -fsSL "file:$DIR/../install.sh" | bash
# The installer cannot change this parent shell's PATH. Read the PATH from a
# fresh interactive Bash, as instructed by the installer.
PATH="$(bash -ic 'printf "%s" "$PATH"')"
export PATH
bivy --version
bivy --help >/dev/null
if command -v node; then echo "The installer left a system Node behind" >&2; exit 1; fi
app="$HOME/.local/share/bivy/current"
"$app/runtime/bin/node" "$DIR/smoke-pty.mjs" "$app/app"
# No account/model credentials or systemd needed to verify the local data plane.
export PORT=18437 BIVY_HOST=127.0.0.1 BIVY_DATA_DIR=/tmp/bivy-installer-smoke-state
# Model the local-only config normally saved by setup. Persist the port for CLI
# clients too, so a PRoot run cannot accidentally contact a host's default node.
mkdir -p "$BIVY_DATA_DIR" /tmp/bivy-smoke-workspace
( umask 077; printf '{"port":%s,"workspace":"/tmp/bivy-smoke-workspace","env":{}}\n' "$PORT" > "$BIVY_DATA_DIR/cli.json" )
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
grep -q '"ok":true' /tmp/bivy-smoke-health.json
timeout 30 bivy run -- /bin/sh -c 'printf bivy-run-ok' | tee /tmp/bivy-smoke-run.log
grep -q 'bivy-run-ok' /tmp/bivy-smoke-run.log
echo 'Clean curl installer, CLI, terminal, native run, and daemon smoke: passed'
