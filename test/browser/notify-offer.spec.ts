// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

for (const theme of themes) {
  test(`notifications are offered once while the agent works, then the next step (${theme})`, async ({ page }, testInfo) => {
    await page.routeWebSocket(/.*/, () => {});
    for (const endpoint of ["auth/bootstrap", "sessions", "sessions/open", "session/presence/get", "session/history", "apps/offers", "apps/list", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
      await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in notify offer fixture" } }));
    }
    await page.addInitScript((value) => localStorage.setItem("bivy_theme", value), theme);
    await page.clock.install();
    await page.goto(url);
    await page.evaluate(async () => {
      const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
      const w = window as any;
      w.c = c; w.enabled = 0; w.fail = true;
      c.transport.close();
      c.transport.send = async () => {};
      c.store.setStatus("online");
      // An account-backed client whose browser supports push but hasn't subscribed.
      Object.defineProperty(c, "direct", { value: false });
      c.store.setSignedIn(true);
      c.store.setNodes([{ id: "m", name: "My laptop", online: true }]);
      c.store.setCurrentNode("m");
      c.pushStatus = async () => ({ supported: true, subscribed: false, permission: "default" });
      c.enablePush = async () => {
        w.enabled++;
        if (w.fail) throw Error("Notifications were blocked. Allow them in your browser settings.");
        return "Push notifications enabled.";
      };
      c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
      c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Status page", runtimeId: "claude", status: "saved" }] });
      c.openSession("s");
      c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [{ role: "user", content: "Build a status page." }] });
    });

    const offer = page.getByRole("region", { name: "Get a notification when it's done?" });
    await expect(offer).toHaveCount(0);
    await page.evaluate(() => (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "agent_start" } }));
    await expect(offer).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`notify-offer-${theme}.png`), fullPage: true });

    // The turn ends with an answer: the offer stays, and the automations next step waits its turn.
    await page.evaluate(() => {
      const c = (window as any).c;
      c.store.apply({ type: "session.event", sessionId: "s", event: { type: "agent_end" } });
      c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [
        { role: "user", content: "Build a status page." }, { role: "assistant", content: "Done — the status page is published." },
      ] });
    });
    await expect(page.getByText("Done — the status page is published.")).toBeVisible();
    await expect(offer).toBeVisible();
    await expect(page.getByRole("region", { name: "Next step" })).toHaveCount(0);

    // A refusal keeps the offer so the user can fix it and retry.
    await offer.getByRole("button", { name: "Turn on notifications" }).click();
    await expect(offer.getByRole("alert")).toContainText("blocked");
    await page.evaluate(() => { (window as any).fail = false; });
    await offer.getByRole("button", { name: "Turn on notifications" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Notifications are on" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).enabled)).toBe(2);
    await page.clock.runFor(5000);
    await expect(page.getByRole("region", { name: "Next step" })).toContainText("Make this repeatable");

    // Offered once per device: a later turn after a reload doesn't ask again.
    await page.reload();
    await page.evaluate(async () => {
      const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
      c.transport.close();
      c.store.setStatus("online");
      Object.defineProperty(c, "direct", { value: false });
      c.store.setSignedIn(true);
      c.store.setNodes([{ id: "m", name: "My laptop", online: true }]);
      c.store.setCurrentNode("m");
      c.pushStatus = async () => ({ supported: true, subscribed: false, permission: "default" });
      c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Status page", runtimeId: "claude", status: "saved" }] });
      c.openSession("s");
      c.store.apply({ type: "session.event", sessionId: "s", event: { type: "agent_start" } });
    });
    await expect(page.locator(".next-step")).toHaveCount(0);
  });
}
