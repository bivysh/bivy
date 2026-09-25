# Browser tests

The rules in [`test/README.md`](../README.md) apply. Use Chromium only when the
behavior depends on a browser: real component interaction, focus and history,
layout and overflow, storage across reloads, service workers, browser security,
or pixels. If a check only reads controller state or a function's output, it is
a node test in `test/*.test.ts`.

- Test real app code and real styles. Inline replicas only test the replica.
- Projects in `playwright.config.ts` supply viewports: `singleViewport` specs run
  once; a spec runs on mobile when it is in `mobileSpecs`, and on mobile alone
  when in `mobileOnlySpecs`. Do not add a width matrix inside a spec.
- Behavior specs loop over `themes` (light in CI; `PW_THEMES=light,dark`
  locally). `screenshots.spec.ts` owns the light + dark pixel contract.
- For timers, install Playwright's clock before the app creates them and advance
  it instead of sleeping.
