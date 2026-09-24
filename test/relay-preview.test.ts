// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { RelayConnector } from "../src/remote/relay-client.js";
import { RemotePreview } from "../src/apps/remote-preview.js";
import { AppRegistry } from "../src/apps/registry.js";

async function waitFor(check: () => boolean | Promise<boolean>) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > 10_000) throw new Error("Preview connection timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("real relay admission automatically enables previews; clients cannot inject tunnel controls; reconnect preserves grants", { timeout: 25_000 }, async () => {
  const portServer = http.createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const proc = spawn(process.execPath, ["--import", "tsx", "services/relay/src/index.ts"], {
    env: { ...process.env, NODE_ENV: "test", SENTRY_DSN: "", PORT: String(port), BIND_HOST: "127.0.0.1", RELAY_ALLOW_ROOM_TOKENS: "1", CONTROL_PLANE_URL: "http://127.0.0.1:1", RELAY_SECRET: "test-preview-relay-secret", RELAY_PREVIEW_ORIGIN: "https://{app}.preview.example.net" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
  proc.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
  const registry = new AppRegistry();
  const delivery = new RemotePreview(registry, () => []);
  let streamRequests = 0;
  const roomToken = "test-preview-room-secret-at-least-32-chars";
  const relay = new RelayConnector({ url: `ws://127.0.0.1:${port}`, room: "preview-room", roomToken }, () => {}, {
    pairing: { roomKey: () => Buffer.alloc(32) } as never,
    previews: { ready: (...args) => delivery.ready(...args), disconnect: () => delivery.disconnect(), connect: (ticket) => { streamRequests++; delivery.connect(ticket); } },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-preview-relay-"));
  let client: WebSocket | undefined;
  try {
    await waitFor(async () => {
      if (proc.exitCode !== null) throw new Error(logs);
      try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; }
    });
    relay.start(); await waitFor(() => delivery.available);
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>Automatic preview</h1>");
    const app = registry.publish("s", dir, { version: 1, name: "Preview", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "." } }] });
    const launch = new URL(delivery.open(app.views[0].id));
    const metadata = () => new Promise<number>((resolve, reject) => {
      const req = http.request({ agent: false, hostname: "127.0.0.1", port, path: "/__bivy/launch", method: "POST", headers: { host: launch.host, origin: launch.origin } }, (res) => {
        res.resume(); res.once("end", () => resolve(res.statusCode!)); res.on("error", reject);
      });
      req.on("error", reject); req.end(launch.hash.slice(1));
    });
    assert.equal(await metadata(), 200);
    client = new WebSocket(`ws://127.0.0.1:${port}/client?room=preview-room&roomToken=${roomToken}`);
    await once(client, "message");
    const before = streamRequests;
    client.send(JSON.stringify({ t: "preview.connect", ticket: "a".repeat(64) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(streamRequests, before);
    relay.stop(); assert.equal(delivery.available, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    relay.start(); await waitFor(() => delivery.available);
    assert.equal(await metadata(), 200, "grant remains valid across an ordinary reconnect");
  } finally {
    client?.terminate(); relay.stop(); delivery.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (proc.exitCode === null) { const exited = once(proc, "exit"); proc.kill("SIGTERM"); await exited; }
  }
});
