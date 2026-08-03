# Continue

Continue's headless terminal agent (`@continuedev/cli`, the `cn` command), run
under Bivy as one headless turn per prompt (`cn --auto -p`, where `-p` skips the
TUI and `--auto` allows all tools without prompting).

- **Runtime id:** `continue` · **Tier:** Beta · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @continuedev/cli
```

## Authentication

**Auth owner: agent.** Sign in to Continue Hub with its own flow. Bivy also
forwards vault provider credentials to the process each turn.

## Models

Wired via `--model <slug>` (Continue Hub `owner/model` slugs, e.g.
`anthropic/claude-4-sonnet`, `openai/gpt-5`). Override with `BIVY_CONTINUE_MODELS`.

## Resume

**No** by-id resume. `cn --resume` continues only the *last* session for the
current terminal — there's no resume-by-id form to plug into the generic
primitive, so each Bivy prompt runs as a fresh process.

## Known gaps

- No resume-by-id (above).
- Governance is effect-level, not per-tool approval cards.
- Launch flags are best-effort; override with `BIVY_CONTINUE_ARGS`.

## Run it

Pick Continue in the agent picker, or:

```bash
bivy run continue
```
