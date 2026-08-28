# Amp

Sourcegraph's autonomous coding agent (`@sourcegraph/amp`), run under Bivy as one
thread turn per prompt (`amp -x`, which executes and streams to stdout). Amp
doesn't gate tools per-run — it's governed by its own allowlist config plus Bivy's
sandbox tier.

- **Runtime id:** `amp` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @sourcegraph/amp
```

## Authentication

**Auth owner: agent.** Sign in to Amp (`amp login`, synced to ampcode.com). Bivy
also forwards vault provider credentials to the process each turn.

## Models

Not wired — Amp manages model selection itself (agent "mode"), so `modelSelection`
is off for this runtime rather than rendering a picker it can't drive.

## Resume

**Yes**, by thread. `amp threads continue <id> -x` continues a prior thread,
threaded automatically via the generic `resume.template` primitive.

## Known gaps

- No model picker (Amp-managed).
- Governance is effect-level, not per-tool approval cards.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_AMP_ARGS`.

## Run it

Pick Amp in the agent picker, or:

```bash
bivy run amp
```
