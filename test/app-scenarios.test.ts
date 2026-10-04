// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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
