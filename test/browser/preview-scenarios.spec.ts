// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "./fixtures.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { AppRegistry } from "../../src/apps/registry.js";
import { AppGateway } from "../../src/apps/gateway.js";

const SHOP = {
  "index.html": '<!doctype html><html lang="en"><title>Shop</title><h1>Shop</h1><a href="/checkout.html">Go to checkout</a><script>localStorage.setItem("seen","1")</script></html>',
  "checkout.html": `<!doctype html><html lang="en"><title>Checkout</title><h1>Checkout</h1>
<label>Email <input id="email"></label><button id="pay">Pay $172</button><output id="result"></output>
<script>document.getElementById("pay").onclick=async()=>{const r=await fetch("/api/payments",{method:"POST"});const out=document.getElementById("result");out.textContent=r.ok?"Paid":"Payment failed: "+r.status;out.className=r.ok?"paid":"failed";};</script></html>`,
};
const SCENARIOS = {
  "payment-api-down.json": {
    name: "Payment API down", description: "Checkout while payments fail", open: "/", fresh: true,
    steps: [{ click: "text=Go to checkout" }, { fill: "#email", with: "ada@example.com" }, { click: "text=Pay" }, { wait: "#result.failed" }],
    network: [{ match: "POST /api/payments", status: 503, json: { error: "down" } }],
  },
  "stale.json": { name: "Old checkout", open: "/checkout.html", steps: [{ click: "text=Place order" }] },
};

// The whole loop a person goes through: a review card's "Try it" opens the
// preview already in a scenario; the pill says which one and what's simulated;
// Reset runs it again; a scenario whose step no longer works says which step
// and drafts the fix; "Your data" leaves it.
test("scenarios open the live app in a state, reset it, explain a broken one, and let you leave", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bivy-scenarios-browser-"));
  const registry = new AppRegistry();
  const gateway = new AppGateway(registry, "https://{app}.preview.example.net", () => ["https://bivy.example"]);
  gateway.server.listen(0, "127.0.0.1"); await once(gateway.server, "listening");
  const port = (gateway.server.address() as { port: number }).port;
  try {
    await fs.mkdir(path.join(dir, "dist")); await fs.mkdir(path.join(dir, ".bivy/scenarios"), { recursive: true });
    for (const [name, body] of Object.entries(SHOP)) await fs.writeFile(path.join(dir, "dist", name), body);
    for (const [name, body] of Object.entries(SCENARIOS)) await fs.writeFile(path.join(dir, ".bivy/scenarios", name), JSON.stringify(body));
    const id = registry.publish("s", dir, { version: 1, name: "Shop", views: [{ kind: "web", name: "Shop", source: { kind: "static", directory: "dist" } }] }).views[0].id;
    await page.route("https://*.preview.example.net/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, headers: { ...await request.allHeaders(), host: url.host }, maxRedirects: 0 }).catch(() => undefined);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    await page.route("https://bivy.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Bivy chat</h1>" }));
    const app = page.frameLocator('iframe[title="Shop"]');
    const switcher = page.getByRole("button", { name: /Choose a scenario/ });

    // "Try it" on a review card: the open link carries the scenario.
    await page.goto(`${gateway.open(id, "https://bivy.example/sessions/s")}~~payment-api-down`);
    await expect(app.locator("#result")).toHaveText("Payment failed: 503");
    await expect(app.locator("#email")).toHaveValue("ada@example.com");
    await expect(switcher).toHaveAccessibleName("Scenario: Payment API down, simulated. Choose a scenario");
    await expect(page.locator("#scn-sub")).toHaveText("Simulated: POST /api/payments → 503");
    await page.screenshot({ path: testInfo.outputPath("in-scenario.png") });
    const light = await switcher.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: "dark" });
    // Settled, not mid-transition: the same dark colour twice in a row.
    let last = light;
    await expect.poll(async () => { const now = await switcher.evaluate((element) => getComputedStyle(element).backgroundColor); const settled = now === last && now !== light; last = now; return settled; }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("in-scenario-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    // Reset: back to its first page, then through its steps again.
    await app.locator("#email").fill("someone@else.com");
    await page.getByRole("button", { name: "Reset Payment API down" }).click();
    await expect(app.locator("#email")).toHaveValue("ada@example.com");
    await expect(app.locator("#result")).toHaveText("Payment failed: 503");

    // The switcher lists what there is, including what needs a fix.
    await switcher.click();
    const sheet = page.getByRole("region", { name: "Scenarios" });
    await expect(sheet.getByRole("button", { name: /Payment API down/ })).toHaveAttribute("aria-current", "true");
    await expect(sheet.getByRole("button", { name: /Your data/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("switcher.png") });

    // A step that no longer finds its button says which, and keeps you where you got to.
    await sheet.getByRole("button", { name: /Old checkout/ }).click();
    const failure = page.getByRole("alertdialog", { name: "Couldn’t finish “Old checkout”" });
    await expect(failure).toContainText("Step 1 (click text=Place order): Couldn’t find “text=Place order” within 5 seconds.", { timeout: 10_000 });
    await expect(failure).toContainText("You’re on /checkout.html");
    await page.screenshot({ path: testInfo.outputPath("broken-step.png") });
    await failure.getByRole("button", { name: "Stay here" }).click();
    await expect(failure).toBeHidden();

    // "Your data": no scenario, nothing simulated.
    await switcher.click();
    await sheet.getByRole("button", { name: /Your data/ }).click();
    await expect(switcher).toHaveAccessibleName("Choose a scenario");
    await expect(page.locator("#scn-sub")).toHaveText("2 scenarios");
    await app.getByRole("button", { name: "Pay $172" }).click();
    await expect(app.locator("#result")).toHaveText("Payment failed: 405");

    // Ask agent to fix drafts a message naming the file and the failed step.
    await switcher.click();
    await sheet.getByRole("button", { name: /Old checkout/ }).click();
    await failure.getByRole("button", { name: "Ask agent to fix" }).click({ timeout: 10_000 });
    await expect(page).toHaveURL(/^https:\/\/bivy\.example\/share\?session=s&text=/);
    expect(decodeURIComponent(new URL(page.url()).searchParams.get("text")!)).toContain(".bivy/scenarios/stale.json");
  } finally { gateway.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
