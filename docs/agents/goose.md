# Goose

Block's open-source agent (`block/goose`), run under Bivy with its
`stream-json` output format for structured streaming.

- **Runtime id:** `goose` · **Tier:** Beta · **In picker:** Yes

## Install

```bash
curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash
```

## Authentication

**Auth owner: agent.** Goose owns its own provider configuration — run it and
follow its own setup; Bivy doesn't drive Goose's native config.

Separately, and automatically: every provider credential in Bivy's vault is
forwarded to the `goose` process each turn as that provider's standard key
variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and so on). This only helps if
Goose's own configuration is set to read that provider from the environment —
Bivy doesn't select a model or provider for Goose itself:

```bash
bivy login   # sign in to whichever provider Goose is configured to use
```

## Models

Not wired — Goose has no model flag configured in Bivy today, so it runs
whatever Goose's own configuration defaults to. `modelSelection` is off for
this runtime.

## Resume

Yes — `goose run --resume --session-id <id> -t "<prompt>"` continues a prior
session by id.

## Known gaps

- Goose has no CLI sandbox/approval flag Bivy can drive, so containment is
  effect-level only (filesystem, MCP, and network channels) rather than a
  native approval mode.
- No model picker, package installs, or session fork through this runtime.

## Run it

Pick Goose in the agent picker, or:

```bash
bivy run goose
```
