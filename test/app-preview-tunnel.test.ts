// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { PreviewRelay } from "../services/relay/src/preview.js";
import { RemotePreview } from "../src/apps/remote-preview.js";
import { AppRegistry } from "../src/apps/registry.js";
import { AppService } from "../src/apps/service.js";

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
function request(port: number, host: string, url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ agent: false, hostname: "127.0.0.1", port, path: url, method: options.method ?? "GET", headers: { host, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(options.body);
  });
}
async function fixture() {
  const previews = new PreviewRelay("https://{app}.preview.example.net", 3000);
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => { if (!previews.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.on("upgrade", (req, socket, head) => {
    if (previews.upgrade(req, socket, head) || previews.upgradeStream(req, socket, head)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      const origin = previews.attach(ws, req.url!.slice(1));
      ws.send(JSON.stringify({ t: "ready", previewOrigin: origin }));
    });
  });
  const port = await listen(server);
  const remote: RemotePreview[] = [];
  const clients: WebSocket[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-preview-tunnel-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>It works</h1>");
  const asset = Buffer.alloc(2 * 1024 * 1024, 123);
  fs.writeFileSync(path.join(dir, "large.bin"), asset);
  async function node(id: string) {
    const registry = new AppRegistry();
    const delivery = new RemotePreview(registry, () => ["https://bivy.example"]);
    remote.push(delivery);
    let origin = "";
    const tickets: string[] = [];
    const control = new WebSocket(`ws://127.0.0.1:${port}/${id}`);
    clients.push(control);
    const ready = new Promise<void>((resolve) => {
      control.on("message", (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.t === "ready") { origin = message.previewOrigin; delivery.ready(origin, `ws://127.0.0.1:${port}`); resolve(); }
        else if (message.t === "preview.connect") { tickets.push(message.ticket); delivery.connect(message.ticket); }
      });
    });
    control.on("close", () => delivery.disconnect());
    await ready;
    const service = new AppService(registry, delivery, { start: async () => "term", has: () => true, close: () => {} });
    return { service, delivery, registry, control, origin, tickets };
  }
  return { port, dir, asset, node, previews, async close() {
    for (const item of remote) item.close();
    previews.close();
    for (const client of clients) client.terminate();
    for (const client of wss.clients) client.terminate();
    wss.close(); server.close(); server.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

async function grant(port: number, launch: URL) {
  const shell = await request(port, launch.host, "/__bivy/open");
  assert.equal(shell.status, 200); assert.match(shell.body.toString(), /Back to chat/);
  const meta = await request(port, launch.host, "/__bivy/launch", { method: "POST", headers: { origin: launch.origin }, body: launch.hash.slice(1) });
  assert.equal(meta.status, 200);
  const origin = JSON.parse(meta.body.toString()).origin;
  const url = new URL(origin);
  const redeemed = await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin }, body: launch.hash.slice(1) });
  assert.equal(redeemed.status, 204);
  return { url, cookie: redeemed.headers["set-cookie"]![0].split(";")[0] };
}

test("publishing becomes previewable through automatic outbound delivery; no node listener/config", async () => {
  const f = await fixture();
  try {
    const a = await f.node("node-a");
    const app = a.service.publish("session", f.dir, { version: 1, name: "Automatic", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "." } }] });
    assert.equal(a.service.list("session").previewAvailable, true);
    const opened = await a.service.open("session", app.id, app.views[0].id, "https://bivy.example/sessions/session");
    assert.equal(opened.kind, "web"); if (opened.kind !== "web") return;
    const launch = new URL(opened.url);
    assert.ok(launch.hostname.split(".")[0].length <= 63);
    const { url, cookie } = await grant(f.port, launch);
    const tickets = a.tickets.length;
    const before = f.previews.metrics().bytesFromNode;
    assert.equal((await request(f.port, url.host, "/")).status, 401);
    assert.equal((await request(f.port, url.host, "/", { headers: { cookie } })).body.toString(), "<h1>It works</h1>");
    assert.deepEqual((await request(f.port, url.host, "/large.bin", { headers: { cookie } })).body, f.asset);
    // One kept-alive node stream carries a view's successive requests, and is counted.
    assert.equal(a.tickets.length - tickets, 1);
    assert.ok(f.previews.metrics().bytesFromNode - before > f.asset.length);
    a.service.remove("session", app.id);
    assert.equal((await request(f.port, url.host, "/", { headers: { cookie } })).status, 404);
  } finally { await f.close(); }
});

test("host ownership, one-use stream tickets, offline routing and relay API isolation fail closed", async () => {
  const f = await fixture();
  try {
    const a = await f.node("node-a"); const b = await f.node("node-b");
    const app = a.service.publish("session", f.dir, { version: 1, name: "Private", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "." } }] });
    const access = await grant(f.port, new URL(a.delivery.open(app.views[0].id)));
    const bHost = new URL(b.origin.replace("{app}", app.views[0].id)).host;
    assert.equal((await request(f.port, bHost, "/", { headers: { cookie: access.cookie } })).status, 404);
    for (const host of ["unknown.preview.example.net", "unknown.preview.example.net:443", "preview.example.net"]) {
      for (const route of ["/metrics", "/internal/work-available", "/healthz"]) assert.equal((await request(f.port, host, route)).status, 503);
    }
    const bad = new WebSocket(`ws://127.0.0.1:${f.port}/preview/stream`, { headers: { authorization: `Bearer ${a.tickets[0]}` } });
    bad.on("error", () => {});
    await once(bad, "unexpected-response").then(([, res]) => { assert.equal((res as http.IncomingMessage).statusCode, 403); (res as http.IncomingMessage).resume(); bad.terminate(); });
    const closed = once(a.control, "close"); a.control.close(); await closed;
    assert.equal(a.service.list("session").previewAvailable, false);
    assert.equal((await request(f.port, access.url.host, "/", { headers: { cookie: access.cookie } })).status, 503);
  } finally { await f.close(); }
});

test("stalled node streams are bounded, time out and release capacity for recovery", async () => {
  const f = await fixture();
  try {
    const a = await f.node("stalled-node");
    const app = a.service.publish("s", f.dir, { version: 1, name: "Recovery", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "." } }] });
    const access = await grant(f.port, new URL(a.delivery.open(app.views[0].id)));
    a.delivery.disconnect();
    const before = a.tickets.length;
    const failures = await Promise.all(Array.from({ length: 65 }, () => request(f.port, access.url.host, "/")));
    assert.ok(failures.every((response) => response.status === 502));
    assert.ok(a.tickets.length - before <= 64, "excess streams must not reach the node");
    a.delivery.ready(a.origin, `ws://127.0.0.1:${f.port}`);
    assert.equal((await request(f.port, access.url.host, "/", { headers: { cookie: access.cookie } })).status, 200);
  } finally { await f.close(); }
});

test("live service HTTP uploads, cookies and WebSockets traverse the outbound tunnel", async () => {
  const f = await fixture();
  let upstreamCookie: string | undefined;
  const backend = http.createServer((req, res) => {
    upstreamCookie = req.headers.cookie;
    let size = 0; req.on("data", (chunk: Buffer) => { size += chunk.length; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "app=value; Path=/" });
      res.end(String(size));
    });
  });
  const wsBackend = new WebSocketServer({ server: backend });
  wsBackend.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
  const backendPort = await listen(backend);
  try {
    const a = await f.node("service-node");
    const app = a.service.publish("s", f.dir, { version: 1, name: "Live", views: [{ kind: "web", name: "Site", source: { kind: "service", port: backendPort } }] });
    const access = await grant(f.port, new URL(a.delivery.open(app.views[0].id)));
    const response = await request(f.port, access.url.host, "/api", { method: "POST", body: "a".repeat(2 * 1024 * 1024), headers: { origin: access.url.origin, cookie: `${access.cookie}; app=value` } });
    assert.equal(response.status, 200); assert.equal(response.body.toString(), String(2 * 1024 * 1024));
    assert.equal(upstreamCookie?.trim(), "app=value");
    assert.deepEqual(response.headers["set-cookie"], ["app=value; Path=/"]);
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/socket`, { origin: access.url.origin, headers: { host: access.url.host, cookie: access.cookie } });
    await once(ws, "open"); ws.send("hello");
    assert.equal((await once(ws, "message"))[0].toString(), "hello");
    const closed = once(ws, "close"); a.service.remove("s", app.id); await closed;
  } finally {
    for (const ws of wsBackend.clients) ws.terminate();
    wsBackend.close(); backend.close(); backend.closeAllConnections(); await f.close();
  }
});
