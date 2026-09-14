#!/usr/bin/env bash
# Hermetic curl|bash regression: no host Node/npm/Bivy/apt/sudo can be reached.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home"
for tool in bash env cat chmod mkdir mktemp rm dirname basename grep head awk tee find ln tar mv cp touch uname; do
  ln -s "$(command -v "$tool")" "$WORK/bin/$tool"
done
cat > "$WORK/bin/id" <<'STUB'
#!/bin/bash
echo "${FAKE_UID:-0}"
STUB
cat > "$WORK/bin/sudo" <<'STUB'
#!/bin/bash
# Like sudo's env_reset: the caller must set debconf's environment AFTER sudo.
unset DEBIAN_FRONTEND
exec "$@"
STUB
cat > "$WORK/bin/apt-get" <<'STUB'
#!/bin/bash
set -eu
printf '%s frontend=%s\n' "$*" "${DEBIAN_FRONTEND:-unset}" >> "$WORK/apt.log"
cat > "$WORK/apt-stdin"
[ ! -s "$WORK/apt-stdin" ] || { echo 'apt consumed installer source' >&2; exit 1; }
[ "${DEBIAN_FRONTEND:-}" = noninteractive ] || exit 1
case "$*" in
  *nodejs*) touch "$WORK/node-ready" ;;
  *build-essential*)
    for tool in make g++ python3; do ln -sf /bin/true "$WORK/bin/$tool"; done ;;
esac
STUB
cat > "$WORK/bin/curl" <<'STUB'
#!/bin/bash
set -eu
[ "$2" = https://deb.nodesource.com/setup_22.x ] || exit 1
[ "$3" = -o ] || exit 1
cat > "$4" <<'SETUP'
#!/bin/bash
[ "$DEBIAN_FRONTEND" = noninteractive ] || exit 1
cat > "$WORK/nodesource-stdin"
[ ! -s "$WORK/nodesource-stdin" ]
SETUP
STUB
cat > "$WORK/bin/node" <<'STUB'
#!/bin/bash
case "$1" in
  -p) if [ -f "$WORK/node-ready" ]; then echo 1; else echo 0; fi ;;
  -v) echo v22.0.0 ;;
  *) echo claude ;;
esac
STUB
cat > "$WORK/bin/npm" <<'STUB'
#!/bin/bash
set -eu
case "$1" in
  -v) echo 10.0.0 ;;
  prefix) echo "$WORK/prefix" ;;
  install)
    # Another stdin reader, outside apt: the whole installer must already be parsed.
    cat > "$WORK/npm-stdin"
    echo "$*" >> "$WORK/npm.log"
    [ "${FAIL_NPM:-0}" = 0 ] || exit 42
    mkdir -p "$WORK/prefix/bin"
    printf '#!/bin/bash\nexit "${SETUP_EXIT:-0}"\n' > "$WORK/prefix/bin/bivy"
    chmod +x "$WORK/prefix/bin/bivy"
    ;;
esac
STUB
chmod +x "$WORK/bin/"{id,sudo,apt-get,curl,node,npm}

run_install() {
  # A pipe, NOT bash install.sh: that distinction caused the original regression.
  cat "$ROOT/install.sh" | env -i WORK="$WORK" HOME="$WORK/home" SHELL=/bin/bash \
    PATH="$WORK/bin" FAKE_UID="${FAKE_UID:-0}" FAIL_NPM="${FAIL_NPM:-0}" \
    bash > "$WORK/output.log" 2>&1
}
fail() { echo "FAIL: $*"; cat "$WORK/output.log"; exit 1; }

run_install || fail 'fresh piped install failed'
[ -x "$WORK/prefix/bin/bivy" ] || fail 'exit 0 without a Bivy executable'
grep -q 'Installer finished' "$WORK/output.log" || fail 'remaining script was swallowed'
grep -q 'build-essential python3 frontend=noninteractive' "$WORK/apt.log" || fail 'build tools not provisioned'
[ ! -s "$WORK/npm-stdin" ] || fail 'npm consumed installer source'
echo '  ok  fresh pipe installs Node, build tools, and Bivy without consuming shell source'

# sudo must preserve the explicit noninteractive policy, not ambient variables.
rm -f "$WORK/node-ready" "$WORK/bin/make" "$WORK/bin/g++" "$WORK/bin/python3"
FAKE_UID=1000 run_install || fail 'non-root bootstrap failed'
echo '  ok  prerequisite setup remains noninteractive through sudo'

rm -f "$WORK/apt.log"
run_install || fail 'supported Node/build-tools fast path failed'
[ ! -e "$WORK/apt.log" ] || fail 'fast path ran apt unnecessarily'
echo '  ok  existing Node and build tools skip apt'

if FAIL_NPM=1 run_install; then fail 'npm failure returned success'; fi
grep -q 'npm could not install' "$WORK/output.log" || fail 'npm failure was hidden'
echo '  ok  npm failure propagates'

# Give the installer a real controlling terminal: setup errors must not be
# mislabeled as headless installs and returned as success. No user input needed.
python3 - "$ROOT/install.sh" "$WORK" <<'PY'
import os, pty, select, signal, sys, time
installer, work = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    env = {"WORK": work, "HOME": work + "/home", "SHELL": "/bin/bash",
           "PATH": work + "/bin", "INSTALLER": installer, "SETUP_EXIT": "7"}
    os.execve("/bin/bash", ["bash", "-c", 'cat "$INSTALLER" | bash'], env)
output = b""
status = None
try:
    end = time.monotonic() + 20
    while time.monotonic() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                output += os.read(fd, 65536)
            except OSError:
                pass
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
    else:
        raise AssertionError("interactive installer timed out")
    assert os.waitstatus_to_exitcode(status) != 0, output.decode()
    assert b"Setup did not complete" in output, output.decode()
    assert b"No interactive terminal" not in output, output.decode()
finally:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
print("  ok  interactive setup failure is reported and returns nonzero")
PY
echo 'installer-bootstrap: passed'
