# Tests

Every test runs on every PR that touches its area, so each one must earn its
place. A test stays only if **all five** hold:

1. **It protects something real** — behavior a user or operator would notice, a
   security or data-loss invariant, or a documented past regression.
2. **It asserts what real code does** — not source text, copied markup,
   YAML/config shape, or copy wording.
3. **Nothing cheaper already asserts it** — types, lint, `pnpm run check:*`, or
   another test.
4. **It runs at the lowest level that can observe the behavior** — pure function
   over module, module over process, process over browser.
5. **One case per distinct code path**, not per permutation of inputs, themes
   or viewports.

Where tests live:

- `test/*.test.ts` — node suites, one per module; `pnpm run test:unit`.
  Pass filename substrings to run a subset: `pnpm run test:unit -- config-cli`.
- `packages/core` — vitest; `pnpm run test:core`.
- `services/*/test` — each service's own suites.
- `test/browser` — Chromium, only for what needs a browser (see its README).
- Repository rules that are not behavior (design tokens, retired classes, module
  boundaries, route collisions and auth order) are data rows in
  `scripts/check-*.mjs`, not tests.
