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
      if (kind === "apps.list") return { apps: [{ id: "a".repeat(32), sessionId: "s", name: "Storefront", createdAt: 0, reviewMode: w.mode, views: [{ id: "v".repeat(32), kind: "web", name: "Site", source: "static", address: "https://preview.example.net/app/site" }] }], previewAvailable: true };
      if (kind === "apps.open") return { kind: "web", url: "https://preview.example.net/__bivy/open#private" };
      if (kind === "apps.share") {
        if (w.shareError) throw Error("Machine unavailable. Try again.");
        return { url: "https://preview.example.net/__bivy/open#shared", expiresAt: Date.now() + 86400000 };
      }
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

    // Address copies never grant access, even when the clipboard is unavailable.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw Error("Denied"); } } });
      document.execCommand = () => false;
    });
    await card.getByRole("button", { name: "Share Site" }).click();
    await page.screenshot({ path: testInfo.outputPath(`review-share-initial-${theme}.png`), fullPage: true, animations: "disabled" });
    const options = page.getByRole("button", { name: "Sharing options" });
    await options.click();
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    await options.click();
    await page.getByRole("menuitem", { name: "Copy personal address" }).click();
    await expect(page.getByRole("textbox", { name: "Link to Site" })).toHaveValue("https://preview.example.net/app/site");
    expect(await page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.share"))).toBe(false);
    await page.evaluate(() => { (window as any).shareError = true; });
    await page.getByRole("button", { name: "Copy share link" }).click();
    await expect(page.getByRole("alert")).toContainText("Machine unavailable");
    await page.evaluate(() => { (window as any).shareError = false; });
    await page.getByRole("button", { name: "Copy share link" }).click();
    await expect(page.getByRole("textbox", { name: "Link to Site" })).toHaveValue("https://preview.example.net/__bivy/open#shared");
    await page.screenshot({ path: testInfo.outputPath(`review-share-${theme}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await page.route("https://preview.example.net/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Storefront preview</h1>" }));
    await card.getByRole("button", { name: "Open preview", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Preview: Storefront" });
    await expect(preview.frameLocator("iframe").getByRole("heading")).toHaveText("Storefront preview");
    await page.screenshot({ path: testInfo.outputPath(`review-preview-${theme}.png`), fullPage: true, animations: "disabled" });
    await preview.getByRole("button", { name: "Share Site" }).click();
    await page.getByRole("button", { name: "Sharing options" }).click();
    await page.getByRole("menuitem", { name: "Revoke access…", exact: true }).click();
    await page.getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Access revoked\.$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview.locator("iframe")).toHaveCount(0);
    await expect(preview.getByRole("status")).toContainText("Access revoked");
    await preview.getByRole("button", { name: "App options" }).click();
    await expect(page.getByRole("dialog", { name: "Session apps" })).toBeVisible();
    await page.keyboard.press("Escape");

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

test("tapping a finished notification opens the live preview, and closing it leaves you on the card", async ({ page }) => {
  await page.route("https://preview.example.net/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Storefront preview</h1>" }));
  // The push lands on /sessions/<id>?review=<id>; the card arrives with the history.
  await page.evaluate((r) => {
    history.replaceState(history.state, "", `${location.pathname}?review=${r.id}`);
    (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: r.id, review: r } });
  }, review({ shot: shot("a") }));
  const preview = page.getByRole("dialog", { name: "Preview: Storefront" });
  await expect(preview.frameLocator("iframe").getByRole("heading")).toHaveText("Storefront preview");
  expect(await page.evaluate(() => (window as any).commands.find((c: any) => c.kind === "apps.open"))).toMatchObject({ viewId: "v".repeat(32), path: "/checkout" });
  expect(await page.evaluate(() => location.search)).toBe("");
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Storefront: changed in this run" })).toBeVisible();
});

test("opening a published preview skips discovery and sharing can close during a request", async ({ page }) => {
  await page.evaluate((r) => {
    const w = window as any;
    const command = w.c.appCommand;
    w.c.appCommand = (kind: string, ...args: unknown[]) => {
      if (kind === "apps.offers" || kind === "apps.share") return new Promise(() => {});
      return command(kind, ...args);
    };
    w.c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: r.id, review: r } });
  }, review({ screenshotsOff: true }));
  await page.route("https://preview.example.net/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Preview</h1>" }));
  await page.getByRole("button", { name: "Open preview", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Preview: Storefront" });
  await expect(preview.frameLocator("iframe").getByRole("heading")).toBeVisible();
  await preview.getByRole("button", { name: "Share Site" }).click();
  await page.getByRole("button", { name: "Copy share link" }).click();
  const share = page.getByRole("dialog", { name: "Share Site", exact: true });
  await share.getByRole("button", { name: "Close", exact: true }).click();
  await expect(share).toHaveCount(0);
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("long app histories defer offscreen screenshots and keep their loading footprint", async ({ page }) => {
  await page.evaluate((base) => {
    const w = window as any;
    const fetch = w.c.fetchAttachment;
    w.shotRequests = [];
    w.finishShots = [];
    w.c.fetchAttachment = (hash: string) => {
      w.shotRequests.push(hash);
      return new Promise(resolve => w.finishShots.push(async () => resolve(await fetch(hash))));
    };
    for (let i = 0; i < 30; i++) {
      const r = { ...base, id: `review-${i}`, viewId: `view-${i}`, shot: { hash: i.toString(16).padStart(64, "0"), width: 780, height: 1688, size: 10 } };
      w.c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: r.id, review: r } });
    }
  }, review({}));
  const card = page.locator(".review-card").last();
  await card.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => (window as any).shotRequests.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).shotRequests.length)).toBeLessThan(30);
  const shotButton = card.locator(".review-shot");
  const before = await shotButton.boundingBox();
  await page.evaluate(() => Promise.all((window as any).finishShots.map((finish: () => Promise<void>) => finish())));
  await expect(shotButton.locator("img")).toBeVisible();
  const after = await shotButton.boundingBox();
  expect(after!.height).toBeCloseTo(before!.height, 0);
});

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

for (const theme of themes) test(`reviewer notes and pictures only become a draft when you ask (${theme})`, async ({ page }, testInfo) => {
  await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
  await page.evaluate(() => {
    const w = window as any;
    const list = w.c.appCommand;
    const prefill = w.c.prefillComposer.bind(w.c);
    w.c.prefillComposer = (text: string, attachments: unknown[]) => { w.draftedAttachments = attachments; return prefill(text, attachments); };
    const notes = [
      { id: "n1", at: 1, note: "Pay button still hugs the edge on my iPhone mini", selector: "footer > button.pay", text: "Pay now", path: "/checkout", viewport: { width: 375, height: 667 } },
      { id: "n2", at: 2, note: "Total is cut off", selector: ".total", text: "", path: "/checkout", viewport: { width: 375, height: 667 }, context: "box around total", shot: { hash: "c".repeat(64), size: 100, width: 390, height: 844 } },
    ];
    w.c.appCommand = async (kind: string, sessionId: string, fields: Record<string, unknown> = {}) => {
      if (kind !== "apps.list") return list(kind, sessionId, fields);
      w.commands.push({ kind, sessionId, ...fields });
      return { apps: [{ id: "a".repeat(32), sessionId: "s", name: "Storefront", createdAt: 0, views: [{ id: "v".repeat(32), kind: "web", name: "Site", source: "static", notes }] }], previewAvailable: true };
    };
  });
  const send = (fields: Record<string, unknown>) => page.evaluate((r) => (window as any).c.store.apply({ type: "session.event", sessionId: "s", event: { type: "app_review", id: r.id, review: r } }), review(fields));

  await send({ trigger: "notes", notes: 2 });
  const card = page.getByRole("region", { name: "Storefront: reviewer notes" });
  await expect(card).toBeVisible();
  const notes = card.getByRole("group", { name: "Reviewer notes on Storefront · Site" });
  await expect(notes).toContainText("2 notes from people with a shared link");
  // A notes card is about the notes: no screenshot stage, no "turn on screenshots".
  await expect(card.locator(".review-stage")).toHaveCount(0);
  await expect(card.getByText("Turn on agent screenshots")).toHaveCount(0);
  // The card holds a count; the composer stays empty until you ask for the draft.
  await expect(page.locator("textarea").first()).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("review-card-notes.png"), fullPage: true });
  await card.getByRole("button", { name: "Preview card options for Storefront" }).click();
  await page.getByRole("menuitem", { name: "App options", exact: true }).click();
  const apps = page.getByRole("dialog", { name: "Session apps" });
  await expect(apps.getByText('“Total is cut off”')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`reviewer-notes-owner-${theme}.png`), fullPage: true, animations: "disabled" });
  await apps.getByRole("button", { name: "View approximate picture" }).click();
  await expect(page.getByRole("dialog", { name: /Image/ })).toBeVisible();
  await expect(page.locator('.image-viewer img')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(apps).toBeVisible();
  await page.keyboard.press("Escape");
  await notes.getByRole("button", { name: "Add to message" }).click();
  await expect(card.getByRole("status")).toContainText("Nothing is sent until you send it");
  await expect(page.locator("textarea").first()).toHaveValue(/Notes from people reviewing "Site":\n- "Pay button still hugs the edge on my iPhone mini" on footer > button\.pay \("Pay now"\)/);
  expect(await page.evaluate(() => (window as any).commands.some((c: any) => c.kind === "apps.share" || c.kind === "session.send"))).toBe(false);
  expect(await page.evaluate(() => (window as any).draftedAttachments)).toMatchObject([{ kind: "image", name: "Reviewer note (approximate).png", hash: "c".repeat(64) }]);
  expect(await page.evaluate(() => Boolean((window as any).draftedAttachments[0].data))).toBe(true);

  // Notes that ride on a run's visual card add the same row under the picture.
  await send({ id: "review-fedcba9876543210", trigger: "run", shot: shot("a"), notes: 1 });
  const run = page.getByRole("region", { name: "Storefront: changed in this run" });
  await expect(run.getByRole("img", { name: /Storefront at \/checkout, now/ })).toBeVisible();
  await expect(run.getByRole("group", { name: /Reviewer notes/ })).toContainText("1 note from people with a shared link");
});
