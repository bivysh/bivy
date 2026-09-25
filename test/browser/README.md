# Browser test budget

Use Chromium when the regression depends on browser behavior: real component
interaction, focus/history, layout/overflow, storage across reloads, service
workers, or browser security. Do not put every business-rule permutation here.

- Pure state/formatting/routing rules belong in `test/*.test.ts` or the
  browser-free `test/web-contracts` project. Do not repeat unit assertions inside
  a page just to inspect the same result through a DOM element.
- Source-string checks belong in `test/web-contracts`, without Vite hooks, and
  only for invariants nothing else can express (security, trust copy, a past
  regression). Design-system migrations are rows in
  `scripts/check-design-tokens.mjs`; copy and class names are not contracts.
- Test real app code or real styles. Inline replicas of app behavior only test
  the replica and should not be added as regression coverage.
- Desktop/mobile projects already supply viewport and input-mode coverage.
  Do not add a second width matrix inside those projects.
- Every spec runs on every PR that touches the app, so each test must earn its
  place. Viewport-independent checks run once via `singleViewport`; a spec runs
  on mobile only when it is in `mobileSpecs`, and on mobile alone when it is in
  `mobileOnlySpecs` (its mobile run already covers desktop). Behavior specs loop
  over `themes` (light in CI); `screenshots.spec.ts` owns light + dark pixels.
- If a check only reads controller state or a pure function's output, write a
  node test in `test/*.test.ts` instead (see `test/pwa-install.test.ts`).
- Repeat themes for appearance checks, not startup/configuration rules. Express
  model/credential/state variations explicitly rather than tying them to theme.
- For timer-driven scenarios, install Playwright's clock before application
  timers are created and advance it instead of sleeping. Keep the assertions
  that prove timeout, cancellation, polling, and delayed-cleanup behavior.

Keep screenshots, mobile keyboard/focus interactions, and real user journeys.
Reduce redundant executions rather than skipping failures or raising timeouts.
