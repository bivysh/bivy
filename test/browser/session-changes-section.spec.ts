// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

// On a phone there is no side pane: Agent | Changes in the top bar swaps the
// chat for the session's changes, full height, instead of a bottom sheet. This
// runs the real app with a controller that records instead of reaching a node.
let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => {
  url = webApp.origin;
});

type Win = { viewController: { store: { apply(event: unknown): void } } };

for (const theme of themes) {
  test(`Agent | Changes swaps the chat for the changes (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.routeWebSocket(/.*/, () => {});
    for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
      await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "offline fixture" } }));
    }
    await page.addInitScript((theme) => localStorage.setItem("bivy_theme", theme), theme);
    await page.goto(url);
    await page.evaluate(async () => {
      const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
      (window as unknown as Win & { sent: unknown[] }).viewController = c;
      c.transport.close();
      c.transport.send = async () => {};
      c.store.setError("");
      c.store.setStatus("online");
      // A runtime with a TUI, so Chat | Terminal shares the line too.
      c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available", capabilities: { interactiveTui: true } }] });
      c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "first", name: "Tighten the onboarding copy", runtimeId: "claude", status: "saved" }] });
      c.openSession("first");
      c.store.apply({ type: "session.history", sessionId: "first", runtimeId: "claude", messages: [{ role: "user", content: "Chat transcript" }] });
    });
    await expect(page.getByText("Chat transcript")).toBeVisible();
    const sections = page.getByRole("radiogroup", { name: "Show" });
    // Nothing to show yet: no switch.
    await expect(sections).toHaveCount(0);

    await page.evaluate(() => (window as unknown as Win).viewController.store.apply({
      type: "session.changes", sessionId: "first", before: "c0", after: "c1",
      changes: [
        { path: "packages/web/src/components/GetStarted.tsx", status: "modified", oldText: "a\nb\nc", newText: "a\nB\nc\nd" },
        { path: "packages/web/src/styles.css", status: "modified", oldText: "x", newText: "x\ny" },
      ],
    }));
    await expect(sections).toBeVisible();
    // The top bar's second line holds machine, Chat | Terminal and this, at 390px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await sections.getByRole("radio", { name: /Changes/ }).click();
    const changes = page.locator(".main-changes");
    await expect(changes.getByText("2 files edited")).toBeVisible();
    await expect(page.getByText("Chat transcript")).toBeHidden();
    await expect(page.locator(".composer")).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Full height: from under the top bar to the bottom of the screen.
    const box = (await changes.boundingBox())!;
    const topbar = (await page.locator(".topbar").boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.abs(box.y - (topbar.y + topbar.height))).toBeLessThan(2);
    expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThan(2);
    await changes.getByRole("button", { name: /2 files changed/ }).click();
    await page.screenshot({ path: testInfo.outputPath(`changes-section-${theme}.png`) });

    // Review with agent puts the prompt in the composer and shows it.
    await changes.getByRole("button", { name: "Review with agent" }).click();
    await expect(sections.getByRole("radio", { name: "Agent" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Chat transcript")).toBeVisible();
    await expect(page.locator(".composer textarea")).toHaveValue(/GetStarted\.tsx/);
    expect(errors).toEqual([]);
  });
}
