# Auggie

Augment Code's terminal agent (`@augmentcode/auggie`), backed by its codebase
context engine, run under Bivy as one non-interactive turn per prompt
(`auggie --quiet --print`).

- **Runtime id:** `auggie` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @augmentcode/auggie
```

## Authentication

**Auth owner: agent.** Sign in to Augment with its own flow. Bivy also forwards
vault provider credentials to the process each turn.

## Models

Not wired — Augment manages the model, so `modelSelection` is off. Set
`BIVY_AUGGIE_MODELS` if your version exposes a model flag.

## Resume

**No** built-in template. Set `BIVY_AUGGIE_RESUME_TEMPLATE` if your version adds a
resume-by-id flag; otherwise each prompt runs as a fresh process.

## Known gaps

- No resume / model picker wired (above).
- Governance is effect-level, not per-tool approval cards.
- Launch flags are best-effort; override with `BIVY_AUGGIE_ARGS`.

## Run it

Pick Auggie in the agent picker, or:

```bash
bivy run auggie
```
