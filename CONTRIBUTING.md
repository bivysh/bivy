# Contributing to Bivy

Thanks for helping improve Bivy.

## Development

```bash
npm install
npm run typecheck
npm run test:unit
```

UI/UX work for the hosted/mobile PWA should target the React client in `packages/web/` (`@bivy/web`), which is served at the root on both the control plane and the node daemon.

## CI checks

CI runs on GitHub Actions (`.github/workflows/ci.yml`) for every push and pull
request — lint, typecheck, core/unit tests, control-plane, relay, and the remote
e2e suites, path-filtered to the areas your change touches. There is no local
pre-push gate; run the checks yourself before pushing when you want a fast local
signal:

```bash
npm run lint
npm run typecheck
npm run test:unit
```

## Pull requests

- Keep changes focused and small.
- Add or update tests for behavior changes.
- Update docs when changing user-visible behavior.
- Do not commit secrets, tokens, private deployment details, or customer/user data.

## License of your contribution

Bivy is licensed under the Functional Source License, version 1.1, with Apache
2.0 as the future license (FSL-1.1-ALv2) — see [LICENSE](LICENSE). Each
release converts to Apache-2.0 two years after it ships.

By submitting a contribution, you agree it is licensed to the project under
those same terms: FSL-1.1-ALv2 today, converting to Apache-2.0 on the same
two-years-after-release schedule as the rest of the codebase. You retain
copyright in your contribution.

## Certificate of Origin

By contributing, you certify that you have the right to submit your contribution under this project's license and agree to the Developer Certificate of Origin 1.1. Use signed-off commits when possible:

```bash
git commit -s
```
