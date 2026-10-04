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
import { AppService } from "../src/apps/service.js";
import { AppGateway } from "../src/apps/gateway.js";
import { parseHttpFile, resolveRequest } from "../src/apps/backend/http-file.js";
import { parseRows } from "../src/apps/backend/rows.js";
import { LogBuffer } from "../src/apps/backend/logs.js";
import type { AppReview } from "../packages/core/src/apps.js";

test(".http files read the way editors run them: names, @auto, variables, headers and body", () => {
  const { requests, variables } = parseHttpFile([
    "@token = s3cret",
    "",
    "### Create order",
    "POST {{base}}/orders",
    "Authorization: Bearer {{token}}",
    "Content-Type: application/json",
    "",
    "{ \"items\": [42] }",
    "",
    "###",
    "# @name list-open",
    "# @auto",
    "{{base}}/orders?status=open",
  ].join("\n"));
  assert.deepEqual(requests.map((request) => [request.name, request.method, request.auto]), [["Create order", "POST", false], ["list-open", "GET", true]]);
  assert.deepEqual(resolveRequest(requests[0]!, variables, { base: "http://127.0.0.1:3000" }), {
    method: "POST", url: "http://127.0.0.1:3000/orders",
    headers: [["Authorization", "Bearer s3cret"], ["Content-Type", "application/json"]], body: "{ \"items\": [42] }",
  });
});

test("query output becomes rows whichever format the client prints", () => {
  const expected = { columns: ["code", "note"], rows: [{ code: "SPRING", note: "25%, \"spring\"" }] };
  assert.deepEqual(parseRows('[{"code":"SPRING","note":"25%, \\"spring\\""}]'), expected, "sqlite3 -json, duckdb -json");
  assert.deepEqual(parseRows('code,note\nSPRING,"25%, ""spring"""\n'), expected, "psql --csv");
  assert.deepEqual(parseRows('code\tnote\nSPRING\t25%, "spring"\n').rows[0]!.code, "SPRING", "mysql --batch");
  assert.deepEqual(parseRows(""), { columns: [], rows: [] });
});

test("a server's output becomes timed lines: colours gone, errors found, stack frames kept with their error, secrets out", () => {
  const log = new LogBuffer();
  log.append("\x1b[32mGET /orders 200\x1b[0m in 4ms\nNoMethodError: undefined method `past?'\n    app/models/coupon.rb:14\nCompleted 500 in 9ms\nWARN slow query\npartial", 1);
  log.append(" line\nAuthorization: Bearer abcdefghijklmnop1234567\n", 2);
  assert.deepEqual(log.read().map((line) => [line.level, line.at]), [["info", 1], ["error", 1], ["error", 1], ["error", 1], ["warn", 1], ["info", 2], ["info", 2]]);
  assert.equal(log.read()[0]!.text, "GET /orders 200 in 4ms");
  assert.equal(log.read()[5]!.text, "partial line");
  assert.doesNotMatch(log.read()[6]!.text, /abcdefghijklmnop1234567/);
});

/** An app with an API whose answers the test changes, a "database" (a JSON
 * file read by a node one-liner standing in for sqlite3 -json), and a server
 * log fed through the terminal tap. */
async function backendApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-backend-"));
  const state = { coupon: "valid" as "valid" | "expired" };
  const api = http.createServer((req, res) => {
    if (req.url === "/orders" && req.method === "POST") {
      const ok = state.coupon === "valid";
      res.writeHead(ok ? 201 : 422, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { id: 1043, status: "pending" } : { error: "coupon_expired" }));
    } else if (req.url === "/orders") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ id: 1 }])); }
    else { res.writeHead(404); res.end(); }
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const port = (api.address() as { port: number }).port;
  fs.mkdirSync(path.join(dir, ".bivy/requests"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".bivy/queries"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".bivy/requests/orders.http"), "### List orders\nGET {{base}}/orders\n\n### Create order\n# @auto\nPOST {{base}}/orders\nContent-Type: application/json\n\n{\"coupon\":\"SPRING\"}\n\n### Delete everything\nDELETE {{base}}/orders\n");
  fs.writeFileSync(path.join(dir, ".bivy/queries/coupons.sql"), "-- title: Coupons\n-- key: code\nselect * from coupons");
  const db = (rows: unknown[]) => fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify(rows));
  db([{ code: "SPRING", expires_at: null }]);
  let feed: ((data: string) => void) | undefined;
  const terminals = {
    start: async () => "server", has: () => true, close: () => {},
    tap: (_id: string, onData: (data: string) => void) => { feed = onData; return () => { feed = undefined; }; },
  };
  const reviews: AppReview[] = [];
  const registry = new AppRegistry();
  const service = new AppService(registry, undefined, terminals, { reviews: { publish: (review) => { reviews.push(review); return review; }, expire: () => {} }, serverWatchMs: 60_000 });
  const app = service.publish("s", dir, { version: 1, name: "Orders", views: [
    { kind: "web", name: "API", source: { kind: "service", port, start: { command: "true" } } },
    { kind: "requests", name: "Requests" },
    { kind: "data", name: "Database", command: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(require('fs').readFileSync('db.json','utf8')))"] },
    { kind: "logs", name: "Server log" },
  ] });
  // The server Bivy runs starts, and its output is followed from then on.
  await service.logs("s", app.id, app.views[0]!.id);
  return { dir, state, db, service, reviews, app, registry, log: (text: string) => feed?.(text), close: () => { api.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("a backend-only run gets a card: answers that changed, rows that changed, errors that appeared", async () => {
  const t = await backendApp();
  try {
    const views = Object.fromEntries(t.app.views.map((view) => [view.name, view]));
    assert.deepEqual(views.Requests!.kind === "backend" && [views.Requests.backend, views.Requests.detail], ["requests", "requests · the app's server"]);
    const listed = t.service.backend.requests(t.service.backendView("s", "requests", {}));
    assert.deepEqual(listed.requests.map((item) => [item.name, item.auto]), [["List orders", true], ["Create order", true], ["Delete everything", false]], "only safe or @auto requests run on their own");

    await t.service.runStarted("s");
    t.log("Started GET /orders\n");
    // The agent's change: coupons expire, one coupon gets a date, a new one appears, the server logs an error.
    t.state.coupon = "expired";
    t.db([{ code: "SPRING", expires_at: "2026-03-31" }, { code: "SPRING25", expires_at: null }]);
    await new Promise((r) => setTimeout(r, 5));
    t.log("NoMethodError: undefined method `past?' for nil\n");
    const card = await t.service.runEnded("s");

    assert.equal(card, t.reviews.at(-1));
    assert.equal(card?.shot, undefined, "a backend-only card has no picture");
    assert.deepEqual(card?.evidence?.map((row) => [row.backend, row.summary, row.detail, row.tone]), [
      ["requests", "POST Create order", "201 → 422", "warn"],
      ["requests", "1 request answers the same", undefined, "neutral"],
      ["data", "Coupons", "+1 ~1", "warn"],
      ["logs", "1 new error", "NoMethodError: undefined method `past?' for nil", "danger"],
    ]);
    const detail = t.service.backend.detail(t.service.backendView("s", "requests", {}), card!.evidence![0]!.item!);
    assert.deepEqual(detail.changes?.map((change) => change.path), ["(status)", "id", "status", "error"], "the changed answer, path by path");
    const data = await t.service.backend.data(t.service.backendView("s", "data", { target: "Database" }));
    assert.deepEqual(data.queries[0]!.changes?.changed[0]!.fields, [{ path: "expires_at", before: "null", after: "2026-03-31" }]);
    const log = await t.service.backend.log(t.service.backendView("s", "logs", {}));
    assert.deepEqual(log.marks.map((mark) => mark.label), ["The agent started working"]);
  } finally { t.close(); }
});

test("a run that changes nothing in the backend makes no card", async () => {
  const t = await backendApp();
  try {
    await t.service.runStarted("s");
    assert.equal(await t.service.runEnded("s"), undefined);
    assert.deepEqual(t.reviews, []);
  } finally { t.close(); }
});

test("the preview's Console hears the server's errors since the page loaded, and only the owner does", async () => {
  const t = await backendApp();
  const gateway = new AppGateway(t.registry, "https://{app}.preview.example.net");
  gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
  const port = (gateway.server.address() as { port: number }).port;
  const id = t.app.views[0]!.id, host = new URL(gateway.origin(id)).host;
  const get = (url: string, cookie: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: url, headers: { host, cookie, "sec-fetch-dest": url === "/" ? "iframe" : "empty" } }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
  const redeem = (link: string) => new Promise<string>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/__bivy/redeem", method: "POST", headers: { host, origin: gateway.origin(id) } }, (res) => { res.resume(); resolve(res.headers["set-cookie"]![0]!.split(";")[0]!); });
    req.on("error", reject); req.end(new URL(link).hash.slice(1));
  });
  try {
    const owner = await redeem(gateway.open(id)), reviewer = await redeem(gateway.share(id).url);
    t.log("TypeError: an error before this page\n");
    await new Promise((r) => setTimeout(r, 5));
    await get("/", owner);
    t.log("GET / 200\nTypeError: cannot read properties of undefined (reading 'total')\n    at render (app/page.tsx:12)\n");
    const first = JSON.parse((await get("/__bivy/server-errors?since=page", owner)).body);
    assert.deepEqual(first.lines.map((line: { text: string }) => line.text), ["TypeError: cannot read properties of undefined (reading 'total')", "    at render (app/page.tsx:12)"]);
    assert.deepEqual(JSON.parse((await get(`/__bivy/server-errors?since=${first.now}`, owner)).body).lines, [], "each error once");
    assert.equal((await get("/__bivy/server-errors?since=page", reviewer)).status, 403);
  } finally { gateway.close(); t.close(); }
});

test("a request runs inside a scenario: its rules answer what they match, the server the rest", async () => {
  const t = await backendApp();
  fs.mkdirSync(path.join(t.dir, ".bivy/scenarios"), { recursive: true });
  fs.writeFileSync(path.join(t.dir, ".bivy/scenarios/orders-down.json"), JSON.stringify({ name: "Orders down", network: [{ match: "POST /orders", status: 503, json: { error: "down" } }] }));
  fs.writeFileSync(path.join(t.dir, ".bivy/scenarios/empty-cart.json"), JSON.stringify({ name: "Empty cart", open: "/cart" }));
  try {
    const view = t.service.backendView("s", "requests", {});
    assert.deepEqual(t.service.backend.requests(view).scenarios, [{ id: "orders-down", name: "Orders down", simulated: "POST /orders → 503" }], "only scenarios that simulate responses");
    const create = await t.service.backend.run(view, "Create order", "last", "orders-down");
    assert.deepEqual([create.item.last?.status, create.item.last?.body, create.item.last?.simulated, create.item.last?.scenario], [503, '{"error":"down"}', true, "Orders down"]);
    const list = await t.service.backend.run(view, "List orders", "last", "orders-down");
    assert.deepEqual([list.item.last?.status, list.item.last?.simulated, list.item.last?.scenario], [200, undefined, "Orders down"], "no rule for it: the real server answers");
    await assert.rejects(t.service.backend.run(view, "List orders", "last", "empty-cart"), /No scenario "empty-cart" that simulates responses/);
    const log = await t.service.backend.log(t.service.backendView("s", "logs", {}));
    assert.equal(log.marks.at(-1)?.label, "Ran “List orders” in “Orders down”");
  } finally { t.close(); }
});
