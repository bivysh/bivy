// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => {
  url = webApp.origin;
});

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), route => route.fulfill({
      status: 503, json: { error: "Daemon intentionally offline in plan card fixture" },
    }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    c.transport.close();
    c.transport.send = async () => {};
    c.store.setError("");
    c.store.setStatus("online");
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Planned work", runtimeId: "grok", status: "saved" }] });
    c.openSession("s");
    const plan = { kind: "plan" };
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "grok", messages: [
      { role: "user", content: "Do both steps" },
      { role: "assistant", content: [{ type: "tool_use", id: "p1", name: "todo_write", detail: plan, input: { todos: [{ id: "1", content: "Read the file", status: "in_progress" }, { id: "2", content: "Edit the file", status: "pending" }] } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "read", detail: { kind: "read", path: "a.js" }, input: { path: "a.js" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "p2", name: "todo_write", detail: plan, input: { merge: true, todos: [{ id: "1", content: null, status: "completed" }, { id: "2", content: null, status: "in_progress" }] } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "r2", name: "read", detail: { kind: "read", path: "b.js" }, input: { path: "b.js" } }] },
      { role: "assistant", content: "Editing now." },
    ] });
  });
});

test("a turn shows its plan once, at its latest state, as a checklist", async ({ page }) => {
  await expect(page.getByText("Editing now.")).toBeVisible();
  const plan = page.getByRole("button", { name: /^Plan/ });
  await expect(plan).toHaveCount(1);
  await expect(plan).toContainText("1 of 2 done");
  await expect(plan).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".plan-step")).toHaveText(["Read the file, Done", "Edit the file, In progress"]);
  await plan.click();
  await expect(page.locator(".plan-step")).toHaveCount(0);
  await expect(plan).toContainText("1 of 2 done · Edit the file");
});
