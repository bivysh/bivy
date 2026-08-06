// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Free-port selection for `bivy setup` (bin/port-picker.mjs). Guards the
// multi-node-on-one-machine fix: a second node must land on the next free port
// instead of colliding on 4317. `portIsFree` is exercised against a real
// listener; `findAvailablePort` is driven with an injected probe so the scan
// logic is deterministic and needs no sockets.
import { strict as assert } from "node:assert";
import test from "node:test";
import net from "node:net";
// @ts-expect-error - plain .mjs helper, no type declarations
import { portIsFree, findAvailablePort, reconcilePort } from "../bin/port-picker.mjs";

const HOST = "127.0.0.1";

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

test("portIsFree reports a bound port as taken and a spare port as free", async () => {
  const server = await listen(0);
  const busyPort = (server.address() as net.AddressInfo).port;
  try {
    assert.equal(await portIsFree(busyPort, HOST), false);
    assert.equal(await portIsFree(busyPort + 1, HOST), true);
  } finally {
    server.close();
  }
});

test("findAvailablePort returns the preferred port when it is free", async () => {
  const isFree = async () => true;
  assert.equal(await findAvailablePort(4317, HOST, isFree), 4317);
});

test("findAvailablePort skips busy ports and returns the first free one", async () => {
  const busy = new Set([4317, 4318]);
  const isFree = async (port: number) => !busy.has(port);
  assert.equal(await findAvailablePort(4317, HOST, isFree), 4319);
});

test("findAvailablePort falls back to the preferred port when the whole window is busy", async () => {
  const isFree = async () => false;
  assert.equal(await findAvailablePort(4317, HOST, isFree), 4317);
});

test("findAvailablePort probes upward from the preferred port, not from zero", async () => {
  const probed: number[] = [];
  const isFree = async (port: number) => {
    probed.push(port);
    return port === 4319;
  };
  const chosen = await findAvailablePort(4317, HOST, isFree);
  assert.equal(chosen, 4319);
  assert.deepEqual(probed, [4317, 4318, 4319]);
});

// reconcilePort guards the second-node collision at (re)start/install time — the
// gap where `bivy service install`/`restart`/`update` trusted a saved port a
// second node had since claimed.

test("reconcilePort keeps the saved port when it is free", async () => {
  const isFree = async () => true;
  assert.equal(await reconcilePort(4317, HOST, { isFree }), 4317);
});

test("reconcilePort keeps the port when our own node already holds it", async () => {
  // Busy, but it's ours — a plain restart must not relocate off its own port.
  const isFree = async () => false;
  const heldByOwnNode = async () => true;
  assert.equal(await reconcilePort(4317, HOST, { isFree, heldByOwnNode }), 4317);
});

test("reconcilePort rolls forward when a foreign node holds the port", async () => {
  const taken = new Set([4317]);
  const isFree = async (port: number) => !taken.has(port);
  const heldByOwnNode = async () => false; // occupant isn't ours
  assert.equal(await reconcilePort(4317, HOST, { isFree, heldByOwnNode }), 4318);
});

test("reconcilePort does not probe ownership when the port is already free", async () => {
  let ownershipChecked = false;
  const isFree = async () => true;
  const heldByOwnNode = async () => {
    ownershipChecked = true;
    return false;
  };
  assert.equal(await reconcilePort(4317, HOST, { isFree, heldByOwnNode }), 4317);
  assert.equal(ownershipChecked, false);
});

test("reconcilePort honors an explicit PORT override verbatim, without probing", async () => {
  let probed = false;
  const isFree = async () => {
    probed = true;
    return true;
  };
  assert.equal(await reconcilePort(4317, HOST, { explicitPort: 5000, isFree }), 5000);
  assert.equal(probed, false);
});
