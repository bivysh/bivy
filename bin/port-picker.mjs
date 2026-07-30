// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Free-port selection for `bivy setup`, extracted so it can be unit-tested
// without executing the CLI (bin/bivy.mjs runs main() on import).
//
// Background: every node defaulted its local port to 4317, and setup never
// checked whether that port was already taken. Running a second node on the same
// machine — a staging + production node, or one node per OS user — therefore
// collided: the loopback address 127.0.0.1:4317 is machine-wide, not per-user,
// so whichever node started second failed to bind. Users had to discover this
// and hand-pick a port. Setup now takes the first free port at or above the
// preferred one, so additional nodes land on 4318, 4319, … automatically.
import net from "node:net";

// Is `port` bindable on `host` right now? Resolves false on EADDRINUSE (another
// node/process already holds it — the exact collision two nodes hit when both
// default to 4317), true when the port is free, and true on any other error so a
// probe quirk never blocks setup on an otherwise-usable port.
export function portIsFree(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (err) => {
      tester.close();
      resolve(err?.code !== "EADDRINUSE");
    });
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

// First free port at or after `preferred`, so a second node on the same machine
// lands on 4318, 4319, … automatically instead of failing to bind. Falls back to
// `preferred` if the whole scan window is somehow busy (the daemon then reports a
// clear EADDRINUSE rather than the CLI hanging). `isFree` is injectable for tests.
export async function findAvailablePort(preferred, host, isFree = portIsFree) {
  for (let port = preferred; port < preferred + 100; port++) {
    if (await isFree(port, host)) return port;
  }
  return preferred;
}
