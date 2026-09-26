# Contributing to Bivy

Thanks for helping improve Bivy.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test:unit
```

During development, pass filename substrings to run only the relevant suites:

```bash
pnpm run test:unit -- config-cli plugin-cli
pnpm run test:unit -- --list config-cli
```

Or run only the suites your change can reach, via the import graph:

```bash
pnpm run test:unit -- --changed-since origin/main
```

`TEST_SHARD=1/2` splits the suite across machines. Set `TEST_CONCURRENCY=1`
when debugging ordering or port issues locally.

Suites run under `scripts/ts-loader.mjs` rather than `tsx`, which keeps the
per-process startup cost low across ~300 short-lived suites. It caches
transformed output under `node_modules/.cache/`, keyed by content, so it never
serves a stale result. If a suite ever behaves differently under it, run with
`BIVY_TEST_LOADER=tsx` and please report the difference.

UI/UX work for the hosted/mobile PWA should target the React client in `packages/web/` (`@bivy/web`), which is served by the control plane. The node daemon hosts no web UI.

## CI checks

CI runs on GitHub Actions (`.github/workflows/ci.yml`), path-filtered to the
areas your change touches:

- **Pull requests and the merge queue run the same checks**, in parallel lanes:
  lint, typechecks, policy checks, the unit suites (split across four runners),
  the core suite, the web build, the release package and a fresh npm consumer on
  Linux, the browser suite when the app changes (split across three), and the
  packaging, clean-installer and remote e2e lanes when their inputs change.
- **One difference between the two**, and it is deliberate: on a pull request the
  unit lanes run only the suites your change can reach through the import graph
  (`scripts/select-tests.mjs`), while the merge queue always runs every suite. So
  a green PR can still meet a failure in the queue if the selection was too
  narrow — that is the trade for fast feedback, and it cannot let a regression
  through, because nothing merges without the full run.
- **Nightly, releases, queued release commits, and any change to `ci.yml`** run
  everything, adding the macOS certification and npm-consumer lanes. A failed
  nightly opens or updates a "Nightly full CI is failing" issue.

Browser behavior specs run in light theme only; `test/browser/screenshots.spec.ts`
owns the light + dark visual contract. Set `PW_THEMES=light,dark` to get dark
review screenshots from every spec locally.

There is no local pre-push gate; run the checks yourself before pushing when you
want a fast local signal:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run check:links
```

## Pull requests

- Keep changes focused and small.
- Add or update tests for behavior changes.
- Update docs when changing user-visible behavior.
- Do not commit secrets, tokens, private deployment details, or customer/user data.

## Certificate of Origin

By contributing, you certify that you have the right to submit your contribution under this project's license and agree to the Developer Certificate of Origin 1.1. Use signed-off commits when possible:

```bash
git commit -s
```
