// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RelayConnector, type RelayConfig } from "../src/remote/index.js";
import { PairingStore } from "../src/device-registry.js";

/**
 * Regression test: a routine control-plane/relay DEPLOY briefly rejects a
 * reconnecting node's admission ("Unauthorized node"). The connector used to
 * treat that as permanently fatal — it set `closed` and never retried — so
 * every node stayed offline until manually restarted, on every update. See
 * relay-client.ts isAdmissionRelayError / scheduleReconnect.
 *
 * Here a fake relay rejects every connection with an admission error. The node
 * must keep reconnecting (proving the connector no longer gives up for good),
 * and must NOT report itself connected while it is being rejected.
 */

/** Fake relay that rejects every node connection with an admission error, and
 *  counts how many times the node (re)dials. */
function startRejectingRelay(): Promise<{ url: string; connections: () => number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let connections = 0;
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address() as { port: number };
      resolve({
        url: `ws://127.0.0.1:${port}`,
        connections: () => connections,
        close: () => new Promise((r) => wss.close(() => r())),
      });
    });
    wss.on("connection", (ws) => {
      connections += 1;
      // Same shape services/relay emits when control-plane introspection fails.
      ws.send(JSON.stringify({ t: "error", error: "Unauthorized node" }));
    });
  });
}

test("relay connector keeps retrying after an admission rejection (does not permanently disable)", async () => {
  const relay = await startRejectingRelay();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-relay-reconnect-"));
  // Solo (account-free) admission so the connector dials the relay directly with
  // room+token instead of minting a control-plane ticket — keeps the test to a
  // single fake process while exercising the exact same message/reconnect path.
  const config: RelayConfig = { url: relay.url, room: "room-test", roomToken: "token-test" };
  const connector = new RelayConnector(config, () => {}, { pairing: PairingStore.load(dir) });

  try {
    connector.start();
    // The first reconnect is scheduled ~1s out (backoff floor). Poll until we've
    // seen a second dial, which the old permanent-disable behavior never did.
    const deadline = Date.now() + 5000;
    while (relay.connections() < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      relay.connections() >= 2,
      `expected the connector to redial after an admission rejection, saw ${relay.connections()} connection(s)`,
    );
    // While rejected it must not claim to be connected, and it surfaces why.
    assert.equal(connector.connected, false);
    assert.match(connector.lastError ?? "", /Unauthorized node/);
  } finally {
    connector.stop();
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
