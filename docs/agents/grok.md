# Grok

xAI's official Grok coding agent (`grok`), run under Bivy as one headless prompt
per turn (`grok -p` / `--single`).

- **Runtime id:** `grok` · **Tier:** Supported · **In picker:** Yes

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
current catalog (`grok-4.5`). Override with `BIVY_GROK_MODELS` (JSON array of
`{id,name?,provider?}`) if your install exposes more.

## Resume

**Yes** for the official CLI:

- Headless: `grok --resume <id> -p "<prompt>"` (Bivy's process runtime uses this).
- Interactive: `grok --resume <id>` (chat → terminal hand-off, `bivy resume`).
- Sessions live under `~/.grok/sessions/<url-encoded-cwd>/<uuid>/`.
- `bivy run grok` pins a session id at launch (`--session-id`) so takeover and
  the durable session list have a stable target after the PTY exits.

## Known gaps

- Governance is effect-level, not per-tool approval cards.
- Launch flags are best-effort; override with `BIVY_GROK_ARGS`.
- A node that still has `@vibe-kit/grok-cli` first on `PATH` will keep asking for
  `GROK_API_KEY` even after an OAuth sign-in — install the official CLI (or put
  it ahead of vibe-kit on `PATH`).

## Run it

Pick Grok in the agent picker, or:

```bash
bivy run grok
```
