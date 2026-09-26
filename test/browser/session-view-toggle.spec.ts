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
      status: 503, json: { error: "Daemon intentionally offline in session view fixture" },
    }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    // Real app/controller; record terminal commands instead of reaching a node.
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    (window as any).viewController = c;
    (window as any).sent = [];
    c.transport.close();
    c.transport.send = async (command: unknown) => { (window as any).sent.push(command); };
    c.store.setError("");
    c.store.setStatus("online");
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [
      { sessionId: "first", name: "First session", runtimeId: "claude", status: "saved" },
      { sessionId: "second", name: "Second session", runtimeId: "claude", status: "saved" },
    ] });
    c.openSession("first");
    c.store.apply({ type: "session.history", sessionId: "first", runtimeId: "claude", messages: [{ role: "user", content: "Chat transcript" }] });
  });
});

test("switching views keeps the session's shell and remembers the choice per session", async ({ page }) => {
  const terminalCommands = () => page.evaluate(() => (window as any).sent
    .filter((m: { kind?: string }) => /^terminal\.(open|attach|close)$/.test(m.kind ?? ""))
    .map((m: { kind: string; termId?: string; sessionId?: string }) => [m.kind, m.termId ?? m.sessionId]));
  const view = page.getByRole("radiogroup", { name: "Session view" });

  await view.getByRole("radio", { name: "Terminal" }).click();
  await expect.poll(terminalCommands).toEqual([["terminal.open", "first"]]);
  await page.evaluate(() => {
    for (const fn of (window as any).viewController.terminalListeners) fn({ type: "terminal.opened", termId: "shell-1" });
  });
  await expect(page.getByText("Chat transcript")).toHaveCount(0);

  // Back to chat with the keyboard: the shell is left running, not closed.
  await view.getByRole("radio", { name: "Terminal" }).press("ArrowLeft");
  await expect(view.getByRole("radio", { name: "Chat" })).toBeFocused();
  await expect(page.getByText("Chat transcript")).toBeVisible();

  // Returning reattaches the same shell instead of opening another.
  await view.getByRole("radio", { name: "Terminal" }).click();
  await expect.poll(terminalCommands).toEqual([["terminal.open", "first"], ["terminal.attach", "shell-1"]]);

  // Another session starts in chat; coming back restores its terminal.
  await page.evaluate(() => (window as any).viewController.openSession("second"));
  await expect(view.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => (window as any).viewController.openSession("first"));
  await expect(view.getByRole("radio", { name: "Terminal" })).toHaveAttribute("aria-checked", "true");
});
