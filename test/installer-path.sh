#!/usr/bin/env bash
#
# Covers #69: `bivy` not available as command after install.
#
# install.sh used to only *print* an `export PATH=...` line when the npm
# global bin dir wasn't already on PATH. Since the installer runs as a child
# process, that line can never reach the invoking shell — and because it was
# never persisted anywhere, every *future* terminal was missing 'bivy' too,
# not just the one that ran the installer. This covers the fix: an idempotent,
# marked PATH block appended to the detected shell's rc file, a no-op when
# BIN_DIR is already on PATH, and the BIVY_NO_RC_UPDATE opt-out.
#
# npm is stubbed out: we're testing PATH/rc handling, not npm.
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
# binary the installer expects to find afterwards, at a path deliberately NOT
# on the stub PATH below.
mkdir -p "$WORK/stub"
cat > "$WORK/stub/npm" <<STUB
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "prefix" ]; then echo "$WORK/npm-prefix"; exit 0; fi
if [ "\${1:-}" = "install" ]; then
  echo 'npm info install progress is visible' >&2
  mkdir -p "$WORK/npm-prefix/bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/npm-prefix/bin/bivy"
  chmod +x "$WORK/npm-prefix/bin/bivy"
  exit 0
fi
exit 0
STUB
chmod +x "$WORK/stub/npm"

# Expose the node we're already running under on the stub PATH. Without it the
# installer, seeing no supported Node in the bare `env -i` PATH below, takes its
# real bootstrap path — `sudo apt-get` + curl to nodesource — which is slow,
# needs the network, and has hung CI for hours when a mirror stalled. This test
# is about rc-file handling; Node acquisition is not under test.
ln -s "$(command -v node)" "$WORK/stub/node"

run_installer() {
  # HOME/SHELL are redirected so the installer's rc-file handling is contained.
  # $1: HOME dir  $2: SHELL  $3+: extra PATH entries (colon-joined) beyond the stub
  local home="$1" shell="$2" extra_path="$3"
  env -i \
    PATH="$WORK/stub:${extra_path:+$extra_path:}/usr/bin:/bin" \
    HOME="$home" \
    SHELL="$shell" \
    BIVY_DATA_DIR="$home/.bivy" \
    BIVY_HOME="$home/.bivy/app" \
    BIVY_NO_RC_UPDATE="${BIVY_NO_RC_UPDATE:-}" \
    bash "$INSTALLER" >"$WORK/out.log" 2>&1 || true
}

# --------------------------------------------------- bash: rc gets the block
HOME1="$WORK/home-bash"
mkdir -p "$HOME1"
echo '# pre-existing content' > "$HOME1/.bashrc"
run_installer "$HOME1" "/bin/bash" ""
check "bashrc gets a managed block" \
  "$(grep -c 'bivy path' "$HOME1/.bashrc" 2>/dev/null || echo 0)" '2'
check "block puts npm bin dir on PATH" \
  "$(grep -c "$WORK/npm-prefix/bin" "$HOME1/.bashrc" 2>/dev/null || echo 0)" '2'
check "pre-existing content preserved" \
  "$(head -1 "$HOME1/.bashrc")" '# pre-existing content'

# ------------------------------------------------- re-run is idempotent
run_installer "$HOME1" "/bin/bash" ""
check "second run does not duplicate the block" \
  "$(grep -c '# >>> bivy path >>>' "$HOME1/.bashrc" 2>/dev/null || echo 0)" '1'

# --------------------------------------------------- zsh: rc gets the block
HOME2="$WORK/home-zsh"
mkdir -p "$HOME2"
run_installer "$HOME2" "/usr/bin/zsh" ""
check "zshrc created with a managed block" \
  "$(grep -c 'bivy path' "$HOME2/.zshrc" 2>/dev/null || echo 0)" '2'
check "no .bashrc written for a zsh shell" \
  "$([ -e "$HOME2/.bashrc" ] && echo present || echo absent)" 'absent'

# ------------------------------------------ already on PATH: no rc touched
HOME3="$WORK/home-onpath"
mkdir -p "$HOME3/npm-prefix/bin" "$HOME3"
echo '# pre-existing content' > "$HOME3/.bashrc"
run_installer "$HOME3" "/bin/bash" "$WORK/npm-prefix/bin"
check "rc untouched when BIN_DIR already on PATH" \
  "$(cat "$HOME3/.bashrc")" '# pre-existing content'

# ------------------------------------------------- BIVY_NO_RC_UPDATE opt-out
HOME4="$WORK/home-noupdate"
mkdir -p "$HOME4"
echo '# pre-existing content' > "$HOME4/.bashrc"
BIVY_NO_RC_UPDATE=1 run_installer "$HOME4" "/bin/bash" ""
check "BIVY_NO_RC_UPDATE leaves the rc file untouched" \
  "$(cat "$HOME4/.bashrc")" '# pre-existing content'
check "BIVY_NO_RC_UPDATE still prints the manual export line" \
  "$(grep -c 'export PATH=' "$WORK/out.log" 2>/dev/null || echo 0)" '1'

# ------------------------------------------- unknown shell: manual fallback
HOME5="$WORK/home-unknown"
mkdir -p "$HOME5"
run_installer "$HOME5" "/bin/fish" ""
check "unknown shell gets manual instructions, no rc file created" \
  "$([ -e "$HOME5/.bashrc" ] || [ -e "$HOME5/.zshrc" ] && echo present || echo absent)" 'absent'
check "unknown shell manual export line still printed" \
  "$(grep -c 'export PATH=' "$WORK/out.log" 2>/dev/null || echo 0)" '1'
check "npm install progress is streamed" \
  "$(grep -c 'npm info install progress is visible' "$WORK/out.log" 2>/dev/null || echo 0)" '1'

if [ "$FAILED" != "0" ]; then
  echo "installer-path: FAILED"
  echo "--- last installer output ---"
  tail -20 "$WORK/out.log" 2>/dev/null || true
  exit 1
fi
echo "installer-path: passed"
