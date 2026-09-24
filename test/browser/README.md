# Browser test budget

Use Chromium when the regression depends on browser behavior: real component
interaction, focus/history, layout/overflow, storage across reloads, service
workers, or browser security. Do not put every business-rule permutation here.

- Pure state/formatting/routing rules belong in `test/*.test.ts` or the
  browser-free `test/web-contracts` project. Do not repeat unit assertions inside
  a page just to inspect the same result through a DOM element.
- Source-string checks belong in `test/web-contracts`, without Vite hooks.
- Test real app code or real styles. Inline replicas of app behavior only test
  the replica and should not be added as regression coverage.
- Desktop/mobile projects already supply viewport and input-mode coverage.
  Do not add a second width matrix inside those projects.
- Viewport-independent browser checks run once via `singleViewport` in
  `playwright.config.ts`. Keep both projects when there is a distinct mobile
  interaction or layout assertion.
- Repeat themes for appearance checks, not startup/configuration rules. Express
  model/credential/state variations explicitly rather than tying them to theme.
- For timer-driven scenarios, install Playwright's clock before application
  timers are created and advance it instead of sleeping. Keep the assertions
  that prove timeout, cancellation, polling, and delayed-cleanup behavior.

Keep screenshots, mobile keyboard/focus interactions, and real user journeys.
Reduce redundant executions rather than skipping failures or raising timeouts.
