import { expect, test } from "./fixtures.js";

// Use a routed document so these checks need neither Vite nor a backend.
test.beforeEach(async ({ page }) => {
  await page.route("http://browser-fixture.test/", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>API isolation</title>",
  }));
  await page.goto("http://browser-fixture.test/");
});

test("notification preferences have an explicit background-read fixture", async ({ page }) => {
  const preferences = await page.evaluate(async () =>
    (await (await fetch("/api/push/preferences")).json()).preferences);
  expect(preferences.session_done).toBe(true);
  expect(Object.keys(preferences)).toHaveLength(6);
});

test("individual specs can model intentional API failures", async ({ page }) => {
  await page.route("**/api/push/preferences", route => route.fulfill({ status: 503, json: { error: "offline" } }));
  expect(await page.evaluate(async () => (await fetch("/api/push/preferences")).status)).toBe(503);
});

test("unmocked requests fail even when the app ignores the response", async ({ page }) => {
  // Expected failure comes from the fixture's teardown assertion. If that guard
  // stops working, Playwright reports this test as an unexpected pass.
  test.fail();
  await page.evaluate(async () => { await fetch("/api/missing-mock"); });
});
