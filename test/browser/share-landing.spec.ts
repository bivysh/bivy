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
