// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayConnector } from "../src/remote/relay-client.js";
import { clearTurnActivity } from "../src/session/turn-activity.js";
import { shouldSelfTeardown } from "../src/ephemeral-teardown.js";

async function waitFor(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error("presence update timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("remote turn settlement releases pending activity on success, error and abort", () => {
  for (const outcome of ["success", "error", "abort"]) {
    const record = { isWorking: true, remoteActive: true, lastActivity: outcome as unknown, workingStartedAt: 1 as number | undefined };
    clearTurnActivity(record);
    assert.equal(record.isWorking, false);
    assert.equal(record.remoteActive, false);
    assert.equal(record.lastActivity, undefined);
    assert.equal(record.workingStartedAt, undefined);
  }
});

test("real relay frames retain viewing clients and release teardown after the last disconnect", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connector = new RelayConnector({ url: `ws://127.0.0.1:${address.port}`, room: "test-room", roomToken: "test-token" }, () => {}, { pairing: { roomKey: () => Buffer.alloc(32) } as never });
  let peer: WebSocket | undefined;
  server.on("connection", (socket) => { peer = socket; socket.send(JSON.stringify({ t: "ready" })); });
  try {
    connector.start();
    await waitFor(() => connector.connected);
    peer!.send(JSON.stringify({ t: "peer.online", clients: 2 }));
    await waitFor(() => connector.clientCount === 2);
    const cfg = { enabled: true, provider: "fly", ttlMin: 5, onFinish: true, finishGraceMs: 10, idleGraceMs: 100 };
    const quiet = { everBusy: true, anyWorking: false, inFlightWork: 0, idleForMs: 1000 };
    assert.equal(shouldSelfTeardown(cfg, { ...quiet, anyRemoteActive: connector.clientCount > 0 }), false);
    peer!.send(JSON.stringify({ t: "peer.offline", clients: 1 }));
    await waitFor(() => connector.clientCount === 1);
    assert.equal(shouldSelfTeardown(cfg, { ...quiet, anyRemoteActive: connector.clientCount > 0 }), false);
    peer!.send(JSON.stringify({ t: "peer.offline", clients: 0 }));
    await waitFor(() => connector.clientCount === 0);
    assert.equal(shouldSelfTeardown(cfg, { ...quiet, anyRemoteActive: connector.clientCount > 0 }), true);
    peer!.send(JSON.stringify({ t: "peer.online", clients: 1 }));
    await waitFor(() => connector.clientCount === 1);
    connector.stop();
    assert.equal(connector.clientCount, 0);
  } finally {
    connector.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
