// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Tie a protocol shim's agent child to the node that launched the shim.
//
// A shim talks to the node over its own stdin/stdout and to the agent over the
// child's pipes. When the node goes away without closing the session (a crash,
// an OOM kill, a restart), the shim's stdin ends, but the open child pipes keep
// its event loop alive, so the shim and the agent run on as orphans holding
// hundreds of MB each. Some agents also ignore EOF on their own stdin. So on
// either signal the node is gone, end the child's stdin, ask it to stop, force
// it after a grace period, and exit.

const GRACE_MS = 3000;

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ input?: NodeJS.ReadableStream, graceMs?: number, exit?: (code: number) => void }} [options]
 */
export function exitWithParent(child, options = {}) {
  const input = options.input ?? process.stdin;
  const graceMs = options.graceMs ?? GRACE_MS;
  const exit = options.exit ?? ((code) => process.exit(code));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode !== null || child.signalCode !== null) return exit(0);
    child.once("exit", () => exit(0));
    try { child.stdin?.end(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      exit(0);
    }, graceMs);
  };
  input.on("end", stop);
  input.on("close", stop);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, stop);
  return stop;
}
