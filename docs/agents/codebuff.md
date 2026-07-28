# Codebuff

Open-source multi-agent terminal coding assistant (`codebuff`). Supported as a
Bivy runtime, but **hidden from the agent picker**.

- **Runtime id:** `codebuff` · **Tier:** Experimental · **In picker:** No

## Why it's hidden

Bivy's picker only shows agents whose capabilities are honest end to end. The
`codebuff` binary has **no verified non-TTY headless / print-and-exit mode**: its
trailing-arg form (`codebuff "<prompt>"`) seeds the interactive TUI, and true
one-prompt-per-process automation is meant to go through `@codebuff/sdk`. A picker
entry driven over a pipe would therefore hang.

The spec is still wired (on the same data-driven ProcessRuntime path as every
other CLI agent), so Codebuff is **runnable** and promotes into the picker as a
data-only change the moment a headless flag ships upstream.

## Install

```bash
npm install --global --prefix ~/.local codebuff
```

## Resume

`codebuff --continue <id>` continues a prior conversation by id — wired as the
generic `resume.template`, so resume works once the headless-launch gap is closed.

## Run it

```bash
BIVY_RUNTIME=codebuff bivy run codebuff
```

If your Codebuff version gains a headless flag, point Bivy at it with
`BIVY_CODEBUFF_ARGS` and add `codebuff` to `PICKER_RUNTIME_IDS` to surface it.
