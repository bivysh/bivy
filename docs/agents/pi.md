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

**Auth owner: Pi.** The packaged integration reads Pi's existing agent directory
(`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) and therefore uses the same
`auth.json`, `models.json`, settings, extensions, skills, prompts, and provider
configuration as an ordinary Pi terminal session.

Sign in using the upstream agent:

```bash
pi
/login
```

Bivy's separate provider vault remains available to integrations that explicitly
choose it, but the default Pi integration does not replace the user's Pi login.

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
