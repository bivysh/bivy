# Contribute to Bivy itself

Summary: When a change belongs in Bivy for everyone, not in a plugin: set up the repo, make a small checked change, and open a pull request with the user.

First ask whether this is a plugin. A widget, tool, theme, guide or agent the
user wants for themselves goes in a plugin on their machine, today, with no
review (`bivy guide extend-bivy`). Contribute to Bivy when the change is a
fix, or something every user should get, or a seam plugins cannot reach yet.

## Set up

    bivy contribute 1234            # an issue: checkout, branch, and this task
    bivy contribute --no-start      # just the checkout and branch, printed

It uses the Bivy checkout you are in, or clones `bivysh/bivy` to `~/src/bivy`,
and makes `contrib/<issue>-<slug>` from `origin/main`. Then:

    pnpm install
    pnpm dev:all                    # node + web app on this machine, if the change shows

## Make the change

Read `AGENTS.md`, `CONTRIBUTING.md` and `test/README.md` before writing code.
The repo prefers data to branches: most first changes are a row in a table —
an agent profile, a stream parser, an integration, a component kind, a guide,
a CLI command — and the file says so at the top. Keep the change small and
match the code around it. UI work follows `packages/web/AGENTS.md` and the
design tokens; render it and look at it in light and dark.

## Check it

    pnpm run lint
    pnpm run typecheck
    pnpm run test:unit -- --changed-since origin/main
    pnpm run check:design           # UI work
    pnpm run check:cli              # a CLI command or guide

Add a CHANGELOG entry under `## [Unreleased]` saying what changed for the user.

## Hand it over

Show the user the diff and what you checked. With their go-ahead, commit with a
sign-off (`git commit -s`, required by the DCO check), push to their fork
(`gh repo fork --remote`), and open the pull request against `main`. The
description says what the change does and how it was tested, in technical
terms. Then watch CI and fix what fails.
