#!/usr/bin/env bash
# install.sh from GitHub release archives, hermetically: no host Node, npm or
# Bivy is reachable, and releases are served from disk through curl's file
# transport. Covers a fresh install, updates (keeping one previous version for
# rollback), refusing an archive that fails verification, and a release with
# no build for this machine.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=test/installer-fake-release.sh
. "$ROOT/test/installer-fake-release.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home"
for tool in bash env cat chmod mkdir mktemp rm dirname basename grep head awk tee find ln tar gzip mv cp touch uname curl sha256sum readlink tr paste; do
  ln -s "$(command -v "$tool")" "$WORK/bin/$tool"
done
RELEASES="$WORK/releases"
export FAKE_BIVY_LOG="$WORK/bivy.log"
TARGET="$(fake_target)"

FAILED=0
check() {
  if [ "$2" = "$3" ]; then printf '  ok  %s\n' "$1"
  else printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$3" "$2"; FAILED=1
  fi
}

install() {
  # Piped like `curl … | bash`: a child that reads stdin would eat the script.
  env -i PATH="$WORK/bin" HOME="$WORK/home" SHELL=/bin/bash BIVY_NO_RC_UPDATE=1 FAKE_BIVY_LOG="$FAKE_BIVY_LOG" \
    BIVY_RELEASES_URL="file://$RELEASES" "$@" bash < "$ROOT/install.sh" > "$WORK/out.log" 2>&1
}

INSTALL="$WORK/home/.local/share/bivy"
make_release "$RELEASES" staging 1.0.0-staging.1
install BIVY_CHANNEL=staging && status=0 || status=$?
check "fresh install succeeds without Node or npm" "$status" 0
check "current points at the version" "$(readlink "$INSTALL/current")" "versions/1.0.0-staging.1-$TARGET"
check "bivy on ~/.local/bin runs it" "$("$WORK/home/.local/bin/bivy" --version)" 1.0.0-staging.1
check "channel is recorded" "$(cat "$WORK/home/.bivy/channel")" staging

# An existing node gets restarted onto the new version.
echo '{}' > "$WORK/home/.bivy/cli.json"
make_release "$RELEASES" staging 1.0.0-staging.2
install BIVY_CHANNEL=staging
check "an update moves current" "$(readlink "$INSTALL/current")" "versions/1.0.0-staging.2-$TARGET"
check "the previous version stays for rollback" "$(ls "$INSTALL/versions" | tr '\n' ' ')" "1.0.0-staging.1-$TARGET 1.0.0-staging.2-$TARGET "
check "the existing node is restarted by the new version" "$(tail -n1 "$FAKE_BIVY_LOG")" "1.0.0-staging.2 restart"

make_release "$RELEASES" v1.0.0 1.0.0
install BIVY_VERSION=1.0.0
check "BIVY_VERSION installs that release" "$(readlink "$INSTALL/current")" "versions/1.0.0-$TARGET"
check "older versions are pruned" "$(ls "$INSTALL/versions" | tr '\n' ' ')" "1.0.0-$TARGET 1.0.0-staging.2-$TARGET "

make_release "$RELEASES" staging 1.0.1-staging.1
sed -i.bak 's/^[0-9a-f]\{8\}/00000000/' "$RELEASES/download/staging/SHA256SUMS"
install BIVY_CHANNEL=staging && status=0 || status=$?
check "an archive that fails verification is refused" "$status" 1
check "and the install is unchanged" "$(readlink "$INSTALL/current")" "versions/1.0.0-$TARGET"
check "with a reason" "$(grep -c 'failed verification' "$WORK/out.log")" 1

printf '%064d  bivy-9.9.9-plan9-mips.tar.gz\n' 0 > "$RELEASES/download/staging/SHA256SUMS"
install BIVY_CHANNEL=staging && status=0 || status=$?
check "a release without this platform fails" "$status" 1
check "naming the platform" "$(grep -c "no build for $TARGET" "$WORK/out.log")" 1

if [ "$FAILED" != 0 ]; then
  echo "--- last installer output ---"; tail -20 "$WORK/out.log"
  echo "installer-archive: FAILED"; exit 1
fi
echo "installer-archive: passed"
