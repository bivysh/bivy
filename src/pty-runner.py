#!/usr/bin/env python3
"""Run a command under a pseudo-terminal while relaying stdio over pipes."""

import os
import pty
import select
import signal
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pty-runner.py command [args...]", file=sys.stderr)
        return 2

    master_fd, slave_fd = pty.openpty()
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")

    proc = subprocess.Popen(
        sys.argv[1:],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    def forward_signal(signum, _frame):
        try:
            os.killpg(proc.pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True

    while True:
        read_fds = [master_fd]
        if stdin_open:
            read_fds.append(stdin_fd)

        readable, _, _ = select.select(read_fds, [], [], 0.1)

        if master_fd in readable:
            try:
                data = os.read(master_fd, 8192)
            except OSError:
                data = b""
            if not data:
                break
            os.write(stdout_fd, data)

        if stdin_open and stdin_fd in readable:
            data = os.read(stdin_fd, 8192)
            if not data:
                stdin_open = False
            else:
                try:
                    os.write(master_fd, data)
                except OSError:
                    break

        if proc.poll() is not None:
            # Drain any final PTY output.
            while True:
                readable, _, _ = select.select([master_fd], [], [], 0)
                if not readable:
                    break
                try:
                    data = os.read(master_fd, 8192)
                except OSError:
                    break
                if not data:
                    break
                os.write(stdout_fd, data)
            break

    try:
        os.close(master_fd)
    except OSError:
        pass

    return proc.wait()


if __name__ == "__main__":
    raise SystemExit(main())
