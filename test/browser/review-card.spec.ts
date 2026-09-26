// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

const APP = "a".repeat(32);
const review = (fields: Record<string, unknown>) => ({ id: "review-0123456789abcdef", sessionId: "s", appId: APP, viewId: "v".repeat(32), name: "Storefront", view: "Site", path: "/checkout", trigger: "run", at: 1, ...fields });
const shot = (hash: string) => ({ hash: hash.repeat(64), size: 10, width: 780, height: 1688 });

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in review card fixture" } }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    const w = window as any;
    w.c = c; w.commands = []; w.mode = "ready";
    c.transport.close();
    c.transport.send = async () => {};
    c.store.setError("");
    c.store.setStatus("online");
    // Screenshots arrive by hash over the session channel: one colour per hash.
    c.fetchAttachment = async (hash: string) => {
      const canvas = document.createElement("canvas"); canvas.width = 390; canvas.height = 844;
      const g = canvas.getContext("2d")!; g.fillStyle = hash.startsWith("b") ? "#2b6" : "#26b"; g.fillRect(0, 0, 390, 844);
      g.fillStyle = "#fff"; g.font = "32px sans-serif"; g.fillText(hash.startsWith("b") ? "Before" : "After", 40, 80);
      return { mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] };
    };
    c.appCommand = async (kind: string, sessionId: string, fields: Record<string, unknown> = {}) => {
      w.commands.push({ kind, sessionId, ...fields });
      if (kind === "apps.list") return { apps: [{ id: "a".repeat(32), sessionId: "s", name: "Storefront", createdAt: 0, reviewMode: w.mode, views: [] }], previewAvailable: true };
      if (kind === "apps.reviewMode") w.mode = fields.mode;
      return { ok: true };
    };
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Checkout polish", runtimeId: "claude", status: "saved" }] });
    c.openSession("s");
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [
      { role: "user", content: "Give the pay button more room above the home bar." },
      { role: "assistant", content: "Done: the pay button now sits 24px higher, clear of the home bar." },
    ] });
  });
});

for (const theme of themes) {
  test(`a run's review card updates in place and its menu sets the app's mode (${theme})`, async ({ page }, testInfo) => {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    const send = (fields: Record<string, unknown>) => page.evaluate((r) => (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: r.id, review: r } }), review(fields));

    await send({ shot: shot("a"), before: shot("b") });
    const card = page.getByRole("region", { name: "Storefront: changed in this run" });
    await expect(card).toBeVisible();
    await expect(card.getByRole("img", { name: /Storefront at \/checkout, now/ })).toBeVisible();
    // Before/Now switches the picture; one primary action opens the live preview.
    await card.getByRole("radio", { name: "Before" }).click();
    await expect(card.getByRole("img", { name: /before this run/ })).toBeVisible();
    await card.getByRole("radio", { name: "Now" }).click();
    await page.screenshot({ path: testInfo.outputPath(`review-card-${theme}.png`), fullPage: true });

    // The agent presents the same run's card again: still one card, updated.
    await send({ shot: shot("c"), trigger: "present", note: "Moved the button up 24px" });
    await expect(page.locator(".review-card")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Storefront: ready to review" })).toContainText("Moved the button up 24px");

    // The three modes, remembered with the app on the machine.
    const menu = page.getByRole("button", { name: "Preview card options for Storefront" });
    await menu.click();
    await expect(page.getByRole("menuitemradio", { name: "When ready" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio", { name: "Every change" })).toBeVisible();
    await page.getByRole("menuitemradio", { name: "Off" }).click();
    await expect(page.getByRole("status").filter({ hasText: "No more cards for Storefront" })).toBeVisible();
    await menu.click();
    await expect(page.getByRole("menuitemradio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "Every change" }).click();
    expect(await page.evaluate(() => (window as any).commands.filter((c: any) => c.kind === "apps.reviewMode").map((c: any) => c.mode))).toEqual(["off", "every"]);

    // While the agent works, the card can mute the rest of this run.
    await expect(page.getByRole("menuitem", { name: "Mute for this run" })).toHaveCount(0);
    await page.evaluate(() => (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "agent_start" } }));
    await menu.click();
    await page.getByRole("menuitem", { name: "Mute for this run" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.mute"))).toBe(true);

    // A newer card for the view retires this one's pictures.
    await send({ trigger: "present", expired: true, note: "Moved the button up 24px" });
    await expect(page.getByText("Screenshot no longer stored")).toBeVisible();
    await expect(page.locator(".review-card")).toHaveCount(1);
  });
}

test("without agent screenshots, the card offers to turn them on and never does it by itself", async ({ page }) => {
  await page.evaluate(() => { const w = window as any; w.settings = []; w.c.setNodeSettings = async (patch: unknown) => { w.settings.push(patch); }; });
  await page.evaluate((r) => (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: r.id, review: r } }), review({ trigger: "asked", screenshotsOff: true }));
  const card = page.getByRole("region", { name: "Storefront: as it looks now" });
  await expect(card).toContainText("Turn on agent screenshots");
  expect(await page.evaluate(() => (window as any).settings)).toEqual([]);
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).settings)).toEqual([{ appScreenshots: true }]);
  await expect.poll(() => page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.showMe"))).toBe(true);
});
