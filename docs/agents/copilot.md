# GitHub Copilot

GitHub's official terminal coding agent (`@github/copilot`), run under Bivy as one
programmatic turn per prompt (`copilot --allow-all-tools -p`, where `-p` runs
headlessly and `--allow-all-tools` skips per-tool approval so a piped run doesn't
wedge).

- **Runtime id:** `copilot` · **Tier:** Beta · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @github/copilot
```

## Authentication

**Auth owner: agent.** Copilot owns its own GitHub sign-in. Bivy also forwards
vault provider credentials to the process each turn.

## Models

Wired via `--model <id>` (`claude-sonnet-4.5`, `gpt-5`). Override with
`BIVY_COPILOT_MODELS`.

## Resume

**No** built-in template — Copilot's resume-by-id form isn't pinned to a stable
flag yet. Wire one with `BIVY_COPILOT_RESUME_TEMPLATE` if your version documents
it; otherwise every prompt runs as a fresh process.

## Known gaps

- No resume (above).
- Governance is effect-level, not per-tool approval cards.
- Launch flags are best-effort; override with `BIVY_COPILOT_ARGS`.

## Run it

Pick GitHub Copilot in the agent picker, or:

```bash
bivy run copilot
```
