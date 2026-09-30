// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

const APP = "a".repeat(32);
const pin = (fields: Record<string, unknown>) => ({
  id: "pin-0123456789abcdef", sessionId: "s", appId: APP, viewId: "v".repeat(32), name: "Storefront", view: "Site",
  path: "/checkout", words: "This button is too small to hit with a thumb.", at: 1,
  selectors: ["#buy"], region: { x: 10, y: 10, width: 60, height: 20 }, viewport: { width: 390, height: 844 },
  state: "open", shot: { hash: "c".repeat(64), size: 10, width: 780, height: 1688 }, ...fields,
});

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in pin card fixture" } }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    const w = window as any;
    w.c = c; w.commands = [];
    c.transport.close();
    c.transport.send = async () => {};
    c.store.setError("");
    c.store.setStatus("online");
    c.fetchAttachment = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 390; canvas.height = 844;
      const g = canvas.getContext("2d")!; g.fillStyle = "#26b"; g.fillRect(0, 0, 390, 844);
      g.strokeStyle = "#ff2d78"; g.lineWidth = 6; g.strokeRect(40, 120, 200, 70);
      return { mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] };
    };
    c.appCommand = async (kind: string, sessionId: string, fields: Record<string, unknown> = {}) => {
      w.commands.push({ kind, sessionId, ...fields });
      return { ok: true };
    };
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Checkout polish", runtimeId: "claude", status: "saved" }] });
    c.openSession("s");
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [
      { role: "user", content: "Give the pay button more room above the home bar." },
    ] });
  });
});

for (const theme of themes) {
  test(`a pin keeps its place and moves its state, never making a second card (${theme})`, async ({ page }, testInfo) => {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    const send = (fields: Record<string, unknown>) => page.evaluate((p) => (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_pin", id: p.id, pin: p } }), pin(fields));

    await send({});
    const open = page.getByRole("region", { name: "Pinned on Storefront: open" });
    await expect(open).toBeVisible();
    await expect(open.getByRole("img", { name: /What you marked on Storefront at \/checkout/ })).toBeVisible();
    await expect(open.getByText("This button is too small to hit with a thumb.")).toBeVisible();
    await expect(open.getByText("Nothing has changed here yet.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`pin-open-${theme}.png`), fullPage: true });

    // A later run changed the marked pixels: the same pin, answered in place.
    await send({ state: "changed", stateAt: 2 });
    await expect(page.getByRole("region", { name: /^Pinned on Storefront/ })).toHaveCount(1);
    const changed = page.getByRole("region", { name: "Pinned on Storefront: changed" });
    await expect(changed.getByText("A later run changed what you marked. Have a look.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`pin-changed-${theme}.png`), fullPage: true });

    // The person's own verdict, which travels as a command, not a message.
    await changed.getByRole("button", { name: "Mark done" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).commands.at(-1)))
      .toMatchObject({ kind: "apps.pinState", sessionId: "s", pinId: "pin-0123456789abcdef", state: "done" });

    // What it named leaving the page is its own answer, and says so in words.
    await send({ state: "gone", stateAt: 3 });
    await expect(page.getByRole("region", { name: "Pinned on Storefront: element gone" })
      .getByText("What you marked is no longer on the page.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`pin-gone-${theme}.png`), fullPage: true });
  });
}
