// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebApp } from "./fixtures.js";

let server: WebApp;
let origin: string;
test.beforeAll(async ({ webApp }) => {
  server = webApp;
  origin = webApp.origin;
});

test("enrollment selects the claimed machine, not another online machine", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("bivy_session", "sess_fixture");
    localStorage.setItem("bivy_cp", location.origin);
  });
  for (const url of ["**/account/**", "**/sessions", "**/devices"]) await page.route(url, route => route.fulfill({ json: [] }));
  let online = false;
  await page.route("**/nodes", route => route.fulfill({ json: [
    { id: "old", name: "Existing machine", online: true },
    { id: "new", name: "New machine", online },
  ] }));
  const claim = { id: "claim", status: "pending", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), command: "curl -fsSL https://bivy.sh/install.sh | BIVY_NODE_CLAIM_CODE=fixture bash" };
  let used = false;
  let failPolling = false;
  await page.route("**/account/node-claims", route => {
    if (route.request().method() === "POST") return route.fulfill({ json: claim });
    if (failPolling) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: [{ ...claim, status: used ? "used" : "pending", ...(used ? { nodeId: "new" } : {}) }] });
  });
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/store/useStore.ts";
    const { controller } = await import(module);
    controller.switchNode = (id: string) => { document.body.dataset.selectedNode = id; };
  });
  failPolling = true;
  await expect(page.getByRole("alert")).toContainText("Retrying automatically", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible();
  failPolling = false;
  used = true;
  await expect(page.getByText("Machine enrolled. Waiting for it to come online…")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Copy install command" })).toHaveCount(0);
  expect(await page.locator("body").getAttribute("data-selected-node")).toBeNull();
  online = true;
  await expect(page.locator("body")).toHaveAttribute("data-selected-node", "new", { timeout: 10_000 });
});
