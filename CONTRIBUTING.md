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
# only suites that depend on what your branch changed (what PR CI runs)
TEST_AFFECTED_BASE=origin/main pnpm run test:unit
```

`TEST_SHARD=1/2` splits the suite across machines. Set `TEST_CONCURRENCY=1`
when debugging ordering or port issues locally.

UI/UX work for the hosted/mobile PWA should target the React client in `packages/web/` (`@bivy/web`), which is served by the control plane. The node daemon hosts no web UI.

## CI checks

CI runs on GitHub Actions (`.github/workflows/ci.yml`) in three tiers, each
path-filtered to the areas your change touches:

- **Pull requests:** one job with lint, typechecks, policy checks, and only the
  unit suites that depend on your change.
- **Merge queue:** every unit suite, the web build, the release package, and a
  desktop browser smoke set, plus packaging and remote e2e when their inputs change.
- **Nightly, releases, queued release commits, and any change to `ci.yml`:** everything, including
  macOS, clean-installer, every browser spec (plus the layout-sensitive mobile set), and remote e2e.
  A failed nightly opens or updates a "Nightly full CI is failing" issue.

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
