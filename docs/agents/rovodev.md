# Rovo Dev

Atlassian's Rovo Dev terminal coding agent, delivered as a subcommand of the
Atlassian CLI (`acli`) and run under Bivy as one instruction per prompt
(`acli rovodev run --yolo`, where `--yolo` skips tool-approval prompts).

- **Runtime id:** `rovodev` · **Tier:** Supported · **In picker:** Yes

## Install

Rovo Dev ships as part of the Atlassian CLI (`acli`), not npm — install it out of
band, then authenticate:

```bash
brew tap atlassian/homebrew-acli && brew install acli   # macOS
acli rovodev auth login
```

(Linux/Windows have equivalent OS installers.) Because it's not an allowlisted
auto-install, the catalog shows Rovo Dev as *external* until `acli` is on PATH.

## Authentication

**Auth owner: agent.** `acli rovodev auth login` (needs an Atlassian API token and
Rovo Dev enabled). Bivy also forwards vault provider credentials to the process
each turn.

## Models

Not wired — models switch via the in-session `/models` command, so
`modelSelection` is off rather than rendering a picker it can't drive.

## Resume

**Yes.** `acli rovodev run --restore <id>` restores a prior session, threaded
automatically via the generic `resume.template` primitive.

## Known gaps

- No model picker (Atlassian-managed).
- No auto-install (install `acli` yourself).
- Governance is effect-level, not per-tool approval cards.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_ROVODEV_ARGS`.

## Run it

Pick Rovo Dev in the agent picker, or:

```bash
bivy run rovodev
```
