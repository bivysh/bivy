# Kimi Code

Moonshot AI's terminal coding agent (`kimi`, the Kimi Code CLI), driven under
Bivy through its native Agent Client Protocol server (`kimi acp`): per-tool
Approve/Deny, streaming, native resume, and model, thinking and mode choices
read from the live session.

- **Runtime id:** `kimi` · **Tier:** Supported · **In picker:** Yes
- **Release-tested against:** Kimi Code 2.6.2

## Install

```bash
npm install --global --prefix ~/.local @moonshot-ai/kimi-code
```

Kimi also ships `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`
and `brew install kimi-code`; any of them puts `kimi` on `PATH`.

## Authentication

**Auth owner: agent.** Sign in once on the machine with Kimi's device-code flow:

```bash
kimi login
```

A signed-out `kimi acp` answers a new session with ACP `auth_required`, which
Bivy shows as the sign-in prompt for the session. Kimi also reads a model from
the environment (`KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`,
`KIMI_MODEL_PROVIDER_TYPE` = `kimi` / `openai` / `anthropic`,
`KIMI_MODEL_BASE_URL`), which works for any compatible provider.

## Models

The model, thinking and mode lists come from the ACP session, so they show what
this machine's Kimi install is configured for. On the fallback pipe path there
is no model picker; Kimi uses its configured default.

## Resume

Yes: natively through ACP `session/load` for the session's own id. On the pipe
path, `kimi -S <id> -p "<prompt>"`.

## Fallback pipe path

When the installed `kimi --help` doesn't list the ACP server (the archived
Python `kimi-cli`), Bivy runs one `kimi -p "<prompt>"` per turn with
effect-level governance. `BIVY_KIMI_ACP=0` forces the pipe path; `=1` forces
ACP without the probe.
