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

CI splits the complete root suite across machines with `TEST_SHARD=1/2` and
`TEST_SHARD=2/2`. Set `TEST_CONCURRENCY=1` when debugging ordering or port
issues locally.

UI/UX work for the hosted/mobile PWA should target the React client in `packages/web/` (`@bivy/web`), which is served by the control plane. The node daemon hosts no web UI.

## CI checks

CI runs on GitHub Actions (`.github/workflows/ci.yml`) for every push and pull
request — lint, typecheck, core/unit tests, a docs link checker, control-plane,
relay, and the remote e2e suites, path-filtered to the areas your change
touches. There is no local pre-push gate; run the checks yourself before
pushing when you want a fast local signal:

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
