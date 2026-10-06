// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, themes, type WebApp } from "./fixtures.js";

let url: string;
test.beforeAll(async ({ webApp }: { webApp: WebApp }) => { url = webApp.origin; });

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/.*/, () => {});
  for (const endpoint of ["auth/bootstrap", "sessions", "auth/credentials/account-export", "models", "runtimes", "stt/config"]) {
    await page.route(new RegExp(`/api/${endpoint}(?:\\?|$)`), (route) => route.fulfill({ status: 503, json: { error: "Daemon offline in files fixture" } }));
  }
  await page.goto(url);
  await page.evaluate(async () => {
    const { controller: c } = await import(/* @vite-ignore */ "/src/store/useStore.ts" as string);
    const w = window as any;
    w.c = c; w.commands = [];
    c.transport.close();
    c.transport.send = async () => {};
    c.store.setStatus("online");
    const listings: Record<string, unknown> = {
      "": { path: "", git: true, entries: [
        { name: "src", path: "src", type: "dir", changed: 2 },
        { name: "test", path: "test", type: "dir" },
        { name: "package.json", path: "package.json", type: "file", size: 812 },
        { name: "README.md", path: "README.md", type: "file", size: 2048, status: "modified" },
      ] },
      src: { path: "src", git: true, entries: [
        { name: "coupon.ts", path: "src/coupon.ts", type: "file", size: 240, status: "added" },
        { name: "legacy.ts", path: "src/legacy.ts", type: "file", status: "deleted" },
        { name: "orders.ts", path: "src/orders.ts", type: "file", size: 1400 },
      ] },
      test: { path: "test", git: true, entries: [] },
    };
    c.fileCommand = async (kind: string, sessionId: string, path: string) => {
      w.commands.push({ kind, sessionId, path });
      if (kind === "files.list") return listings[path];
      return { file: { path, size: 240, mtime: Date.now() - 120_000, status: "added", kind: "text", truncated: false,
        content: "export function isExpired(coupon: { expiresAt: Date | null }, now = new Date()): boolean {\n  return coupon.expiresAt !== null && coupon.expiresAt < now;\n}\n" } };
    };
    c.store.apply({ type: "runtimes.list", runtimes: [{ id: "claude", name: "Claude", status: "available" }] });
    c.store.apply({ type: "sessions.list", sessions: [{ sessionId: "s", name: "Expire coupons", runtimeId: "claude", status: "saved" }] });
    c.openSession("s");
    c.store.apply({ type: "session.history", sessionId: "s", runtimeId: "claude", messages: [{ role: "user", content: "Reject expired coupons." }] });
  });
});

// The workspace opens from the session menu; folders load as they open, the
// uncommitted work is marked, "Changed" narrows to it, and a file reads in place.
test("browse the session's workspace and read a file the agent added", async ({ page }, testInfo) => {
  for (const theme of themes) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const wide = (page.viewportSize()?.width ?? 0) >= 1200;
    if (wide) {
      if (!(await page.getByRole("tab", { name: "Files" }).isVisible())) await page.getByRole("button", { name: /Show changes, files/ }).click();
      await page.getByRole("tab", { name: "Files" }).click();
    } else {
      await page.getByRole("button", { name: "Session actions" }).click();
      await page.getByRole("menuitem", { name: "Browse files" }).click();
    }
    const files = page.getByRole(wide ? "tabpanel" : "dialog");
    await expect(files.getByText("3 uncommitted changes")).toBeVisible();
    await expect(files.getByRole("button", { name: "README.md" })).toContainText("Modified");

    await files.getByRole("button", { name: /^src\// }).click();
    await expect(files.getByRole("button", { name: /legacy\.ts/ })).toBeDisabled();
    await files.getByRole("button", { name: "Changed", exact: true }).click();
    await expect(files.getByRole("button", { name: /orders\.ts/ })).toHaveCount(0);
    await expect(files.getByRole("button", { name: "package.json" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`files-tree-${theme}.png`) });

    await files.getByRole("button", { name: /coupon\.ts/ }).click();
    await expect(files.getByLabel("Contents of src/coupon.ts")).toContainText("isExpired");
    await expect(files.getByText("3 lines")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`files-viewer-${theme}.png`) });
    await files.getByRole("button", { name: "Back to files" }).click();
    await expect(files.getByRole("button", { name: /coupon\.ts/ })).toBeVisible();
    await files.getByRole("button", { name: "All", exact: true }).click();
    await files.getByRole("button", { name: /^src\// }).click();
    if (!wide) await page.keyboard.press("Escape");
  }
  const kinds = await page.evaluate(() => (window as any).commands.map((c: any) => `${c.kind}:${c.path}`));
  expect(kinds).toContain("files.read:src/coupon.ts");
});
