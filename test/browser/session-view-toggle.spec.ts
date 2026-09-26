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
    // The runtime can hand itself to its interactive TUI — the capability the
    // Chat | Terminal toggle is gated on (the toggle means "the live agent").
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available", capabilities: { interactiveTui: true } }] });
    c.store.apply({ type: "sessions.list", sessions: [
      { sessionId: "first", name: "First session", runtimeId: "claude", status: "saved" },
      { sessionId: "second", name: "Second session", runtimeId: "claude", status: "saved" },
    ] });
    c.openSession("first");
    c.store.apply({ type: "session.history", sessionId: "first", runtimeId: "claude", messages: [{ role: "user", content: "Chat transcript" }] });
  });
});

test("Terminal resumes the session's live agent TUI, remembers the choice, and Chat takes it back", async ({ page }) => {
  const tuiCommands = () => page.evaluate(() => (window as any).sent
    .filter((m: { kind?: string }) => /^terminal\.(open\.tui|close\.tui|attach)$/.test(m.kind ?? ""))
    .map((m: { kind: string; termId?: string; sessionId?: string }) => [m.kind, m.termId ?? m.sessionId]));
  const view = page.getByRole("radiogroup", { name: "Session view" });

  // Toggle to Terminal → resume/attach the session's interactive TUI (the live
  // agent), not a bare shell.
  await view.getByRole("radio", { name: "Terminal" }).click();
  await expect.poll(tuiCommands).toEqual([["terminal.open.tui", "first"]]);
  // The node acks a pty and broadcasts the single-writer lock.
  await page.evaluate(() => {
    for (const fn of (window as any).viewController.terminalListeners) fn({ type: "terminal.opened", termId: "tui-1" });
    (window as any).viewController.store.apply({ type: "terminal.tui", sessionId: "first", active: true });
  });
  await expect(page.getByText("Chat transcript")).toHaveCount(0);
  // The lock must NOT swap the view we opened out for the lock banner: the
  // terminal stays and the toggle stays on Terminal.
  await expect(view.getByRole("radio", { name: "Terminal" })).toHaveAttribute("aria-checked", "true");

  // The choice is remembered per session: a second session starts in chat, and
  // returning to the first restores its terminal (reattaching the live TUI).
  await page.evaluate(() => (window as any).viewController.openSession("second"));
  await expect(view.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => (window as any).viewController.openSession("first"));
  await expect(view.getByRole("radio", { name: "Terminal" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(tuiCommands).toEqual([["terminal.open.tui", "first"], ["terminal.attach", "tui-1"]]);

  // Back to Chat takes the session out of the TUI (single writer): stop it so the
  // node rebuilds the session from disk and the composer unlocks.
  await view.getByRole("radio", { name: "Chat" }).click();
  await expect.poll(tuiCommands).toEqual([["terminal.open.tui", "first"], ["terminal.attach", "tui-1"], ["terminal.close.tui", "first"]]);
  await page.evaluate(() => (window as any).viewController.store.apply({ type: "terminal.tui", sessionId: "first", active: false }));
  await expect(page.getByText("Chat transcript")).toBeVisible();
});

test("the Chat | Terminal toggle is hidden when the runtime has no interactive TUI", async ({ page }) => {
  // A runtime that can't hand itself to a TUI would only ever open a bare shell,
  // so the toggle isn't offered — chat is the only view.
  await page.evaluate(() => (window as any).viewController.store.apply({
    type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available", capabilities: { interactiveTui: false } }],
  }));
  await expect(page.getByText("Chat transcript")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Session view" })).toHaveCount(0);
});
