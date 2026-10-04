// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

const APP = "a".repeat(32);
const REQUESTS = "r".repeat(32), DATA = "d".repeat(32), LOGS = "l".repeat(32);
const answer = (status: number, body: unknown, at = Date.now() - 60_000) => ({ status, statusText: status === 201 ? "Created" : status === 422 ? "Unprocessable Entity" : "OK", ms: 38, at, headers: {}, body: JSON.stringify(body), json: true });
const created = answer(201, { id: 1043, status: "pending" }), rejected = answer(422, { error: "coupon_expired", message: "SPRING expired on 31 Mar." });

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in backend views fixture" } }));
  }
  await page.goto(url);
  await page.evaluate(async ({ APP, REQUESTS, DATA, LOGS, created, rejected }) => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    const w = window as any;
    w.c = c; w.commands = []; w.drafts = [];
    c.transport.close();
    c.transport.send = async () => {};
    c.store.setStatus("online");
    c.prefillComposer = (text: string) => { w.drafts.push(text); return true; };
    const now = Date.now();
    const items = [
      { id: "orders/create-order-expired-coupon", file: "orders.http", name: "Create order, expired coupon", method: "POST", url: "http://127.0.0.1:3000/orders", auto: true, before: created, last: rejected },
      { id: "orders/list-orders", file: "orders.http", name: "List orders", method: "GET", url: "http://127.0.0.1:3000/orders?status=open", auto: true, before: { ...created, status: 200, body: "[]" }, last: { ...created, status: 200, body: "[]" } },
      { id: "coupons/expire", file: "coupons.http", name: "Expire a coupon", method: "DELETE", url: "http://127.0.0.1:3000/coupons/SPRING", auto: false },
    ];
    c.appCommand = async (kind: string, sessionId: string, fields: Record<string, unknown> = {}) => {
      w.commands.push({ kind, sessionId, ...fields });
      if (kind === "apps.list") return { previewAvailable: true, apps: [{ id: APP, sessionId: "s", name: "Orders API", createdAt: 0, views: [
        { id: REQUESTS, kind: "backend", backend: "requests", name: "Requests", detail: "requests · the app's server" },
        { id: DATA, kind: "backend", backend: "data", name: "Database", detail: "sqlite3 -readonly -json dev.sqlite3" },
        { id: LOGS, kind: "backend", backend: "logs", name: "Server log", detail: "API output" },
      ] }] };
      if (kind === "apps.offers") return { offers: [] };
      if (kind === "apps.requests") return { base: "http://127.0.0.1:3000", requests: items, problems: [], scenarios: w.scenarios ?? [] };
      if (kind === "apps.runRequest" && fields.scenario) {
        const item = items.find((entry) => entry.id === fields.id)!;
        item.last = { status: 503, statusText: "", ms: 0, at: Date.now(), headers: {}, body: JSON.stringify({ error: "down" }), json: true, scenario: "Payments down", simulated: true } as any;
      }
      if (kind === "apps.request" || kind === "apps.runRequest") {
        const item = items.find((entry) => entry.id === fields.id)!;
        return { item, request: { method: item.method, url: item.url, headers: [["Content-Type", "application/json"]], body: "{ \"coupon\": \"SPRING\" }" },
          ...(item.before && item.last && !(item.last as any).simulated ? { changes: item.before.status === item.last.status ? [] : [{ path: "(status)", before: "201", after: "422" }, { path: "id", before: "1043" }, { path: "status", before: "\"pending\"" }, { path: "error", after: "\"coupon_expired\"" }] } : {}) };
      }
      if (kind === "apps.data") return { detail: "sqlite3", problems: [], queries: [
        { id: "coupons", file: "coupons.sql", title: "coupons", key: "code", columns: ["code", "expires_at", "percent"], count: 2, at: now - 30_000,
          rows: [{ code: "SPRING", expires_at: "2026-03-31", percent: "20" }, { code: "SPRING25", expires_at: "2026-04-30", percent: "25" }],
          changes: { added: [{ key: "SPRING25", row: { code: "SPRING25", expires_at: "2026-04-30", percent: "25" } }], changed: [{ key: "SPRING", row: { code: "SPRING", expires_at: "2026-03-31", percent: "20" }, fields: [{ path: "expires_at", before: "null", after: "2026-03-31" }] }], removed: [] } },
        { id: "orders", file: "orders.sql", title: "orders", key: "id", columns: ["id", "status"], count: 128, rows: [{ id: "1", status: "paid" }], at: now - 30_000, changes: { added: [], changed: [], removed: [] } },
      ] };
      if (kind === "apps.serverLog") return { detail: "API output", running: true,
        marks: [{ at: now - 20_000, label: "Ran “Create order, expired coupon”" }],
        lines: [
          { at: now - 40_000, level: "info", text: "GET /orders 200 in 4ms" },
          { at: now - 20_000, level: "info", text: "POST /orders" },
          { at: now - 20_000, level: "error", text: "NoMethodError: undefined method `past?' for nil" },
          { at: now - 20_000, level: "error", text: "    app/models/coupon.rb:14:in `expired?'" },
          { at: now - 20_000, level: "info", text: "Completed 500 in 9ms" },
        ] };
      return { ok: true };
    };
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Expire coupons", runtimeId: "claude", status: "saved" }] });
    c.openSession("s");
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [
      { role: "user", content: "Reject coupons after their expiry date." },
      { role: "assistant", content: "Orders now reject an expired coupon with a 422 and a message the app can show." },
    ] });
  }, { APP, REQUESTS, DATA, LOGS, created, rejected });
});

// A backend-only run's card shows what changed; each line opens its view there.
test("a backend run's card shows its evidence and opens the changed answer, rows and logs", async ({ page }, testInfo) => {
  await page.evaluate(({ APP, REQUESTS, DATA, LOGS }) => (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: "review-backend0000000", review: {
    id: "review-backend0000000", sessionId: "s", appId: APP, viewId: REQUESTS, name: "Orders API", view: "Requests", path: "/", trigger: "run", at: Date.now(),
    evidence: [
      { viewId: REQUESTS, view: "Requests", backend: "requests", summary: "POST Create order, expired coupon", detail: "201 → 422", tone: "warn", item: "orders/create-order-expired-coupon" },
      { viewId: REQUESTS, view: "Requests", backend: "requests", summary: "1 request answers the same", tone: "neutral" },
      { viewId: DATA, view: "Database", backend: "data", summary: "coupons", detail: "+1 ~1", tone: "warn", item: "coupons" },
      { viewId: LOGS, view: "Server log", backend: "logs", summary: "1 new error", detail: "NoMethodError: undefined method `past?' for nil", tone: "danger" },
    ],
  } } }), { APP, REQUESTS, DATA, LOGS });
  const card = page.getByRole("region", { name: "Orders API: changed in this run" });
  await expect(card.getByRole("list", { name: "What changed in the backend" }).getByRole("listitem")).toHaveCount(4);
  await card.screenshot({ path: testInfo.outputPath("backend-card.png") });

  // Data: rows matched by key.
  await card.getByRole("button", { name: /Data: coupons/ }).click();
  const coupons = page.getByRole("region", { name: "coupons", exact: true });
  await expect(coupons.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "orders", exact: true })).toContainText("No changes · 128 rows");
  await page.screenshot({ path: testInfo.outputPath("data.png"), animations: "disabled" });

  // Logs, from the app's list: the last action, then what the server said.
  await page.getByRole("button", { name: "‹ Apps" }).click();
  await page.getByRole("button", { name: "Open logs" }).click();
  await expect(page.getByText(/^Your last action · Ran “Create order, expired coupon”/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("logs.png"), animations: "disabled" });
  await page.getByRole("radio", { name: /Errors/ }).click();
  await expect(page.locator(".backend-line")).toHaveCount(2);
  await page.getByRole("button", { name: "Send errors to agent…" }).click();
  expect(await page.evaluate(() => (window as any).drafts.at(-1))).toContain("after “Ran “Create order, expired coupon””");

  // Review changes: the changed answer, path by path.
  await card.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByText("422 Unprocessable Entity")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Changes" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".backend-changes li")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("request-changes.png"), animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: testInfo.outputPath("request-changes-dark.png"), animations: "disabled" });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  // The list: what runs on its own, and what only runs on a tap (with a confirmation).
  await page.getByRole("button", { name: "‹ Requests" }).click();
  await expect(page.getByRole("button", { name: /Expire a coupon/ })).toContainText("runs on tap");
  await page.screenshot({ path: testInfo.outputPath("requests.png"), animations: "disabled" });
  await page.getByRole("button", { name: /Expire a coupon/ }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Run DELETE Expire a coupon?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.runRequest"))).toBe(false);

  // A changed answer becomes a draft with the request and what it answered.
  await page.getByRole("button", { name: "‹ Requests" }).click();
  await page.getByRole("region", { name: "orders.http" }).getByRole("button", { name: /Create order, expired coupon/ }).click();
  await page.getByRole("button", { name: "Send to agent…" }).click();
  expect(await page.evaluate(() => (window as any).drafts.at(-1))).toContain("answered 422 (it answered 201 before your last run)");
});

// Inside a scenario, a request gets what the app gets there: the scenario's
// rule answers, and the answer says so instead of looking like a regression.
test("a request runs inside a scenario and its answer says it was simulated", async ({ page }) => {
  await page.evaluate(({ APP, REQUESTS }) => {
    const w = window as any;
    w.scenarios = [{ id: "payments-down", name: "Payments down", simulated: "POST /orders → 503" }];
    w.c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: "review-backend0000001", review: {
      id: "review-backend0000001", sessionId: "s", appId: APP, viewId: REQUESTS, name: "Orders API", view: "Requests", path: "/", trigger: "run", at: Date.now(),
      evidence: [{ viewId: REQUESTS, view: "Requests", backend: "requests", summary: "POST Create order, expired coupon", detail: "201 → 422", tone: "warn", item: "orders/create-order-expired-coupon" }],
    } } });
  }, { APP, REQUESTS });
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("combobox", { name: "Run in" }).selectOption("payments-down");
  await expect(page.getByText("Simulates POST /orders → 503; other requests reach the server.")).toBeVisible();
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(page.getByText("Simulated by “Payments down”")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Now" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Changes" })).toBeDisabled();
  await expect(page.getByText("was 201")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("request-in-scenario.png"), animations: "disabled" });
  expect(await page.evaluate(() => (window as any).commands.find((c: any) => c.kind === "apps.runRequest"))).toMatchObject({ id: "orders/create-order-expired-coupon", scenario: "payments-down" });
  await page.getByRole("button", { name: "‹ Requests" }).click();
  await expect(page.getByRole("region", { name: "orders.http" }).getByRole("button", { name: /Create order, expired coupon/ })).toContainText("503 · simulated");
  await expect(page.getByRole("combobox", { name: "Run in" })).toHaveValue("payments-down");
});
