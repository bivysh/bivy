# Cline

Cline's standalone terminal agent (`cline`) — the CLI sibling of the Cline IDE
extension — run autonomously under Bivy (`cline -y`, which skips per-tool
prompts so a piped run doesn't wedge on approval; Bivy's sandbox tier still
bounds what it can actually do).

- **Runtime id:** `cline` · **Tier:** Beta · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local cline
```

## Authentication

**Auth owner: agent.** Cline owns its own sign-in — run it and follow its own
setup; Bivy doesn't drive Cline's native login.

Separately, and automatically: every provider credential in Bivy's vault is
forwarded to the `cline` process each turn as that provider's standard key
variable, in case Cline's own configuration reads a provider from the
environment:

```bash
bivy login   # sign in to whichever provider Cline is configured to use
```

## Models

Not wired — Cline has no model flag configured in Bivy today, so it runs
whatever its own configuration defaults to. `modelSelection` is off for this
runtime.

## Resume

Yes — `cline --id <id> "<prompt>" -y` resumes an existing session by id.

## Known gaps

**Cline's launch flags are best-effort**, sourced from the Cline CLI reference
rather than validated against every release — override with `BIVY_CLINE_ARGS`
(and `BIVY_CLINE_RESUME_TEMPLATE`) if your installed version differs.
Additionally:

- No native sandbox/approval-mode flag — containment is effect-level only
  (filesystem, MCP, network channels), not a Cline-native mode.
- No model picker, package installs, or session fork through this runtime.

## Run it

Pick Cline in the agent picker, or:

```bash
bivy run cline
```
