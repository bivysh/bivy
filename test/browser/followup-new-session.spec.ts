// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

test("a follow-up typed while the agent works can run now in its own session", async ({ page }, testInfo) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "session/presence/get", "session/history", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in follow-up fixture" } }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    const w = window as any;
    w.c = c; w.sent = [];
    c.transport.close();
    c.transport.send = async () => {};
    // The node answers a background start like it answers session.new: with the new session's history.
    c.sendToCurrentNode = (command: Record<string, unknown>) => {
      w.sent.push(command);
      if (command.kind === "session.new") setTimeout(() => c.sessionCoordinator.handleEvent({ type: "session.history", requestId: command.requestId, sessionId: "s2", messages: [] }), 50);
    };
    c.store.setStatus("online");
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Status page", runtimeId: "claude", status: "saved" }] });
    c.openSession("s");
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [{ role: "user", content: "Build a status page." }] });
    c.store.apply({ type: "session.event", sessionId: "s", event: { type: "agent_start" } });
  });

  await page.locator(".composer-input").fill("Also add a /version endpoint");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  const row = page.locator(".followup-queue");
  await expect(row).toContainText("Also add a /version endpoint");
  await page.screenshot({ path: testInfo.outputPath("followup-queue.png"), fullPage: true });
  await row.getByRole("button", { name: "Run in new session" }).click();

  // Started beside this session (same project and agent, decided by the node), with the text as its first message.
  await expect.poll(() => page.evaluate(() => (window as any).sent.find((c: any) => c.kind === "session.new"))).toMatchObject({ like: "s", prompt: "Also add a /version endpoint" });
  await expect(page.locator(".followup-queue")).toHaveCount(0);
  // This session is still the one open, still working.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Status page");
  await expect(page.getByRole("button", { name: "Stop current turn" })).toBeVisible();
});
