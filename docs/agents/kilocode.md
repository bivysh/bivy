# Kilo Code

Kilo Code's terminal CLI (`@kilocode/cli`, the `kilo` command — an OpenCode fork),
run under Bivy as one non-interactive turn per prompt (`kilo run --auto`, which
auto-approves permissions and streams to stdout).

- **Runtime id:** `kilocode` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install --global --prefix ~/.local @kilocode/cli
```

## Authentication

**Auth owner: agent.** Sign in to Kilo with its own flow. Bivy also forwards vault
provider credentials to the process each turn.

## Models

Wired via `-m <provider/model>` after the `run` subcommand (e.g.
`anthropic/claude-sonnet-4-20250514`, `openai/gpt-5`). Override with
`BIVY_KILOCODE_MODELS`.

## Resume

**Yes.** `kilo run -s <id>` continues a session by id, threaded automatically via
the generic `resume.template` primitive.

## Known gaps

- Governance is effect-level, not per-tool approval cards.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_KILOCODE_ARGS`.

## ACP promotion (per-tool approvals)

Kilo Code ships a native [Agent Client Protocol](https://agentclientprotocol.com)
server (`kilo acp`), so it can be driven through Bivy's governed `ProtocolRuntime`
instead of the `run --auto` pipe — earning **per-tool Approve/Deny** and
`session/load` resume:

```bash
BIVY_KILOCODE_ACP=1 bivy run kilocode   # this agent, via ACP
BIVY_PREFER_ACP=1 …                      # every ACP-capable agent, via ACP
```

Declared as data (`acp: { args: ["acp"] }`); off by default until validated for
your version. See [acp.md](acp.md).

## Run it

Pick Kilo Code in the agent picker, or:

```bash
bivy run kilocode
```
