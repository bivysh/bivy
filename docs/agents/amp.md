# Amp

Amp's autonomous coding agent (npm package `@sourcegraph/amp`), run under Bivy as
one thread turn per prompt (`amp -x`, execute mode). Bivy launches it with
`--stream-json`, Amp's Claude Code-compatible stream JSON, and parses it with the
same `claude-stream-json` parser used for Claude Code, so assistant text, tool
calls, and tool results render as a structured transcript. Amp doesn't gate tools
per-run — it's governed by its own permissions config plus Bivy's sandbox tier.

- **Runtime id:** `amp` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @sourcegraph/amp
```

## Authentication

**Auth owner: agent.** Sign in to Amp with `amp login` (a device-code flow
against ampcode.com), or set `AMP_API_KEY`. Bivy also forwards vault provider
credentials to the process each turn.

## Launch

- Fresh turn: `amp --no-archive-after-execute --stream-json -x "<prompt>"`.
  Execute mode archives a new thread when the turn ends, and an archived thread
  can't be continued, so Bivy keeps it unarchived.
- Without structured mode (`BIVY_AGENT_STRUCTURED=0`), Bivy runs plain `amp -x`,
  which prints only the last assistant message (no tool cards, no resume).

## Models and modes

There's no model picker because Amp picks the model for each **agent mode**.
Bivy shows the mode in its level picker: `low`, `medium` (default), `high`,
`ultra`, passed as `-m <mode>`. `-m` is a global option, so it also applies to a
continued thread and switches that thread's mode from then on.

## Resume

**Yes**, by thread. The thread id (`T-…`) comes from the stream's `session_id`,
and the next turn runs `amp threads continue <id> --stream-json -x "<prompt>"`.
This uses the generic `resume.template` primitive and also works when a stored
session is reopened.

## Known gaps

- No model picker (Amp chooses the model per mode).
- Governance is effect-level, not per-tool approval cards.
- No token-usage reporting (Amp's final `result` line carries no usage totals).
- Validated against Amp CLI `0.0.1791201662`. Amp ships continuous builds, so
  you can override the launch flags with `BIVY_AMP_ARGS` if a later version
  changes them.

## Run it

Pick Amp in the agent picker, or:

```bash
bivy run amp
```
