# Grok

Open-source terminal agent for xAI's Grok models (`@vibe-kit/grok-cli`), run under
Bivy as one headless prompt per turn (`grok -p`).

- **Runtime id:** `grok` · **Tier:** Beta · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @vibe-kit/grok-cli
```

> Note: a separate fork (superagent `grok-dev`) also installs a `grok` binary but
> with different flags (`--format json`, `-s <id>` resume). If you run that one,
> point Bivy at its flags with `BIVY_GROK_ARGS` / `BIVY_GROK_RESUME_TEMPLATE`.

## Authentication

**Auth owner: agent.** Provide an xAI API key (`GROK_API_KEY` / the CLI's own
`-k`). Bivy also forwards vault provider credentials to the process each turn.

## Models

Wired via `-m <id>` (`grok-code-fast-1`, `grok-4-latest`, `grok-3-fast`). Override
with `BIVY_GROK_MODELS`.

## Resume

**No** for the `@vibe-kit/grok-cli` package (no resume-by-id flag). The superagent
fork supports `-s <id>` — enable it with `BIVY_GROK_RESUME_TEMPLATE`.

## Known gaps

- No resume on the default package (above).
- Governance is effect-level, not per-tool approval cards.
- Launch flags are best-effort; override with `BIVY_GROK_ARGS`.

## Run it

Pick Grok in the agent picker, or:

```bash
bivy run grok
```
