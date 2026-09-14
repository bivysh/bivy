# Crush

Charm's open-source coding agent (`@charmland/crush`), run under Bivy as one
non-interactive prompt per turn (`crush run -q`, which suppresses Crush's
spinner UI so stdout is just the reply).

- **Runtime id:** `crush` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @charmland/crush
```

## Authentication

**Auth owner: agent.** Crush owns its own sign-in — run it and follow its own
setup; Bivy doesn't drive Crush's native login.

Separately, and automatically: every provider credential in Bivy's vault is
forwarded to the `crush` process each turn as that provider's standard key
variable, in case Crush's own configuration reads a provider from the
environment:

```bash
bivy provider login   # sign in to whichever provider Crush is configured to use
```

## Models

Not wired — Crush has no model flag configured in Bivy today, so it runs
whatever its own configuration defaults to. `modelSelection` is off for this
runtime.

## Resume

**No.** `crush run` has no session/continue flag upstream yet — tracked in
[charmbracelet/crush#1982](https://github.com/charmbracelet/crush/issues/1982)
and [#1015](https://github.com/charmbracelet/crush/issues/1015). Every prompt
runs as a fresh process. This will switch to a real resume once Crush ships
one, via a data-only change (`resume.template` in `AGENT_PROFILES`), or you
can wire a pre-release flag yourself now with `BIVY_CRUSH_RESUME_TEMPLATE`.

## Known gaps

- No resume (above).
- Governance is effect-level (sandbox tier / FS-MCP-network channels), not
  per-tool approval cards.
- No model picker, package installs, or session fork through this runtime.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_CRUSH_ARGS` if a version differs.

## Run it

Pick Crush in the agent picker, or:

```bash
bivy run crush
```
