// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";

// The app preview's "Add to chat" (opened in a tab) lands on
// `/share?session=<id>&text=…`. The URL is rewritten before the controller is
// constructed, so the boot route it replays is that session — not a new chat.
test("a share landing for a session boots into that session with the draft", async ({ page, webApp }) => {
  await page.route("**/api/**", route => route.fulfill({ json: {} }));
  await page.route("**/src/mount.tsx", async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace("controller.connect();", "").replace("controller.installLifecycleHandlers();", "");
    await route.fulfill({ response, body: source });
  });
  await page.goto(`${webApp.origin}/share?session=s1&text=${encodeURIComponent("Fix the button")}`);
  await expect(page).toHaveURL(`${webApp.origin}/sessions/s1`);
  const boot = await page.evaluate(async () => {
    const [{ controller }, { readComposerDraft }] = await Promise.all([
      import("/src/store/useStore.ts" as string),
      import("/src/composerDraft.ts" as string),
    ]);
    return { route: controller.pendingRoute, draft: readComposerDraft(localStorage, "s1").text };
  });
  expect(boot).toEqual({ route: { kind: "session", id: "s1" }, draft: "Fix the button" });
});

// Android's share sheet POSTs a screenshot to /share; the service worker keeps
// it on the device (receiveShare, run here as the worker would) and opens the
// landing. Picking a session with an app preview lands the image as a real
// attachment, with a draft that names the preview and the page last viewed.
test("a shared screenshot lands as an attachment in the picked session, naming its preview", async ({ page, webApp }, testInfo) => {
  await page.route("**/api/**", route => route.fulfill({ json: {} }));
  await page.route("**/src/mount.tsx", async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace("controller.connect();", `
      controller.transport.send = async () => {};
      controller.store.setStatus("online");
      controller.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
      controller.store.apply({ type: "sessions.list", sessions: [
        { sessionId: "s1", name: "Checkout polish", runtimeId: "claude", agentName: "Claude Code", status: "saved", updatedAt: 2 },
        { sessionId: "s2", name: "API tidy", runtimeId: "claude", agentName: "Codex", status: "saved", updatedAt: 1 },
      ] });
      controller.listMachineApps = async () => ({ unreachable: [], items: [{ id: "${"a".repeat(32)}", sessionId: "s1", name: "Storefront", createdAt: 1,
        views: [{ id: "v", kind: "web", name: "Site", source: "service", lastPath: "/checkout" }] }] });
      window.controller = controller;`).replace("controller.installLifecycleHandlers();", "");
    await route.fulfill({ response, body: source });
  });
  await page.goto(`${webApp.origin}/sessions/new`);
  const landing = await page.evaluate(async () => {
    const { receiveShare } = await import("/src/shareInbox.ts" as string);
    const canvas = document.createElement("canvas"); canvas.width = 390; canvas.height = 844;
    const g = canvas.getContext("2d")!; g.fillStyle = "#1f5f4a"; g.fillRect(0, 700, 390, 60);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const form = new FormData();
    form.append("title", ""); form.append("text", "The pay button sits on the home bar");
    form.append("files", new File([blob], "IMG_2031.png", { type: "image/png" }));
    return receiveShare(new Request("/share", { method: "POST", body: form }), caches);
  });
  expect(landing).toMatch(/^\/share\?shared=[a-f0-9]{32}$/);
  await page.goto(`${webApp.origin}${landing}`);
  const sheet = page.getByRole("dialog", { name: "Choose where to send the shared screenshot" });
  await expect(sheet.getByRole("img", { name: "IMG_2031.png" })).toBeVisible();
  await expect(sheet).toContainText("The pay button sits on the home bar");
  const pick = sheet.getByRole("listitem").filter({ hasText: "Checkout polish" });
  await expect(pick).toContainText("Storefront preview · /checkout");
  await page.screenshot({ path: testInfo.outputPath("share-destinations.png") });
  await pick.click();
  await expect(page).toHaveURL(/\/sessions\/s1$/);
  await expect(page.getByRole("button", { name: "View IMG_2031.png" })).toBeVisible();
  await expect(page.locator(".composer-input")).toHaveValue("Shared a screenshot — compare it with the Storefront preview (/checkout).\n\nThe pay button sits on the home bar");
  // Placed: the device's copy is gone.
  await expect.poll(() => page.evaluate(async () => (await (await caches.open("bivy-share-inbox")).keys()).length)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("share-landed.png") });
});
