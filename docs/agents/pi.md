# Pi

Bivy connects to the operator-installed [Pi](https://pi.dev) agent. The richer
integration bridge lives under `src/agents/pi/`; it adapts Pi's supported SDK/RPC
surface to Bivy's session contract but does not provide a separate Bivy-owned Pi.
Native terminal launches and hand-offs execute the same `pi` command on `PATH`.

- **Runtime id:** `pi` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# or
bivy agents:install
```

Use `BIVY_PI_COMMAND=/absolute/path/to/pi` on a managed node when the command is
not discoverable through its service `PATH`.

## Authentication and configuration

**Auth owner: mixed.** The integration reads Pi's existing agent directory
(`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) for `models.json`, settings,
extensions, skills, prompts and provider configuration, and signs in with the
logins in Bivy's vault:

- Chat sessions read the vault directly.
- `bivy run pi`, and opening a chat session in Pi's terminal, write the vault's
  logins into that directory's `auth.json` first.
- A login you make in Pi's TUI (`/login`) is folded back into the vault.

Sign in from the app, or with the upstream agent:

```bash
pi
/login
```

## Capabilities

The richer bridge preserves structured streaming, tool governance, model and
thinking selection, packages, queued steer/follow-up input, usage reporting,
and durable Pi transcripts. A chat-to-terminal hand-off runs the installed Pi
CLI against the same session file.

## Run it

```bash
bivy run pi
bivy shim install pi   # optional transparent terminal interception
```
