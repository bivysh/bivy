// SPDX-License-Identifier: FSL-1.1-ALv2
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
import { portIsFree, findAvailablePort } from "../bin/port-picker.mjs";

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
