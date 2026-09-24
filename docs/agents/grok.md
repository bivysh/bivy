# Grok

xAI's official Grok coding agent (`grok`), driven through its native ACP server
(`grok agent stdio`) by default → the governed `ProtocolRuntime`: per-tool
Approve/Deny, native resume, and a model list read from the live session. An
older binary without the ACP mode falls back to one headless prompt per turn
(`grok -p` / `--single`); force that path with `BIVY_GROK_ACP=0`.

- **Runtime id:** `grok` · **Tier:** Supported · **In picker:** Yes
- **Release-tested against:** Grok CLI 1.0.41 (the governed ACP path)

## Install

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Verify with `grok --version`. The binary lands on your PATH (typically
`~/.grok/bin/grok`); restart the shell or the Bivy node if the agent picker
still reports it missing.

> **Note:** the older community package `@vibe-kit/grok-cli` also installs a
> `grok` binary, but it **only accepts API keys** and cannot use a SuperGrok /
> X Premium subscription. Prefer the official install above so Bivy's OAuth
> sign-in works.

## Authentication

**Auth owner: Bivy (or agent).** Two equivalent paths:

1. **Subscription (recommended)** — under **Keys & OAuth → xAI**, choose
   *Use a subscription* (device-code OAuth). Bivy stores the tokens in the node
   vault and **mints `~/.grok/auth.json`** for the Grok CLI on each run (same
   OAuth app the official CLI uses: client id `b1a00492-…`, scopes include
   `grok-cli:access`). No separate `grok login` is required.
2. **API key** — add an xAI API key under Keys & OAuth. Bivy projects it as
   `XAI_API_KEY` and `GROK_API_KEY` so both the official CLI and vibe-kit forks
   pick it up.

You can also sign in on the node directly with `grok login` (or
`grok login --device-code` headless); Bivy folds that login back into the vault
when a Grok session ends.

## Models

Wired via `-m <id>`. The curated default matches the official Grok CLI's
current catalog (`grok-4.6`, per the authenticated model catalog). Override with
`BIVY_GROK_MODELS` (JSON array of `{id,name?,provider?}`) if your install exposes
more.

## Reasoning effort

**Yes.** Grok's reasoning models expose `--reasoning-effort <EFFORT>`; Bivy wires
the reasoning/thinking picker to it with the levels the authenticated catalog
advertises — `low`, `medium`, `high` (default), and `xhigh`. Leaving it untouched
runs on the agent's own default; picking a level threads through the resume path
too, so a continued turn keeps the chosen effort. Override the levels/flag with
`BIVY_GROK_THINKING` (JSON `{levels,template,insertAt?,default?}`).

## Resume

**Yes** for the official CLI:

- Headless: `grok --resume <id> -p "<prompt>"` (Bivy's process runtime uses this).
- Interactive: `grok --resume <id>` (chat → terminal hand-off, `bivy resume`).
- Sessions live under `~/.grok/sessions/<url-encoded-cwd>/<uuid>/`.
- `bivy run grok` pins a session id at launch (`--session-id`) so takeover and
  the durable session list have a stable target after the PTY exits.

## Known gaps

- On the pipe fallback (`BIVY_GROK_ACP=0` or a pre-ACP binary), governance is
  effect-level, not per-tool approval cards.
- Launch flags are best-effort; override with `BIVY_GROK_ARGS`.
- A node that still has `@vibe-kit/grok-cli` first on `PATH` will keep asking for
  `GROK_API_KEY` even after an OAuth sign-in — install the official CLI (or put
  it ahead of vibe-kit on `PATH`).

## Run it

Pick Grok in the agent picker, or:

```bash
bivy run grok
```
