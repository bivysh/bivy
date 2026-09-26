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
import { MacDisplayHost } from "../src/apps/macos-display.js";
import { inflateSync, constants as zlibConstants } from "node:zlib";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppManifest } from "../packages/core/src/apps.js";

const manifest: AppManifest = { version: 1, name: "Editor", views: [{ kind: "display", name: "Window", command: "my-editor", args: ["--new"], restartOnChange: true }] };
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };

test("desktop views start their display at the viewer's density, then the app; restart it on exit and after changes; stop both on remove", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-display-"));
  const live = new Set<string>(); const started: { command: string; env?: Record<string, string> }[] = []; const stopped: string[] = [];
  const terminals = { start: async (spec: { command: string; env?: Record<string, string> }) => { const id = `t${started.length}`; started.push(spec); live.add(id); return id; }, has: (id: string) => live.has(id), close: (id: string) => { live.delete(id); } };
  const scales: (number | undefined)[] = [];
  const displays: AppDisplayProvider = { unavailable: () => undefined, ensure: async (_id, _name, scale) => { scales.push(scale); return { socket: "/run/vnc.sock", env: { DISPLAY: ":100" }, wm: { count: 1 } }; }, stop: (id) => { stopped.push(id); } };
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
    await service.open("s", app.id, viewId, undefined, false, 2);
    await until(() => started.length === 1);
    assert.equal(scales[0], 2, "a 2× phone gets a 2× display");
    assert.equal(started[0].command, "my-editor");
    assert.equal(started[0].env?.DISPLAY, ":100");
    assert.equal(registry.getView(viewId)!.display, "/run/vnc.sock", "the gateway can find the display");
    live.delete("t0"); // the app exits
    await until(() => started.length === 2);
    assert.deepEqual(service.turnChanged("s"), [viewId]);
    await until(() => started.length === 3);
    assert.equal(live.has("t1"), false, "the old instance is closed, not left running");
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

    const stats = await new Promise<number>((resolve) => {
      const req = http.request({ agent: false, hostname: "127.0.0.1", port, path: "/__bivy/display-stats", method: "POST", headers: { host, origin, "content-type": "application/json", ...cookie } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.end(JSON.stringify({ latencyMs: { p50: 12.34, p95: "x" }, kBps: 1e12, viewport: { width: 390, height: 844, scale: 2 }, extra: "<script>" }));
    });
    assert.equal(stats, 204);
    assert.deepEqual({ ...registry.getView(id)!.stats, at: 0 }, { at: 0, latencyMs: { p50: 12.3, p95: 0 }, kBps: 1e6, viewport: { width: 390, height: 844, scale: 2 } }, "numbers only, bounded");

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
    window(width: number, height: number, options: { parent?: number; min?: [number, number] } = {}): number {
      const id = base | ++next;
      send(1, 0, [id, root, 0, width | (height << 16), 1, 0, 0]); // CreateWindow, InputOutput
      if (options.parent) send(18, 0, [id, 68, 33, 32, 1, options.parent]); // WM_TRANSIENT_FOR
      if (options.min) send(18, 0, [id, 40, 41, 32, 18, 16, 0, 0, 0, 0, ...options.min, ...Array(11).fill(0)]); // WM_NORMAL_HINTS, PMinSize
      send(8, 0, [id]); // MapWindow
      return id;
    },
    async geometry(id: number): Promise<number[]> {
      send(14, 0, [id]); // GetGeometry
      for (;;) { const reply = await read(32); if (reply[0] === 1) return [reply.readInt16LE(12), reply.readInt16LE(14), reply.readUInt16LE(16), reply.readUInt16LE(18)]; }
    },
    async resources(): Promise<string> {
      send(20, 0, [root, 23, 31, 0, 1024]); // GetProperty RESOURCE_MANAGER
      for (;;) { const head = await read(32); if (head[0] !== 1) continue; const body = await read(head.readUInt32LE(4) * 4); return body.subarray(0, head.readUInt32LE(16)).toString(); }
    },
    close: () => socket.destroy(),
  };
}

test("a real 2× display fits windows, centers dialogs, grows for wide ones, and is captured as a PNG", { skip: (process.platform !== "linux" || !findXvnc()) && "needs Linux with TigerVNC (Xvnc)" }, async () => {
  const host = new DisplayHost();
  try {
    const display = await host.ensure("view", "Test", 2);
    assert.deepEqual(display.wm.size, [2560, 1600]);
    assert.equal(display.env.GDK_SCALE, "2");
    const client = await xClient(display);
    assert.match(await client.resources(), /^Xft\.dpi:\t192$/m, "Chromium/Electron scale from Xft.dpi");
    const main = client.window(300, 200);
    const dialog = client.window(400, 300, { parent: main });
    await until(() => display.wm.count === 2);
    assert.deepEqual(await client.geometry(main), [0, 0, 2560, 1600], "a window fills the display");
    assert.deepEqual(await client.geometry(dialog), [1080, 650, 400, 300], "a dialog keeps its size, centered");
    const wide = client.window(100, 100, { min: [3000, 900] });
    await until(() => display.wm.size[0] === 3000);
    assert.deepEqual(await client.geometry(wide), [0, 0, 3000, 1600], "the screen grows instead of cutting it off");
    const frame = await captureFrame(display.socket);
    assert.deepEqual([frame.width, frame.height, frame.rgb.length], [3000, 1600, 3000 * 1600 * 3]);
    client.close();
    const dir = path.dirname(display.socket);
    host.stop("view");
    assert.equal(fs.existsSync(dir), false, "the display's cookie and socket are removed");
  } finally { host.stopAll(); }
});

/** A VNC server that completes the handshake as an 800×600 display and records what viewers send. */
async function fakeDisplay(socketPath: string) {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    let stage = 0;
    socket.write("RFB 003.008\n");
    socket.on("data", (data: Buffer) => {
      if (stage === 0) { stage = 1; socket.write(Buffer.from([1, 1])); }
      else if (stage === 1) { stage = 2; socket.write(Buffer.alloc(4)); }
      else if (stage === 2) {
        stage = 3;
        const init = Buffer.alloc(24); init.writeUInt16BE(800, 0); init.writeUInt16BE(600, 2);
        socket.write(init);
      } else received.push(data);
    });
  });
  server.listen(socketPath); await once(server, "listening");
  return { server, events: () => Buffer.concat(received) };
}

test("agents use a desktop app like a viewer does: clicks and key combos in screenshot pixels, then a picture of the result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-display-"));
  const vnc = await fakeDisplay(path.join(dir, "vnc.sock"));
  const live = new Set<string>();
  const terminals = { start: async () => { live.add("t"); return "t"; }, has: (id: string) => live.has(id), close: (id: string) => { live.delete(id); } };
  const displays: AppDisplayProvider = { unavailable: () => undefined, ensure: async () => ({ socket: path.join(dir, "vnc.sock"), env: {}, wm: { count: 1 } }), stop: () => {} };
  const shot = { viewId: "v", view: "Window", width: 800, theme: "native" as const, file: "/tmp/after.png" };
  const gateway = { open: () => "", share: () => ({ url: "", expiresAt: 0 }), revoke: () => {} };
  try {
    const service = new AppService(new AppRegistry(), gateway, terminals, { displays, screenshots: { enabled: () => true, take: async () => [shot] } });
    await assert.rejects(service.act("s", undefined, { kind: "click", x: 1, y: 1 }), /no desktop apps/);
    service.publish("s", dir, manifest);

    const result = await service.act("s", "editor", { kind: "click", x: 10, y: 20 });
    assert.deepEqual(result.shot, shot, "the agent sees what its click did");
    await service.act("s", undefined, { kind: "key", keys: "cmd+shift+s" });
    await until(() => vnc.events().length >= 18 + 6 * 8);
    const events = vnc.events();
    const pointers = [0, 6, 12].map((at) => [events[at], events[at + 1], events.readUInt16BE(at + 2), events.readUInt16BE(at + 4)]);
    assert.deepEqual(pointers, [[5, 0, 10, 20], [5, 1, 10, 20], [5, 0, 10, 20]], "move there, press, release");
    const keys = Array.from({ length: 6 }, (_, i) => [events[18 + i * 8 + 1], events.readUInt32BE(18 + i * 8 + 4)]);
    assert.deepEqual(keys, [[1, 0xffeb], [1, 0xffe1], [1, 0x53], [0, 0x53], [0, 0xffe1], [0, 0xffeb]], "modifiers held around a capital S");

    await assert.rejects(service.act("s", undefined, { kind: "click", x: 900, y: 10 }), /outside the app, which is 800×600/);
    await assert.rejects(service.act("s", undefined, { kind: "key", keys: "hyper+s" }), /Unknown modifier/);
  } finally { vnc.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the macOS helper serves a display the way noVNC reads it: resize handshake, zlib frames, and raw frames for screenshots", { skip: process.platform !== "darwin" && "needs macOS", timeout: 600_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-display-"));
  const host = new MacDisplayHost({ cacheDir: path.join(dir, "bin") });
  const socket = path.join(dir, "vnc.sock");
  const helper = spawn(await host.helper(), ["serve", socket, "token", "1"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const lines = createInterface({ input: helper.stdout! });
    await new Promise<void>((resolve) => lines.on("line", (line) => { if (line === "ready") resolve(); }));
    assert.equal((fs.statSync(socket).mode & 0o777), 0o600, "only this user can connect");

    const viewer = net.connect(socket);
    let buffer = Buffer.alloc(0);
    viewer.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); });
    const read = async (n: number) => { await until(() => buffer.length >= n); const out = buffer.subarray(0, n); buffer = buffer.subarray(n); return out; };
    assert.equal((await read(12)).toString(), "RFB 003.008\n");
    viewer.write("RFB 003.008\n");
    assert.deepEqual([...await read(2)], [1, 1], "no password: the socket is private");
    viewer.write(Buffer.from([1]));
    assert.equal((await read(4)).readUInt32BE(0), 0);
    viewer.write(Buffer.from([1]));
    const init = await read(24);
    const [width, height] = [init.readUInt16BE(0), init.readUInt16BE(2)];
    await read(init.readUInt32BE(20));
    // noVNC's pixel format (RGBX), encodings and first request.
    const format = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
    const encodings = Buffer.alloc(4 + 3 * 4); encodings[0] = 2; encodings.writeUInt16BE(3, 2);
    [6, -308, 0].forEach((e, i) => encodings.writeInt32BE(e, 4 + i * 4));
    const request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8);
    viewer.write(Buffer.concat([format, encodings, request]));

    const update = async () => {
      const head = await read(4);
      assert.equal(head[0], 0, "a framebuffer update");
      const rects: { x: number; y: number; w: number; h: number; encoding: number; data: Buffer }[] = [];
      for (let i = 0; i < head.readUInt16BE(2); i++) {
        const r = await read(12);
        const rect = { x: r.readUInt16BE(0), y: r.readUInt16BE(2), w: r.readUInt16BE(4), h: r.readUInt16BE(6), encoding: r.readInt32BE(8) };
        const data = rect.encoding === -308 ? await read(4 + 16) : rect.encoding === 6 ? await read((await read(4)).readUInt32BE(0)) : await read(rect.w * rect.h * 4);
        rects.push({ ...rect, data });
      }
      return rects;
    };
    const first = await update();
    assert.deepEqual([first[0]!.encoding, first[0]!.x, first[0]!.w, first[0]!.h], [-308, 0, width, height], "the size comes first, so noVNC offers resizing");
    const pixels = inflateSync(Buffer.concat(first.slice(1).map((rect) => rect.data)), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    assert.ok(first.slice(1).every((rect) => rect.encoding === 6), "zlib for a viewer that asks for it");
    assert.equal(pixels.length, first.slice(1).reduce((sum, rect) => sum + rect.w * rect.h * 4, 0), "the stream inflates to whole rectangles");

    const resize = Buffer.alloc(8 + 16); resize[0] = 251; resize.writeUInt16BE(390, 2); resize.writeUInt16BE(844, 4); resize[6] = 1;
    viewer.write(Buffer.concat([resize, Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1])]));
    const reply = await update();
    assert.deepEqual([reply[0]!.encoding, reply[0]!.x], [-308, 1], "the viewer's own resize request is answered");
    viewer.destroy();

    const frame = await captureFrame(socket);
    assert.deepEqual([frame.width, frame.height], [width, height], "screenshots read the same display, raw");
  } finally { helper.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
