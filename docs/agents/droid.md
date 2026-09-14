# Droid

Factory AI's autonomous terminal coding agent (`droid`), run under Bivy as one
headless task per prompt (`droid exec --auto high`, which runs at high autonomy —
auto-approving — and streams to stdout).

- **Runtime id:** `droid` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
curl -fsSL https://app.factory.ai/cli | sh
```

Factory ships a curl installer (not npm) that drops `droid` on your PATH.

## Authentication

**Auth owner: agent.** Sign in to Factory with its own flow. Bivy also forwards
vault provider credentials to the process each turn.

## Models

Wired via `--model <id>` after the `exec` subcommand (`claude-sonnet-4.5`,
`claude-opus-4.1`, `gpt-5-codex`). Override with `BIVY_DROID_MODELS`.

## Resume

**No** built-in template yet. Set `BIVY_DROID_RESUME_TEMPLATE` if your version
documents a resume-by-id flag; otherwise each prompt runs as a fresh process.

## Known gaps

- No resume wired (above).
- Governance is effect-level, not per-tool approval cards.
- Launch flags are best-effort; override with `BIVY_DROID_ARGS`.

## Run it

Pick Droid in the agent picker, or:

```bash
bivy run droid
```
