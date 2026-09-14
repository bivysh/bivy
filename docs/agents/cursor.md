# Cursor

Cursor's standalone terminal coding agent (`cursor-agent`), run under Bivy as one
non-interactive print turn per prompt (`cursor-agent --force -p`, where `-p`
prints headlessly and `--force` auto-approves tool/command execution so a piped
run never blocks).

- **Runtime id:** `cursor` · **Tier:** Supported · **In picker:** Yes

## Install

```bash
curl https://cursor.com/install -fsS | bash
```

Cursor ships a curl installer (not npm) that drops `cursor-agent` on your PATH.

## Authentication

**Auth owner: agent.** Sign in to Cursor with its own flow (`cursor-agent login`).
Separately, Bivy forwards every provider credential in its vault to the process
each turn as that provider's standard key variable.

## Models

Wired via `-m <id>` (`sonnet-4.5`, `opus-4.1`, `gpt-5`). Override the list with
`BIVY_CURSOR_MODELS`.

## Resume

**Yes.** `cursor-agent --resume=<chatId>` continues a prior chat by id, threaded
automatically via the generic `resume.template` primitive.

## Known gaps

- Governance is effect-level (sandbox tier / FS-MCP-network channels), not
  per-tool approval cards.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_CURSOR_ARGS` if a version differs.

## ACP promotion (per-tool approvals)

Cursor's agent speaks the [Agent Client Protocol](https://agentclientprotocol.com)
via `cursor-agent acp`, so it can be driven through Bivy's governed
`ProtocolRuntime` instead of the `--force -p` pipe — earning **per-tool
Approve/Deny** and `session/load` resume:

```bash
BIVY_CURSOR_ACP=1 bivy run cursor      # this agent, via ACP
BIVY_PREFER_ACP=1 …                     # every ACP-capable agent, via ACP
```

Declared as data (`acp: { args: ["acp"] }`); off by default until validated for
your version. See [acp.md](acp.md).

## Run it

Pick Cursor in the agent picker, or:

```bash
bivy run cursor
```
