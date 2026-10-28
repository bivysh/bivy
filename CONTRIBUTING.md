# Contributing to Bivy

Thanks for helping improve Bivy.

## First: does it need to be in Bivy?

Most things people want from Bivy can be a **plugin** on their own machine — a
chat widget, a tool, a theme, a guide, another agent — built and installed by
their agent in a session, with no pull request and no wait
([plugins](docs/plugins.md), `bivy guide extend-bivy`). If you made one others
would like, push it to a repository with the `bivy-plugin` topic; anyone can
then `bivy plugin install github:you/repo`.

Contribute here when the change is a fix, something every user should get, or
a seam plugins cannot reach yet.

## Contribute with your agent

```bash
bivy contribute 1234      # a checkout of bivysh/bivy, a branch, and an agent session on the issue
pnpm install
pnpm dev:all              # a node from this checkout + the web app, on their own port and data dir
```

`bivy contribute` uses the checkout you are in (or clones one), branches from
`origin/main`, and starts a chat session whose first message is the issue and
this repository's rules; `bivy guide contribute` is the playbook the agent
follows. `pnpm dev:all` prints the app's URL.

## Good first changes are rows

The code prefers data to branches, so a first change is often one row in a
table, with the rule written at the top of the file:

| To add | Edit |
|---|---|
| An agent | `src/agents/profiles.ts` (or a plugin: `bivy plugin init --kind agent`) |
| A stream parser for a CLI agent's output | `src/runtime/cli-parsers.ts` and the parser ids in `src/plugin-sdk/manifest.ts` |
| A built-in integration (an authenticated API as tools) | `src/integrations/registry.ts` |
| A component an agent can place in a message | `componentKind` in `packages/core/src/message-components.ts` and the registry in `packages/web/src/components/MessageComponent.tsx` |
| A widget protocol method | the request table in `packages/web/src/widgets/host.ts` |
| A plugin contribution type | `CONTRIBUTION_TYPES` in `src/plugin-sdk/manifest.ts` |
| A desktop theme source | `THEME_SOURCES` in `src/machine-theme.ts` |
| A `bivy` command | `bin/cli-commands.mjs`, then `docs/cli-reference.md` (`pnpm run check:cli`) |
| An agent playbook | a markdown file in `bin/guides/` |
| A per-agent doc | `docs/agents/` |

Issues labelled `good first issue` are a place to start; `bivy contribute
<issue>` sets your agent up on one.

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
  the core suite, the web build, the release archives checked on
  Linux, the browser suite when the app changes (split across three), and the
  packaging, clean-installer and remote e2e lanes when their inputs change.
- **The queue reuses a green PR run** when it would test the exact same tree —
  that is, when main has not moved since the PR's last run. It then passes in
  seconds (the `verified` tier). If main has moved, the queue runs the checks
  again on the combined result.
- **Nightly, releases, queued release commits, and any change to `ci.yml`** run
  everything, adding the macOS certification and macOS archive lanes. A failed
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

## Sign off your commits

Bivy takes contributions under the [Developer Certificate of
Origin](DCO.md): each commit needs a `Signed-off-by` line, which `git commit -s`
writes for you. There is no copyright assignment and nothing to register — you
keep the copyright in your work, licensed to everyone under the MIT license like
the rest of the code. The DCO check on your pull request confirms it.

## Trademarks

The code is MIT, but the Bivy name and logo are covered by the
[trademark policy](TRADEMARKS.md) — a permissive code license is not a
trademark license.
