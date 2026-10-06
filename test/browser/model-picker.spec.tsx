// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let server: Server, url: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../fixtures/composer-model-picker.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    nodePaths: [fileURLToPath(new URL("../../packages/web/node_modules", import.meta.url))],
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
  });
  const css = await readFile(new URL("../../packages/ui/tokens.css", import.meta.url), "utf8")
    + await readFile(new URL("../../packages/web/src/styles.css", import.meta.url), "utf8");
  server = createServer((request, response) => {
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(result.outputFiles[0]!.text); }
    else { response.setHeader("Content-Type", "text/html"); response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(() => { server?.closeAllConnections(); server?.close(); });

for (const theme of (process.env.PW_THEMES || "light").split(",")) {
  test(`live ACP models enable the real draft picker despite a false catalog flag (${theme})`, async ({ page }) => {
    await page.goto(url);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const pill = page.locator('button[title^="Model:"]');
    await expect(pill).toBeEnabled();
    await pill.focus();
    await expect(pill).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByPlaceholder("Search models…")).toBeVisible();
    await page.getByRole("button", { name: /Model B/ }).click();
    await expect(pill).toContainText("Model B");
    await expect(page.getByPlaceholder("Search models…")).toHaveCount(0);
    await pill.click();
    await expect(page.getByPlaceholder("Search models…")).toBeVisible();
    await expect(page.getByRole("button", { name: /Model A/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("model-picker.png"), fullPage: true, animations: "disabled" });
  });
}

test("pending launch still waits for its destination catalog", async ({ page }) => {
  await page.goto(url + "?pending=1");
  await expect(page.locator('button[title^="Choose a model after startup"]')).toBeDisabled();
});

for (const query of ["?scope=other-agent", "?unconfigured=1", "?empty=1"]) {
  test(`unsupported runtime does not borrow unavailable models: ${query}`, async ({ page }) => {
    await page.goto(url + query);
    await expect(page.locator('button[title="This agent uses its own default model"]')).toBeDisabled();
  });
}
