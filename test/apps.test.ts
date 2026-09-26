// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { AppRegistry } from "../src/apps/registry.js";
import { TerminalManager } from "../src/terminal.js";
import { AppGateway, previewOriginTemplate } from "../src/apps/gateway.js";
import { AppService } from "../src/apps/service.js";
import { createAppCommands } from "../src/controllers/app-commands.js";
import { CommandRegistry } from "../src/protocol/command-registry.js";
import { CLIENT_COMMAND_SCHEMAS } from "../src/protocol/client-command-schemas.js";
import type { AppManifest } from "../packages/core/src/apps.js";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-apps-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>Preview</h1>");
  return dir;
}
const staticManifest: AppManifest = { version: 1, name: "My app", views: [{ kind: "web", name: "Website", source: { kind: "static", directory: "dist" } }] };
const terminalManifest: AppManifest = { version: 1, name: "CLI", views: [{ kind: "terminal", name: "REPL", command: "node", args: ["-i"] }] };
async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
function request(port: number, host: string, url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ agent: false, hostname: "127.0.0.1", port, path: url, method: options.method ?? "GET", headers: { host, ...options.headers } }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end(options.body);
  });
}
async function grant(gateway: AppGateway, port: number, id: string) {
  const launch = new URL(gateway.open(id));
  const url = new URL(gateway.origin(id) + "/__bivy/open" + launch.hash);
  const res = await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: url.hash.slice(1) });
  assert.equal(res.status, 204);
  return { url, cookie: res.headers["set-cookie"]![0].split(";")[0] };
}

test("app manifest supports independent web and terminal views; snapshots are immutable", () => {
  const dir = workspace();
  try {
    const registry = new AppRegistry([4317]);
    const app = registry.publish("session", dir, { ...staticManifest, views: [...staticManifest.views, ...terminalManifest.views] });
    assert.equal(app.views.length, 2);
    fs.writeFileSync(path.join(dir, "dist/index.html"), "changed");
    const entry = registry.getView(app.views[0].id)!;
    assert.equal(entry.target.kind === "static" && entry.target.files.get("/index.html")!.toString(), "<h1>Preview</h1>");
    assert.throws(() => registry.requireView("other", app.id, app.views[0].id), /not found/);
    app.views.length = 0;
    assert.equal(registry.list("session")[0].views.length, 2);
    assert.equal(registry.list("other").length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("publication validates version, view types, arguments, reserved ports and atomicity", () => {
  const dir = workspace();
  try {
    const registry = new AppRegistry([4317]);
    for (const invalid of [null, {}, { ...staticManifest, version: 2 }, { ...staticManifest, views: [] }, { ...staticManifest, views: [{ kind: "desktop", name: "Desktop" }] }, { ...staticManifest, views: [null] }, { ...terminalManifest, views: [{ kind: "terminal", name: "CLI", command: "node", args: [4] }] }]) {
      assert.throws(() => registry.publish("s", dir, invalid as AppManifest));
    }
    for (const port of [0, 22, 4317, 65536, 3000.5, "3000"]) {
      assert.throws(() => registry.publish("s", dir, { ...staticManifest, views: [...staticManifest.views, { kind: "web", name: "Server", source: { kind: "service", port: port as number } }] }));
    }
    assert.equal(registry.list("s").length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("apps survive a restart with their IDs, except services Bivy doesn't run", () => {
  const dir = workspace(); const file = path.join(dir, "apps.json");
  try {
    const registry = new AppRegistry([4317], file);
    const kept = registry.publish("s", dir, { version: 1, name: "Kept", views: [
      staticManifest.views[0], terminalManifest.views[0],
      { kind: "web", name: "Managed", source: { kind: "service", port: 3000, start: { command: "npm", args: ["run", "dev"] } } },
      { kind: "web", name: "External", source: { kind: "service", port: 3001 } },
    ] });
    const gone = registry.publish("s", dir, staticManifest);
    const external = registry.publish("s", dir, { version: 1, name: "Only external", views: [{ kind: "web", name: "External", source: { kind: "service", port: 3002 } }] });
    registry.remove("s", gone.id);
    fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>After restart</h1>");

    const restarted = new AppRegistry([4317], file);
    const apps = restarted.list("s");
    assert.deepEqual(apps.map((app) => app.id), [kept.id]);
    assert.deepEqual(apps[0].views.map((view) => [view.id, view.name]), kept.views.slice(0, 3).map((view) => [view.id, view.name]));
    assert.equal(apps[0].views[2].kind === "web" && apps[0].views[2].managed, true);
    const snapshot = restarted.getView(kept.views[0].id)!.target;
    assert.equal(snapshot.kind === "static" && snapshot.files.get("/index.html")!.toString(), "<h1>After restart</h1>");
    assert.throws(() => restarted.require("s", external.id), /not found/);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("managed servers start on first open, restart when they exit, and stop backing off a crash loop", async () => {
  const dir = workspace();
  let live = new Set<string>(); const started: string[] = []; const closed: string[] = [];
  const terminals = { start: async (spec: { command: string; name: string }) => { const id = `t${started.length}`; started.push(spec.command); live.add(id); return id; }, has: (id: string) => live.has(id), close: (id: string) => { closed.push(id); live.delete(id); } };
  const gateway = { open: () => "https://view-x.preview.example.net/__bivy/open#t", share: () => ({ url: "", expiresAt: 0 }), revoke: () => {} };
  const service = new AppService(new AppRegistry(), gateway, terminals, { scan: async () => [], serverWatchMs: 5 });
  const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
  try {
    const app = service.publish("s", dir, { version: 1, name: "Web", views: [{ kind: "web", name: "Site", source: { kind: "service", port: 3000, start: { command: "npm", args: ["run", "dev"] } } }] });
    assert.deepEqual(started, [], "publishing starts nothing");
    const viewId = app.views[0].id;
    await Promise.all([service.open("s", app.id, viewId), service.open("s", app.id, viewId)]);
    await until(() => started.length === 1);
    assert.deepEqual(await service.logs("s", app.id, viewId), { kind: "terminal", termId: "t0" });
    live.delete("t0"); // the server exits
    await until(() => started.length === 2);
    // A crash loop is left down after five restarts in the window…
    for (let i = 0; i < 10; i++) { live = new Set(); await new Promise((r) => setTimeout(r, 15)); }
    assert.equal(started.length, 6);
    // …until someone opens the view again.
    await service.open("s", app.id, viewId);
    await until(() => started.length === 7);
    service.remove("s", app.id);
    assert.ok(closed.includes("t6"));
    await assert.rejects(service.logs("s", app.id, viewId), /not found/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("static snapshots reject traversal, symlinks, oversized files and exclude hidden files", () => {
  const dir = workspace();
  try {
    fs.writeFileSync(path.join(dir, "dist/.env"), "SECRET");
    const registry = new AppRegistry();
    const app = registry.publish("s", dir, staticManifest);
    const target = registry.getView(app.views[0].id)!.target;
    assert.equal(target.kind === "static" && target.files.has("/.env"), false);
    assert.throws(() => registry.publish("s", dir, { ...staticManifest, views: [{ kind: "web", name: "Escape", source: { kind: "static", directory: ".." } }] }), /inside/);
    fs.symlinkSync("/etc/passwd", path.join(dir, "dist/leak"));
    assert.throws(() => registry.publish("s", dir, staticManifest), /symlinks/);
    fs.unlinkSync(path.join(dir, "dist/leak"));
    fs.writeFileSync(path.join(dir, "dist/large"), "");
    fs.truncateSync(path.join(dir, "dist/large"), 26 * 1024 * 1024);
    assert.throws(() => registry.publish("s", dir, staticManifest), /25 MiB/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("terminal starts only on open, single-flights retries, restarts exited programs, and closes on remove", async () => {
  const dir = workspace();
  try {
    const registry = new AppRegistry(); let starts = 0; const live = new Set<string>();
    const service = new AppService(registry, undefined, {
      start: async () => { const id = `term-${++starts}`; await new Promise((r) => setTimeout(r, 5)); live.add(id); return id; },
      has: (id) => live.has(id), close: (id) => { live.delete(id); },
    });
    const app = service.publish("s", dir, terminalManifest); const view = app.views[0].id;
    assert.equal(starts, 0);
    const results = await Promise.all(Array.from({ length: 5 }, () => service.open("s", app.id, view)));
    assert.equal(starts, 1); assert.deepEqual(results[0], { kind: "terminal", termId: "term-1" });
    live.clear();
    await Promise.all(Array.from({ length: 5 }, () => service.open("s", app.id, view)));
    assert.equal(starts, 2);
    service.remove("s", app.id); await Promise.resolve(); assert.equal(live.size, 0);
    await assert.rejects(() => service.open("s", app.id, view), /not found/);
    const web = service.publish("s", dir, staticManifest);
    await assert.rejects(() => service.open("s", web.id, web.views[0].id), /preview service is unavailable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("removing an app during terminal startup does not orphan its process", async () => {
  const dir = workspace();
  try {
    let finish!: (id: string) => void; const closed: string[] = [];
    const service = new AppService(new AppRegistry(), undefined, { start: () => new Promise((r) => { finish = r; }), has: () => true, close: (id) => { closed.push(id); } });
    const app = service.publish("s", dir, terminalManifest);
    const opening = service.open("s", app.id, app.views[0].id);
    service.remove("s", app.id); finish("late");
    await assert.rejects(opening, /removed/); assert.ok(closed.includes("late"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("terminal provider runs a real interactive PTY through the existing manager", async () => {
  const dir = workspace(); const terminals = new TerminalManager();
  try {
    let output = "";
    let received!: () => void;
    const response = new Promise<void>((resolve) => { received = resolve; });
    const service = new AppService(new AppRegistry(), undefined, {
      start: async (spec) => terminals.open({ workspace: spec.workspace, command: spec.command, args: spec.args,
        onData: (data) => { output += data; if (output.includes("APP_REPLY")) received(); }, onExit: () => {} }),
      has: (id) => terminals.has(id), close: (id) => { terminals.close(id); },
    });
    const app = service.publish("s", dir, { version: 1, name: "Echo CLI", views: [{ kind: "terminal", name: "CLI", command: process.execPath, args: ["-e", "process.stdin.on('data', () => process.stdout.write('APP_REPLY\\n'))"] }] });
    const opened = await service.open("s", app.id, app.views[0].id);
    assert.equal(opened.kind, "terminal");
    if (opened.kind !== "terminal") return;
    terminals.write(opened.termId, "hello\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PTY did not reply")), 10_000); })]); }
    finally { clearTimeout(timer); }
    service.remove("s", app.id); await Promise.resolve();
    assert.equal(terminals.has(opened.termId), false);
  } finally { terminals.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("app commands validate both transport inputs and session/view ownership", async () => {
  const dir = workspace();
  try {
    const service = new AppService(new AppRegistry(), undefined, { start: async () => "term", has: () => true, close: () => {} });
    const commands = new CommandRegistry(createAppCommands(service, (id) => id === "s" ? dir : undefined), CLIENT_COMMAND_SCHEMAS);
    const replies: any[] = []; const broadcasts: any[] = [];
    const ctx = { reply: (event: unknown) => replies.push(event), broadcast: (event: unknown) => broadcasts.push(event) };
    await commands.dispatch("apps.publish", { kind: "apps.publish", requestId: "p", sessionId: "s", manifest: terminalManifest }, ctx);
    assert.equal(replies[0].type, "apps.publish.ok"); assert.equal(replies[0].requestId, "p");
    assert.equal(broadcasts[0].type, "apps.changed");
    const app = replies[0].app;
    await commands.dispatch("apps.open", { kind: "apps.open", sessionId: "other", appId: app.id, viewId: app.views[0].id }, ctx);
    assert.equal(replies.at(-1).type, "apps.open.error");
    await commands.dispatch("apps.open", { kind: "apps.open", sessionId: "s", appId: app.id }, ctx);
    assert.equal(replies.at(-1).type, "apps.open.error");
    for (const kind of ["apps.share", "apps.revoke"]) {
      await commands.dispatch(kind, { kind, sessionId: "other", appId: app.id, viewId: app.views[0].id }, ctx);
      assert.equal(replies.at(-1).type, `${kind}.error`);
    }
    // Terminal views have no preview link to hand out.
    await commands.dispatch("apps.share", { kind: "apps.share", sessionId: "s", appId: app.id, viewId: app.views[0].id }, ctx);
    assert.match(replies.at(-1).error, /Only web views/);
    await commands.dispatch("apps.list", { kind: "apps.list", sessionId: "s" }, ctx);
    assert.equal(replies.at(-1).apps.length, 1);
    await commands.dispatch("apps.remove", { kind: "apps.remove", sessionId: "s", appId: app.id }, ctx);
    assert.equal(replies.at(-1).type, "apps.remove.ok"); assert.equal(service.list("s").apps.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bivy app share picks a web view by app and view ID or name, like present", async () => {
  const dir = workspace();
  try {
    const shared: string[] = [];
    const gateway = { open: () => "", share: (id: string) => { shared.push(id); return { url: `https://${id}.preview.example.net/__bivy/open#grant`, expiresAt: 42 }; }, revoke: () => {} };
    const service = new AppService(new AppRegistry(), gateway, { start: async () => "term", has: () => true, close: () => {} });
    const commands = new CommandRegistry(createAppCommands(service, (id) => id === "s" ? dir : undefined), CLIENT_COMMAND_SCHEMAS);
    const replies: any[] = [];
    const ctx = { reply: (event: unknown) => replies.push(event), broadcast: () => {} };
    const share = async (fields: Record<string, string>) => { await commands.dispatch("apps.share", { kind: "apps.share", sessionId: "s", ...fields }, ctx); return replies.at(-1); };

    assert.match((await share({})).error, /no web views/);
    const shop = service.publish("s", dir, { version: 1, name: "Shop", views: [{ kind: "web", name: "Storefront", source: { kind: "static", directory: "./dist" } }, { kind: "web", name: "Admin", source: { kind: "static", directory: "./dist" } }, { kind: "terminal", name: "Console", command: "sh" }] });
    const docs = service.publish("s", dir, { version: 1, name: "Docs", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "./dist" } }] });
    const [storefront, admin] = shop.views;
    await service.open("s", docs.id, docs.views[0].id);

    // Default: the view opened last, with names alongside the link.
    const newest = await share({});
    assert.equal(newest.type, "apps.share.ok");
    assert.deepEqual({ url: newest.url, expiresAt: newest.expiresAt, app: newest.app, view: newest.view, viewId: newest.viewId }, { url: `https://${docs.views[0].id}.preview.example.net/__bivy/open#grant`, expiresAt: 42, app: "Docs", view: "Site", viewId: docs.views[0].id });
    // App by name or ID; --view by name (any case) or ID, within that app.
    assert.equal((await share({ appId: "shop" })).viewId, storefront.id);
    assert.equal((await share({ appId: shop.id, view: "ADMIN" })).viewId, admin.id);
    assert.equal((await share({ view: admin.id })).viewId, admin.id);
    assert.match((await share({ appId: "Docs", view: "Admin" })).error, /No web view called "Admin" in "Docs"/);
    assert.match((await share({ appId: "Nope", view: "Site" })).error, /No app called "Nope"/);
    // Terminal views have no preview link, whether picked by name or ID.
    assert.match((await share({ appId: "Shop", view: "Console" })).error, /No web view called "Console"/);
    assert.match((await share({ appId: shop.id, viewId: shop.views[2].id })).error, /Only web views/);
    // The app UI's exact-ID form is unchanged.
    assert.equal((await share({ appId: shop.id, viewId: admin.id })).url, `https://${admin.id}.preview.example.net/__bivy/open#grant`);
    // Another session's apps are never reachable by name.
    await commands.dispatch("apps.share", { kind: "apps.share", sessionId: "other", appId: "Shop" }, ctx);
    assert.equal(replies.at(-1).type, "apps.share.error");
    assert.deepEqual(shared, [docs.views[0].id, storefront.id, admin.id, admin.id, admin.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("preview origins require dedicated HTTPS per-view hosts", () => {
  assert.equal(previewOriginTemplate("https://{app}.preview.example.net/"), "https://{app}.preview.example.net");
  for (const url of ["http://{app}.example.net", "https://example.net/{app}", "https://{app}.example.net/path", "https://{app}.example.net:443", "https://{app}.example.net?x=1"]) assert.throws(() => previewOriginTemplate(url));
});

test("gateway authenticates one-use grants, confines them to a view, serves snapshots and revokes", async () => {
  const dir = workspace(); const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const port = await listen(gateway.server);
  try {
    const app = registry.publish("s", dir, staticManifest); const id = app.views[0].id;
    const url = new URL(gateway.origin(id) + "/__bivy/open" + new URL(gateway.open(id)).hash);
    assert.equal(url.search, "");
    assert.equal((await request(port, url.host, "/")).status, 401);
    assert.equal((await request(port, "evil.example.net", "/")).status, 404);
    const bootstrap = await request(port, url.host, "/__bivy/open");
    assert.equal(bootstrap.status, 200); assert.ok(!bootstrap.body.includes(url.hash.slice(1)));
    assert.equal((await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: "https://evil.net" }, body: url.hash.slice(1) })).status, 403);
    const redeem = await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: url.hash.slice(1) });
    assert.equal(redeem.status, 204);
    assert.match(redeem.headers["set-cookie"]![0], /Secure; HttpOnly; SameSite=Lax; Path=\//);
    assert.equal((await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: url.hash.slice(1) })).status, 401);
    const cookie = redeem.headers["set-cookie"]![0].split(";")[0];
    const response = await request(port, url.host, "/", { headers: { cookie } });
    assert.equal(response.body, "<h1>Preview</h1>"); assert.match(String(response.headers["content-type"]), /text\/html/);
    assert.match(String(response.headers["content-security-policy"]), /worker-src 'none'/);
    assert.equal((await request(port, url.host, "/", { method: "HEAD", headers: { cookie } })).body, "");
    assert.equal((await request(port, url.host, "/%2e%2e/etc/passwd", { headers: { cookie } })).status, 404);
    assert.equal((await request(port, url.host, "/", { method: "POST", headers: { cookie, origin: "https://evil.net" } })).status, 403);
    const other = registry.publish("s", dir, staticManifest);
    assert.equal((await request(port, new URL(gateway.origin(other.views[0].id)).host, "/", { headers: { cookie } })).status, 401);
    gateway.revoke(id);
    assert.equal((await request(port, url.host, "/", { headers: { cookie } })).status, 401);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("preview grants and browser sessions expire; unavailable services return an actionable error", async (t) => {
  const registry = new AppRegistry(); const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const dir = workspace(); const port = await listen(gateway.server);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  try {
    const app = registry.publish("s", dir, staticManifest); const id = app.views[0].id;
    const url = new URL(gateway.origin(id) + "/__bivy/open" + new URL(gateway.open(id)).hash);
    now += 60_001;
    assert.equal((await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: url.hash.slice(1) })).status, 401);
    const { cookie } = await grant(gateway, port, id);
    now += 3_600_001;
    assert.equal((await request(port, url.host, "/", { headers: { cookie } })).status, 401);
    // Acquire an ephemeral port and close it: no dependency on a fixed dev port.
    const unused = http.createServer(); const deadPort = await listen(unused); await new Promise<void>((resolve) => unused.close(() => resolve()));
    const service = registry.publish("s", dir, { ...staticManifest, views: [{ kind: "web", name: "Stopped", source: { kind: "service", port: deadPort } }] });
    const access = await grant(gateway, port, service.views[0].id);
    const response = await request(port, access.url.host, "/", { headers: { cookie: access.cookie } });
    assert.equal(response.status, 502); assert.match(response.body, /Start it on the registered port/);
    // A page load gets a self-recovering page instead of a blank frame; its
    // marker is what recovery polling watches, so a restarted server clears it.
    const page = await request(port, access.url.host, "/", { headers: { cookie: access.cookie, "sec-fetch-dest": "iframe" } });
    assert.equal(page.status, 502); assert.match(page.body, new RegExp(`Nothing is answering on port ${deadPort}`));
    assert.ok(page.headers["x-bivy-upstream-down"]);
    assert.match(String(page.headers["content-security-policy"]), new RegExp(`frame-ancestors ${gateway.shellOrigin(service.views[0].id)};`));
    const restarted = http.createServer((_req, res) => res.end("back")); restarted.listen(deadPort, "127.0.0.1"); await once(restarted, "listening");
    try {
      const probe = await request(port, access.url.host, "/", { method: "HEAD", headers: { cookie: access.cookie } });
      assert.equal(probe.status, 200); assert.equal(probe.headers["x-bivy-upstream-down"], undefined);
    } finally { restarted.close(); }
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a turn that changes files re-takes static snapshots and wakes the shell's revision poll", async () => {
  const registry = new AppRegistry(); const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const dir = workspace(); const port = await listen(gateway.server);
  try {
    const id = registry.publish("s", dir, staticManifest).views[0].id;
    const { url, cookie } = await grant(gateway, port, id);
    const shell = gateway.shellOrigin(id);
    const poll = request(port, url.host, "/__bivy/revision?after=0", { headers: { cookie } });
    // A turn that leaves the output unchanged doesn't reload anyone.
    assert.deepEqual(registry.touch("s"), []);
    fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>Rebuilt</h1>");
    assert.deepEqual(registry.touch("other"), []);
    assert.deepEqual(registry.touch("s"), [id]);
    const woke = await poll;
    assert.equal(woke.status, 200); assert.equal(woke.headers["access-control-allow-origin"], shell);
    assert.deepEqual(JSON.parse(woke.body), { revision: 1, path: "/" });
    assert.equal((await request(port, url.host, "/", { headers: { cookie } })).body, "<h1>Rebuilt</h1>");
    // A broken build keeps serving the last good snapshot.
    fs.rmSync(path.join(dir, "dist/index.html"));
    assert.deepEqual(registry.touch("s"), []);
    assert.equal((await request(port, url.host, "/", { headers: { cookie } })).body, "<h1>Rebuilt</h1>");
    assert.equal((await request(port, url.host, "/__bivy/revision?after=0")).status, 401);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("static page loads fall back for client-side routes; assets still 404", async () => {
  const registry = new AppRegistry(); const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const dir = workspace(); const port = await listen(gateway.server);
  try {
    const id = registry.publish("s", dir, staticManifest).views[0].id;
    const { url, cookie } = await grant(gateway, port, id);
    const page = { cookie, "sec-fetch-dest": "iframe" };
    // Page loads also carry the injected inspector, ahead of the app's markup.
    assert.equal((await request(port, url.host, "/invoices/42", { headers: page })).body, '<script src="/__bivy/inspector.js"></script><h1>Preview</h1>');
    assert.equal((await request(port, url.host, "/invoices/42", { headers: { cookie, accept: "text/html" } })).status, 200);
    assert.equal((await request(port, url.host, "/app.js", { headers: page })).status, 404);
    assert.equal((await request(port, url.host, "/invoices/42", { headers: { cookie, "sec-fetch-dest": "empty" } })).status, 404);
    fs.writeFileSync(path.join(dir, "dist/404.html"), "<h1>Not here</h1>");
    const withNotFound = registry.publish("s", dir, staticManifest).views[0].id;
    const second = await grant(gateway, port, withNotFound);
    const missing = await request(port, second.url.host, "/nope", { headers: { cookie: second.cookie, "sec-fetch-dest": "document" } });
    assert.equal(missing.status, 404); assert.match(missing.body, /<h1>Not here<\/h1>$/);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a view's stable address sends signed-out visits through Bivy and back to the same page", async () => {
  const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net", () => ["https://bivy.example"], (view, page) => `https://bivy.example/sessions/${view.app.sessionId}#preview=${view.app.id}.${view.view.id}.${encodeURIComponent(page)}`);
  const dir = workspace(); const port = await listen(gateway.server);
  try {
    const app = registry.publish("s", dir, staticManifest); const id = app.views[0].id;
    const host = new URL(gateway.origin(id)).host;
    assert.equal(gateway.address(id), `${gateway.origin(id)}/`);
    const visit = await request(port, host, "/invoices?q=1", { headers: { "sec-fetch-dest": "document" } });
    assert.equal(visit.status, 303);
    assert.equal(visit.headers.location, `https://bivy.example/sessions/s#preview=${app.id}.${id}.${encodeURIComponent("/invoices?q=1")}`);
    // Framed and non-page requests still just say access expired.
    assert.equal((await request(port, host, "/", { headers: { "sec-fetch-dest": "iframe" } })).status, 401);
    assert.equal((await request(port, host, "/app.js")).status, 401);
    // The signed-in client's direct link is one-use and lands on the app origin itself.
    const direct = new URL(gateway.openDirect(id));
    assert.equal(direct.origin, gateway.origin(id));
    const redeem = () => request(port, host, "/__bivy/redeem", { method: "POST", headers: { origin: direct.origin }, body: direct.hash.slice(1) });
    assert.equal((await redeem()).status, 204);
    assert.equal((await redeem()).status, 401);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("people with a shared link can leave bounded notes that come back to the session", async () => {
  const registry = new AppRegistry(); const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const dir = workspace(); const port = await listen(gateway.server);
  const service = new AppService(registry, gateway, { start: async () => "t", has: () => true, close: () => {} });
  try {
    const app = registry.publish("s", dir, staticManifest); const id = app.views[0].id;
    const shared = new URL(gateway.share(id).url);
    const host = shared.host;
    const redeemed = await request(port, host, "/__bivy/redeem", { method: "POST", headers: { origin: shared.origin }, body: shared.hash.slice(1) });
    const reviewer = redeemed.headers["set-cookie"]![0].split(";")[0];
    const owner = (await grant(gateway, port, id)).cookie;
    // Only a shared-link session gets the reviewer tools.
    assert.match((await request(port, host, "/__bivy/inspector.js", { headers: { cookie: reviewer } })).body, /REVIEWER=true/);
    assert.match((await request(port, host, "/__bivy/inspector.js", { headers: { cookie: owner } })).body, /REVIEWER=false/);
    const post = (body: string, headers: Record<string, string> = {}) => request(port, host, "/__bivy/notes", { method: "POST", headers: { cookie: reviewer, origin: shared.origin, ...headers }, body });
    assert.equal((await post(JSON.stringify({ note: "Make this bigger", selector: "h1", text: "Preview", path: "/", viewport: { width: 390, height: 844 } }))).status, 204);
    assert.equal((await post(JSON.stringify({ note: "x" }), { origin: "https://evil.example" })).status, 403);
    assert.equal((await request(port, host, "/__bivy/notes", { method: "POST", headers: { origin: shared.origin }, body: JSON.stringify({ note: "x" }) })).status, 401);
    assert.equal((await post(JSON.stringify({ note: "  " }))).status, 400);
    assert.equal((await post(JSON.stringify({ note: "x".repeat(5000) }))).status, 413);
    for (let i = 0; i < 60; i++) await post(JSON.stringify({ note: `n${i}`, path: "javascript:alert(1)" }));
    const notes = service.list("s").apps[0].views[0].kind === "web" ? service.list("s").apps[0].views[0].notes! : [];
    assert.equal(notes.length, 50);
    assert.equal(notes.at(-1)!.note, "n59"); assert.equal(notes.at(-1)!.path, "/");
    service.clearNotes("s", app.id, id);
    assert.equal(service.list("s").apps[0].views[0].kind === "web" && service.list("s").apps[0].views[0].notes, undefined);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("copied links open the app unframed, are reusable until revoked and lapse after a day", async (t) => {
  const registry = new AppRegistry(); const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const dir = workspace(); const port = await listen(gateway.server);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  try {
    const app = registry.publish("s", dir, staticManifest); const id = app.views[0].id;
    const shared = gateway.share(id);
    const url = new URL(shared.url);
    assert.equal(url.origin, gateway.origin(id)); assert.equal(url.pathname, "/__bivy/open"); assert.equal(url.search, "");
    assert.equal(shared.expiresAt, now + 24 * 3_600_000);
    const redeem = () => request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: url.hash.slice(1) });
    const first = await redeem(); const second = await redeem();
    assert.equal(first.status, 204); assert.equal(second.status, 204);
    assert.match(first.headers["set-cookie"]![0], /Max-Age=3600/);
    const cookie = second.headers["set-cookie"]![0].split(";")[0];
    assert.equal((await request(port, url.host, "/", { headers: { cookie } })).body, "<h1>Preview</h1>");
    // Near the cap, the browser session ends with the link rather than an hour later.
    now += 24 * 3_600_000 - 60_000;
    const late = await redeem();
    assert.match(late.headers["set-cookie"]![0], /Max-Age=60;?/);
    now += 60_001;
    assert.equal((await redeem()).status, 401);
    const fresh = new URL(gateway.share(id).url);
    const again = await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: fresh.hash.slice(1) });
    const freshCookie = again.headers["set-cookie"]![0].split(";")[0];
    gateway.revoke(id);
    assert.equal((await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: fresh.hash.slice(1) })).status, 401);
    assert.equal((await request(port, url.host, "/", { headers: { cookie: freshCookie } })).status, 401);
    // Revoke ends existing access only; a newly copied link works again.
    assert.equal((await request(port, url.host, "/__bivy/redeem", { method: "POST", headers: { origin: url.origin }, body: new URL(gateway.share(id).url).hash.slice(1) })).status, 204);
    assert.throws(() => gateway.share("0".repeat(32)), /not found/);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the trusted shell only accepts scoped launch grants and configured chat return origins", async () => {
  const dir = workspace(); const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net", () => ["https://bivy.example", "http://localhost:5173"]);
  const port = await listen(gateway.server);
  try {
    const app = registry.publish("s", dir, staticManifest); const id = app.views[0].id;
    for (const returnTo of ["javascript:alert(1)", "https://evil.example/sessions/s", "https://bivy.example/sessions/other", "https://bivy.example/sessions/s?token=secret", "https://user:secret@bivy.example/sessions/s"]) assert.throws(() => gateway.open(id, returnTo));
    const launch = new URL(gateway.open(id, "https://bivy.example/sessions/s"));
    assert.equal(launch.origin, gateway.shellOrigin(id));
    const shell = await request(port, launch.host, "/__bivy/open");
    assert.match(shell.body, /Back to chat/); assert.match(shell.body, /sandbox=/);
    // Only configured Bivy clients may frame the shell (Peek).
    assert.match(String(shell.headers["content-security-policy"]), /frame-ancestors https:\/\/bivy\.example http:\/\/localhost:5173;/);
    assert.equal((await request(port, launch.host, "/index.html")).status, 404);
    assert.equal((await request(port, launch.host, "/__bivy/launch", { method: "POST", headers: { origin: gateway.origin(id) }, body: launch.hash.slice(1) })).status, 403);
    const response = await request(port, launch.host, "/__bivy/launch", { method: "POST", headers: { origin: launch.origin }, body: launch.hash.slice(1) });
    assert.deepEqual(JSON.parse(response.body), { name: app.name, origin: gateway.origin(id), returnTo: "https://bivy.example/sessions/s" });
    gateway.revoke(id);
    assert.equal((await request(port, launch.host, "/__bivy/launch", { method: "POST", headers: { origin: launch.origin }, body: launch.hash.slice(1) })).status, 401);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("gateway proxies HTTP bodies, cookies, external host and WebSockets without leaking its credential", async () => {
  let headers: http.IncomingHttpHeaders = {};
  const backend = http.createServer((req, res) => {
    headers = req.headers;
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      // This fixture tests byte forwarding, never HTML rendering. Reflected
      // request data must remain inert even when it contains HTML markup.
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'");
      res.setHeader("set-cookie", ["session=abc; Domain=example.net; Path=/", "__Host-bivy-preview=attack; Path=/; Secure"]);
      res.end(`${req.url}:${body}`);
    });
  });
  const wsServer = new WebSocketServer({ server: backend });
  wsServer.on("connection", (ws, req) => { headers = req.headers; ws.on("message", (data) => ws.send(data)); });
  const backendPort = await listen(backend);
  const registry = new AppRegistry(); const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  const port = await listen(gateway.server);
  try {
    const app = registry.publish("s", process.cwd(), { ...staticManifest, views: [{ kind: "web", name: "Server", source: { kind: "service", port: backendPort } }] });
    const id = app.views[0].id; const { url, cookie } = await grant(gateway, port, id);
    const response = await request(port, url.host, "/invoices?q=1", { method: "POST", headers: { cookie: `${cookie}; user=ok`, origin: url.origin, "content-type": "application/json", "x-forwarded-host": "evil.net" }, body: '{"value":2}' });
    assert.equal(response.body, '/invoices?q=1:{"value":2}');
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(headers.host, url.host); assert.equal(headers["x-forwarded-host"], url.host);
    assert.equal(headers.cookie?.trim(), "user=ok");
    assert.deepEqual(response.headers["set-cookie"], ["session=abc; Path=/"]);
    assert.equal(response.headers["x-frame-options"], undefined);
    assert.match(String(response.headers["content-security-policy"]), /default-src 'self'/);
    assert.ok(String(response.headers["content-security-policy"]).includes(`frame-ancestors ${gateway.shellOrigin(id)}`));
    assert.ok(!String(response.headers["content-security-policy"]).includes("frame-ancestors 'none'"));
    const markup = "<script>alert('fixture')</script>";
    const reflected = await request(backendPort, "127.0.0.1", "/echo", { method: "POST", body: markup });
    assert.equal(reflected.body, `/echo:${markup}`);
    assert.equal(reflected.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(reflected.headers["x-content-type-options"], "nosniff");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { origin: url.origin, headers: { host: url.host, cookie } });
    await once(ws, "open");
    ws.send("hello"); const [data] = await once(ws, "message"); assert.equal(data.toString(), "hello");
    assert.equal(headers.cookie, "");
    const closed = once(ws, "close"); gateway.revoke(id); await closed;
  } finally { gateway.close(); wsServer.close(); backend.close(); backend.closeAllConnections(); }
});
