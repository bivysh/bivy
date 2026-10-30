// SPDX-License-Identifier: MIT
// `bivy doctor --network` probes: each one reports success or the reason it
// failed, and never throws.
import { strict as assert } from "node:assert";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { probeConnect, probeHttp } from "../bin/network-probe.mjs";

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("probeHttp reports the status of an answering server and the error of a closed port", async () => {
  const server = http.createServer((req, res) => { res.statusCode = req.url === "/healthz" ? 200 : 503; res.end("x"); });
  const port = await listen(server);
  try {
    const up = await probeHttp(`http://127.0.0.1:${port}/healthz`);
    assert.equal(up.ok, true);
    assert.equal(up.status, 200);
    const down = await probeHttp(`http://127.0.0.1:${port}/other`);
    assert.deepEqual([down.ok, down.status], [false, 503]);
  } finally {
    server.close();
  }
  const refused = await probeHttp(`http://127.0.0.1:${await closedPort()}/healthz`);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/);
});

test("probeConnect opens a TCP connection, and reports a refused connection and a failed TLS handshake", async () => {
  const server = net.createServer((socket) => socket.end());
  const port = await listen(server);
  try {
    assert.equal((await probeConnect(`ws://127.0.0.1:${port}/relay`)).ok, true);
    // A plain TCP server cannot complete a TLS handshake.
    const tlsResult = await probeConnect(`wss://127.0.0.1:${port}/relay`, 2000);
    assert.equal(tlsResult.ok, false);
    assert.ok(tlsResult.error);
  } finally {
    server.close();
  }
  const refused = await probeConnect(`wss://127.0.0.1:${await closedPort()}/relay`);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/);
  assert.deepEqual(await probeConnect("not a url"), { ok: false, ms: 0, error: "invalid URL" });
});
