// SPDX-License-Identifier: MIT
import { expect, test } from "./fixtures.js";

// A session the control plane no longer accepts (signed out elsewhere, or the
// account was deleted) signs the tab out, instead of leaving cached sessions
// and a machine that never answers. (This test server has no hosted sign-in
// page, so the session being cleared is what shows it.)
test("a tab whose session has ended signs out", async ({ page, webApp }) => {
  await page.addInitScript(() => {
    // Seed once: signing out reloads the page, which runs this again.
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("bivy_session", "sess_deleted_account");
    localStorage.setItem("bivy_cp", location.origin);
    localStorage.setItem("bivy_cur", "eph-managed-auto-gone");
  });
  for (const url of ["**/account/**", "**/sessions", "**/devices"]) await page.route(url, route => route.fulfill({ json: [] }));
  let logouts = 0;
  await page.route("**/auth/logout", route => { logouts++; return route.fulfill({ json: { ok: true } }); });
  await page.route("**/nodes", route => route.fulfill({ status: 401, json: { error: "Unauthorized" } }));
  await page.goto(webApp.origin);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("bivy_session")), { timeout: 20_000 }).toBeNull();
  expect(logouts).toBe(1);
});
