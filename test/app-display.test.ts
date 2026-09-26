// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { AppRegistry } from "../src/apps/registry.js";
import { AppService, type AppDisplayProvider } from "../src/apps/service.js";
import { AppGateway } from "../src/apps/gateway.js";
import { DisplayHost, findXvnc } from "../src/apps/display.js";
import { captureFrame } from "../src/apps/rfb.js";
import type { AppManifest } from "../packages/core/src/apps.js";

const manifest: AppManifest = { version: 1, name: "Editor", views: [{ kind: "display", name: "Window", command: "my-editor", args: ["--new"] }] };
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };

test("desktop views start their display, then the app on it; restart the app; stop both on remove", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-display-"));
  const live = new Set<string>(); const started: { command: string; env?: Record<string, string> }[] = []; const stopped: string[] = [];
  const terminals = { start: async (spec: { command: string; env?: Record<string, string> }) => { const id = `t${started.length}`; started.push(spec); live.add(id); return id; }, has: (id: string) => live.has(id), close: (id: string) => { live.delete(id); } };
  const displays: AppDisplayProvider = { unavailable: () => undefined, ensure: async () => ({ socket: "/run/vnc.sock", env: { DISPLAY: ":100" }, wm: { count: 1 } }), stop: (id) => { stopped.push(id); } };
  const gateway = { open: () => "https://view-x.preview.example.net/__bivy/open#t", share: () => ({ url: "", expiresAt: 0 }), revoke: () => {} };
  try {
    const refused = new AppService(new AppRegistry(), gateway, terminals, { displays: { ...displays, unavailable: () => "Needs Linux." } });
    assert.throws(() => refused.publish("s", dir, manifest), /Needs Linux/, "an agent learns at publish time");

    const registry = new AppRegistry();
    const service = new AppService(registry, gateway, terminals, { displays, serverWatchMs: 5 });
    const app = service.publish("s", dir, manifest);
    assert.deepEqual(app.views.map((v) => v.kind === "web" && [v.source, v.managed]), [["display", true]], "shown through the web preview, with logs");
    assert.deepEqual(started, [], "publishing starts nothing");
    const viewId = app.views[0].id;
    await service.open("s", app.id, viewId);
    await until(() => started.length === 1);
    assert.equal(started[0].command, "my-editor");
    assert.equal(started[0].env?.DISPLAY, ":100");
    assert.equal(registry.getView(viewId)!.display, "/run/vnc.sock", "the gateway can find the display");
    live.delete("t0"); // the app exits
    await until(() => started.length === 2);
    service.remove("s", app.id);
    assert.deepEqual(stopped, [viewId]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
function get(port: number, host: string, url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get({ agent: false, hostname: "127.0.0.1", port, path: url, headers: { host, ...headers } }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject);
  });
}

test("a display view's origin serves only its viewer and noVNC, and streams the display over its WebSocket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-display-"));
  const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const vnc = net.createServer((socket) => { socket.write("RFB 003.008\n"); socket.on("data", (data) => socket.write(data)); });
  try {
    const app = registry.publish("s", dir, manifest);
    const id = app.views[0].id;
    const port = await listen(gateway.server);
    const origin = gateway.origin(id); const host = new URL(origin).host;
    const launch = new URL(gateway.open(id));
    const redeem = await new Promise<string>((resolve) => {
      const req = http.request({ agent: false, hostname: "127.0.0.1", port, path: "/__bivy/redeem", method: "POST", headers: { host, origin } }, (res) => { res.resume(); resolve(res.headers["set-cookie"]![0].split(";")[0]); });
      req.end(launch.hash.slice(1));
    });
    const cookie = { cookie: redeem };

    const page = await get(port, host, "/", { ...cookie, "sec-fetch-dest": "iframe" });
    assert.equal(page.status, 200);
    const csp = String(page.headers["content-security-policy"]);
    assert.match(csp, /script-src 'self' 'nonce-[a-f0-9]{32}'/);
    assert.ok(csp.includes(`connect-src 'self' wss://${host};`), csp);
    assert.doesNotMatch(page.body, /__bivy\/inspector/, "no inspector in the viewer");
    const rfb = await get(port, host, "/__bivy/novnc/core/rfb.js", cookie);
    assert.equal(rfb.status, 200);
    assert.match(String(rfb.headers["content-type"]), /javascript/);
    for (const url of ["/__bivy/novnc/core/../../package.json", "/__bivy/novnc/package.json", "/__bivy/novnc/core/rfb.js.map", "/anything.js"]) {
      assert.equal((await get(port, host, url, cookie)).status, 404, url);
    }

    const sock = path.join(dir, "vnc.sock");
    vnc.listen(sock); await once(vnc, "listening");
    registry.getView(id)!.display = sock;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__bivy/display`, { headers: { host, origin, ...cookie } });
    const first = await new Promise<Buffer>((resolve, reject) => { ws.once("message", (data) => resolve(data as Buffer)); ws.once("error", reject); });
    assert.equal(first.toString(), "RFB 003.008\n");
    ws.send(Buffer.from("ping"));
    assert.equal(String(await new Promise((resolve) => ws.once("message", resolve))), "ping");
    ws.close();

    const elsewhere = new WebSocket(`ws://127.0.0.1:${port}/other`, { headers: { host, origin, ...cookie } });
    await assert.rejects(once(elsewhere, "open"), /403/);
  } finally { gateway.close(); vnc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/** Just enough of an X11 client to open windows the way a toolkit does. */
async function xClient(display: { env: Record<string, string> }) {
  const cookie = fs.readFileSync(display.env.XAUTHORITY).subarray(-16);
  const socket = net.connect(`/tmp/.X11-unix/X${display.env.DISPLAY.slice(1)}`);
  const name = Buffer.from("MIT-MAGIC-COOKIE-1");
  const setup = Buffer.alloc(12); setup.write("l"); setup.writeUInt16LE(11, 2); setup.writeUInt16LE(name.length, 6); setup.writeUInt16LE(16, 8);
  socket.write(Buffer.concat([setup, name, Buffer.alloc(2), cookie]));
  let buffer = Buffer.alloc(0);
  const read = async (n: number) => { while (buffer.length < n) buffer = Buffer.concat([buffer, (await once(socket, "data"))[0] as Buffer]); const out = buffer.subarray(0, n); buffer = buffer.subarray(n); return out; };
  const head = await read(8);
  const body = await read(head.readUInt16LE(6) * 4);
  assert.equal(head[0], 1, "connected with the display's cookie");
  const base = body.readUInt32LE(4);
  const vendor = body.readUInt16LE(16);
  const root = body.readUInt32LE(32 + vendor + ((4 - vendor % 4) % 4) + body[21]! * 8);
  let next = 0;
  const send = (op: number, data: number, words: number[], extra = Buffer.alloc(0)) => {
    const out = Buffer.alloc(4 + words.length * 4); out[0] = op; out[1] = data; out.writeUInt16LE(1 + words.length + extra.length / 4, 2);
    words.forEach((w, i) => out.writeUInt32LE(w >>> 0, 4 + i * 4)); socket.write(Buffer.concat([out, extra]));
  };
  return {
    window(width: number, height: number, parent?: number): number {
      const id = base | ++next;
      send(1, 0, [id, root, 0, width | (height << 16), 1, 0, 0]); // CreateWindow, InputOutput
      if (parent) send(18, 0, [id, 68, 33, 32, 1, parent]); // WM_TRANSIENT_FOR
      send(8, 0, [id]); // MapWindow
      return id;
    },
    async geometry(id: number): Promise<number[]> {
      send(14, 0, [id]); // GetGeometry
      for (;;) { const reply = await read(32); if (reply[0] === 1) return [reply.readInt16LE(12), reply.readInt16LE(14), reply.readUInt16LE(16), reply.readUInt16LE(18)]; }
    },
    close: () => socket.destroy(),
  };
}

test("a real display fits app windows to the screen, centers dialogs, and is captured as a PNG", { skip: (process.platform !== "linux" || !findXvnc()) && "needs Linux with TigerVNC (Xvnc)" }, async () => {
  const host = new DisplayHost();
  try {
    const display = await host.ensure("view", "Test");
    assert.deepEqual(display.wm.size, [1280, 800]);
    const client = await xClient(display);
    const main = client.window(300, 200);
    const dialog = client.window(400, 300, main);
    await until(() => display.wm.count === 2);
    assert.deepEqual(await client.geometry(main), [0, 0, 1280, 800], "a window fills the display");
    assert.deepEqual(await client.geometry(dialog), [440, 250, 400, 300], "a dialog keeps its size, centered");
    const frame = await captureFrame(display.socket);
    assert.deepEqual([frame.width, frame.height, frame.rgb.length], [1280, 800, 1280 * 800 * 3]);
    client.close();
    const dir = path.dirname(display.socket);
    host.stop("view");
    assert.equal(fs.existsSync(dir), false, "the display's cookie and socket are removed");
  } finally { host.stopAll(); }
});
