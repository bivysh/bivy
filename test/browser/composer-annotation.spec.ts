// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

// A marked-up preview (Draw) or a shared screenshot reaches the composer as
// the user's own attachment: the same thumbnail chip, expandable and
// removable, sent with the prompt like any image the user adds.
let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in composer fixture" } }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    const w = window as any;
    w.c = c; w.sent = [];
    c.transport.close();
    c.transport.send = async (command: any) => { w.sent.push(command); };
    c.store.setError("");
    c.store.setStatus("online");
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Checkout polish", runtimeId: "claude", status: "saved" }] });
    c.openSession("s");
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [{ role: "user", content: "Tidy the checkout" }] });
  });
  await expect(page.locator(".composer-input")).toBeVisible();
});

for (const theme of themes) {
  test(`a marked-up picture lands as an attachment chip next to the user's words (${theme})`, async ({ page }, testInfo) => {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 390; canvas.height = 844;
      const g = canvas.getContext("2d")!; g.fillStyle = "#f4f1ea"; g.fillRect(0, 0, 390, 844);
      g.strokeStyle = "#ff2d78"; g.lineWidth = 8; g.strokeRect(20, 700, 350, 80);
      const data = canvas.toDataURL("image/png").split(",")[1]!;
      (window as any).c.prefillComposer("Give this more room\n\nIn the app preview \"Checkout\" (page /, viewport 390×844), marked:\n- #pay (\"Pay now\")",
        [{ kind: "image", name: "Checkout marked (approximate).png", mimeType: "image/png", data, size: data.length }]);
    });
    const composer = page.locator(".composer-input");
    await expect(composer).toHaveValue(/^Give this more room\n\nIn the app preview "Checkout"/);
    const chip = page.getByRole("button", { name: "View Checkout marked (approximate).png" });
    await expect(chip).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`composer-annotation-${theme}.png`) });
    await chip.click();
    await expect(page.getByRole("dialog").getByRole("img", { name: "Attachment preview" })).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();

    // Sent with the prompt, like any image the user adds.
    await page.getByRole("button", { name: /^Send/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).sent.find((c: any) => c.kind === "prompt")?.attachments?.map((a: any) => a.name))).toEqual(["Checkout marked (approximate).png"]);
  });
}

test("the attachment can be removed, keeping the words", async ({ page }) => {
  await page.evaluate(() => (window as any).c.prefillComposer("Look at this", [{ kind: "image", name: "Checkout marked.png", mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 }]));
  await page.getByRole("button", { name: "Remove Checkout marked.png" }).click();
  await expect(page.getByRole("button", { name: "View Checkout marked.png" })).toHaveCount(0);
  await expect(page.locator(".composer-input")).toHaveValue("Look at this");
});
