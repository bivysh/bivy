# Kilo Code

Kilo Code's terminal CLI (`@kilocode/cli`, the `kilo` command — an OpenCode fork),
run under Bivy as one non-interactive turn per prompt (`kilo run --auto`, which
auto-approves permissions and streams to stdout).

- **Runtime id:** `kilocode` · **Tier:** Beta · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @kilocode/cli
```

## Authentication

**Auth owner: agent.** Sign in to Kilo with its own flow. Bivy also forwards vault
provider credentials to the process each turn.

## Models

Wired via `-m <provider/model>` after the `run` subcommand (e.g.
`anthropic/claude-sonnet-4-20250514`, `openai/gpt-5`). Override with
`BIVY_KILOCODE_MODELS`.

## Resume

**Yes.** `kilo run -s <id>` continues a session by id, threaded automatically via
the generic `resume.template` primitive.

## Known gaps

- Governance is effect-level, not per-tool approval cards.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_KILOCODE_ARGS`.

## Run it

Pick Kilo Code in the agent picker, or:

```bash
bivy run kilocode
```
