// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { AppRegistry } from "../src/apps/registry.js";
import { AppGateway } from "../src/apps/gateway.js";
import { AppService } from "../src/apps/service.js";
import { loadScenarios, matchRule, planScenario, summarize } from "../src/apps/scenarios.js";

function project(files: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-scenarios-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>Shop</h1>");
  fs.mkdirSync(path.join(dir, ".bivy/scenarios"), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, ".bivy/scenarios", name), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
}
const shop = { version: 1 as const, name: "Shop", views: [{ kind: "web" as const, name: "Storefront", source: { kind: "static" as const, directory: "dist" } }] };
const cart = { name: "Cart with 3 items", open: "/cart", steps: [{ click: "text=Add" }], network: [{ match: "/api/*", delayMs: 500 }] };
const down = { name: "Payment API down", from: "cart", open: "/checkout", fresh: true, steps: [{ fill: "#email", with: "a@b.c" }], network: [{ match: "POST /api/payments*", status: 503, json: { error: "down" } }] };

function request(port: number, host: string, url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ agent: false, hostname: "127.0.0.1", port, path: url, method: options.method ?? "GET", headers: { host, ...options.headers } }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject); req.end(options.body);
  });
}

test("a scenario starts from another: the base's page and steps come first, and its own network rules win", () => {
  const dir = project({ "cart.json": cart, "checkout-api-down.json": down });
  try {
    const { scenarios, problems } = loadScenarios(dir);
    assert.deepEqual(problems, []);
    const plan = planScenario(scenarios, "checkout-api-down");
    assert.deepEqual(plan.stages, [{ open: "/cart", steps: [{ click: "text=Add" }] }, { open: "/checkout", steps: [{ fill: "#email", with: "a@b.c" }] }]);
    assert.equal(plan.fresh, true);
    assert.equal(plan.simulated, "POST /api/payments* → 503 (+1 more)");
    assert.equal(matchRule(plan.network, "POST", "/api/payments/intent?x=1")?.status, 503);
    assert.equal(matchRule(plan.network, "GET", "/api/payments")?.delayMs, 500);
    assert.equal(matchRule(plan.network, "GET", "/cart"), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a scenario file that can't be opened is reported with what's wrong, and the others still load", () => {
  const dir = project({
    "cart.json": cart,
    "broken.json": "{ not json",
    "Bad Name.json": cart,
    "typo.json": { name: "Typo", step: [] },
    "loop-a.json": { name: "A", from: "loop-b" },
    "loop-b.json": { name: "B", from: "loop-a" },
    "orphan.json": { name: "Orphan", from: "missing" },
  });
  try {
    const { scenarios, problems } = loadScenarios(dir);
    assert.deepEqual(scenarios.map((item) => item.id).sort(), ["cart", "loop-a", "loop-b", "orphan"]);
    const rows = Object.fromEntries(summarize(scenarios, problems, 0).map((row) => [row.id, row.error]));
    assert.equal(rows.cart, undefined);
    assert.match(rows.broken!, /Not valid JSON/);
    assert.match(rows["Bad Name"]!, /lowercase letters, digits and dashes/);
    assert.match(rows.typo!, /Unknown field "step"/);
    assert.match(rows["loop-a"]!, /starts from itself/);
    assert.match(rows.orphan!, /starts from "missing", which doesn't exist/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only the shell chooses a browser's scenario, and its simulated responses reach that browser alone", async () => {
  const dir = project({ "cart.json": cart, "checkout-api-down.json": down });
  const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net");
  gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
  const port = (gateway.server.address() as { port: number }).port;
  try {
    const id = registry.publish("s", dir, shop).views[0].id;
    const host = new URL(gateway.origin(id)).host;
    const browser = async () => {
      const res = await request(port, host, "/__bivy/redeem", { method: "POST", headers: { origin: gateway.origin(id) }, body: new URL(gateway.open(id)).hash.slice(1) });
      return res.headers["set-cookie"]![0].split(";")[0];
    };
    const mine = await browser(), theirs = await browser();
    const choose = (cookie: string, scenario: string, origin = gateway.shellOrigin(id)) => request(port, host, "/__bivy/scenario", { method: "POST", headers: { cookie: `${cookie}; cart=3`, origin, "content-type": "text/plain" }, body: scenario });
    const pay = (cookie: string) => request(port, host, "/api/payments", { method: "POST", headers: { cookie, origin: gateway.origin(id) } });

    assert.equal((await choose(mine, "checkout-api-down", gateway.origin(id))).status, 403);
    assert.equal((await choose(mine, "nope")).status, 400);
    const entered = await choose(mine, "checkout-api-down");
    assert.equal(entered.status, 200);
    assert.equal(JSON.parse(entered.body).plan.stages.length, 2);
    // A fresh scenario starts as a new visitor: the app's cookies go, the preview's stays.
    assert.deepEqual(entered.headers["set-cookie"], ["cart=; Path=/; Max-Age=0"]);

    const simulated = await pay(mine);
    assert.equal(simulated.status, 503);
    assert.deepEqual(JSON.parse(simulated.body), { error: "down" });
    assert.equal(simulated.headers["x-bivy-simulated"], "1");
    assert.equal((await pay(theirs)).status, 405);
    const listed = JSON.parse((await request(port, host, "/__bivy/scenarios", { headers: { cookie: mine } })).body);
    assert.equal(listed.active.id, "checkout-api-down");
    assert.deepEqual(listed.scenarios.map((row: { id: string }) => row.id), ["cart", "checkout-api-down"]);

    assert.equal((await choose(mine, "")).status, 200);
    assert.equal((await pay(mine)).status, 405);
  } finally { gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a review card offers only scenarios that open, and a chip opens the preview in one", async () => {
  const dir = project({ "cart.json": cart, "broken.json": "{" });
  const registry = new AppRegistry();
  const service = new AppService(registry, { open: (id) => `https://view-${id}.preview.example.net/__bivy/open#t`, share: () => { throw new Error(); }, revoke: () => {} }, { start: async () => "t", has: () => false, close: () => {} });
  try {
    const app = registry.publish("s", dir, shop);
    const { review } = await service.present("s", { try: ["cart.json"] });
    assert.deepEqual(review?.try, [{ id: "cart", name: "Cart with 3 items" }]);
    await assert.rejects(service.present("s", { try: ["nope"] }), /No scenario "nope" for Storefront\. Its scenarios: cart, broken\./);
    await assert.rejects(service.present("s", { try: ["broken"] }), /can't be opened: Not valid JSON/);
    const opened = await service.open("s", app.id, app.views[0].id, undefined, false, undefined, undefined, "cart");
    assert.equal(opened.kind === "web" && opened.url, `https://view-${app.views[0].id}.preview.example.net/__bivy/open#t~~cart`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A VNC server that completes the handshake as an 800×600 display and records what the app is sent. */
async function fakeDisplay(socketPath: string) {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    let stage = 0;
    socket.write("RFB 003.008\n");
    socket.on("data", (data: Buffer) => {
      if (stage === 0) { stage = 1; socket.write(Buffer.from([1, 1])); }
      else if (stage === 1) { stage = 2; socket.write(Buffer.alloc(4)); }
      else if (stage === 2) { stage = 3; const init = Buffer.alloc(24); init.writeUInt16BE(800, 0); init.writeUInt16BE(600, 2); socket.write(init); }
      else received.push(data);
    });
  });
  server.listen(socketPath); await once(server, "listening");
  return { server, events: () => Buffer.concat(received) };
}

test("a desktop app opens in a scenario: restarted with its arguments and environment, its API behind the rules, then the steps in its window", async () => {
  const api = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ real: req.url })); });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const target = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const dir = project({
    "offline.json": { name: "Payments down", args: ["--demo"], env: { THEME: "dark" }, api: { env: "API_URL", target }, steps: [{ click: [10, 20] }, { press: "ctrl+s" }], network: [{ match: "POST /payments", status: 503, json: { error: "down" } }] },
    "lost.json": { name: "Lost", steps: [{ click: [900, 10] }] },
    "web-only.json": { name: "Web", open: "/", steps: [{ click: "text=Pay" }] },
    "mixed.json": { name: "Mixed", open: "/", args: ["--x"] },
    "no-api.json": { name: "No API", args: [], network: [{ match: "/x", status: 500 }] },
  });
  const vnc = await fakeDisplay(path.join(dir, "vnc.sock"));
  const live = new Set<string>(); const started: { args: string[]; env?: Record<string, string> }[] = [];
  const terminals = { start: async (spec: { args: string[]; env?: Record<string, string> }) => { started.push(spec); live.add(`t${started.length}`); return `t${started.length}`; }, has: (id: string) => live.has(id), close: (id: string) => { live.delete(id); } };
  const displays = { unavailable: () => undefined, ensure: async () => ({ socket: path.join(dir, "vnc.sock"), env: { DISPLAY: ":9" }, wm: { count: 1 } }), stop: () => {} };
  const registry = new AppRegistry();
  const service = new AppService(registry, { open: () => "", share: () => { throw new Error(); }, revoke: () => {} }, terminals, { displays });
  try {
    const app = service.publish("s", dir, { version: 1, name: "Till", views: [{ kind: "display", name: "Window", command: "till", args: ["--fast"] }] });
    const viewId = app.views[0].id;
    // Only the scenarios a desktop app can take are offered; the ones that can't say why.
    const rows = Object.fromEntries(service.scenarios("s").scenarios.map((row) => [row.id, row.error ?? "ok"]));
    assert.deepEqual(Object.keys(rows).sort(), ["lost", "mixed", "no-api", "offline"]);
    assert.match(rows.mixed!, /"open" is for web pages and "args" for desktop apps/);
    assert.match(rows["no-api"]!, /add "api"/);

    const opened = await registry.desktopScenario!(viewId, "offline");
    assert.equal(opened.error, undefined);
    const run = started.at(-1)!;
    assert.deepEqual(run.args, ["--fast", "--demo"]);
    assert.equal(run.env?.THEME, "dark"); assert.equal(run.env?.DISPLAY, ":9");
    const proxy = run.env!.API_URL!;
    assert.match(proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
    const call = async (method: string, url: string) => { const res = await fetch(proxy + url, { method }); return { status: res.status, body: await res.json() }; };
    assert.deepEqual(await call("POST", "/payments"), { status: 503, body: { error: "down" } });
    assert.deepEqual(await call("GET", "/orders"), { status: 200, body: { real: "/orders" } });
    const events = vnc.events();
    assert.deepEqual([events[0], events.readUInt16BE(2), events.readUInt16BE(4)], [5, 10, 20], "the click lands in the window's pixels");

    const lost = await registry.desktopScenario!(viewId, "lost");
    assert.match(lost.error!, /^Step 1 \(click 900,10\): .*outside the app/);
    assert.equal(registry.getView(viewId)!.scenario?.id, "lost", "it stays in the scenario, where it got to");
    await assert.rejects(fetch(proxy + "/payments", { method: "POST" }), "the old scenario's proxy is gone");

    assert.deepEqual(await registry.desktopScenario!(viewId, ""), { plan: null });
    assert.deepEqual(started.at(-1)!.args, ["--fast"]);
    assert.equal(started.at(-1)!.env?.API_URL, undefined);
  } finally { vnc.server.close(); api.close(); service.remove("s", registry.list("s")[0]?.id ?? ""); fs.rmSync(dir, { recursive: true, force: true }); }
});
