# ACP Agent (Agent Client Protocol)

The **general high-capability adapter**. Any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) — e.g.
`gemini --experimental-acp` — is driven through `bin/acp-shim.mjs` into the same
governed `ProtocolRuntime` that backs Codex approvals. That buys **per-tool
Approve/Deny**, a **streaming transcript**, and **resume** (`session/load`) with
zero per-agent code — the honest, standards-based version of "wrap an agent."

- **Runtime id:** `acp` · **Tier:** Experimental · **In picker:** No (opt-in)

## Why it's the good path

A one-shot stdout pipe (the ProcessRuntime path most CLI agents use) can only
stream text and govern *effects* — it can't gate a tool *before* it runs. ACP is
a bidirectional JSON-RPC surface: the agent asks the client for permission
(`session/request_permission`) before acting, streams `session/update`
notifications, and persists sessions. The shim maps all of that onto Bivy's
protocol:

| ACP | Bivy |
| --- | --- |
| `session/update` `agent_message_chunk` | streaming assistant text |
| `session/update` `agent_thought_chunk` | reasoning block |
| `session/update` `tool_call` / `tool_call_update` | tool card + result |
| `session/request_permission` | a governed `tool.call` → Approve/Deny → the selected ACP option |
| `session/load` | resume a prior session |
| `fs/read_text_file` / `fs/write_text_file` | serviced against the workspace |

## Configure

```bash
# Point Bivy at any ACP agent's launch command.
export BIVY_ACP_COMMAND=gemini
export BIVY_ACP_ARGS='["--experimental-acp"]'   # optional JSON array
BIVY_RUNTIME=acp bivy run acp
```

Until it's validated against a specific agent it stays **hidden from the picker**
(honest — no unproven picker entries). Once validated, promote it into the picker
as a data-only change.

### Per-agent promotion (the preferred direction)

ACP is the **preferred way to wrap an agent that speaks it** — a one-shot stdout
pipe can never gate a tool before it runs, so ACP is a strict capability upgrade.
An agent declares it as data with an `acp` field in `CLI_AGENT_SPECS`, and is then
driven through the ACP path (instead of the pipe) when it's preferred:

```bash
# Gemini CLI already declares acp: { args: ["--experimental-acp"] }.
BIVY_GEMINI_ACP=1 bivy run gemini        # this agent, via ACP
BIVY_PREFER_ACP=1 …                       # every ACP-capable agent, via ACP
```

When promoted, the agent honestly gains **Approvals** and **Resume** in the
picker (it's now the governed ProtocolRuntime, not the pipe). It's off by default
until validated for your version — the North Star is that every agent which
speaks ACP is wrapped this way, with the pipe reserved for agents that only offer
a headless print mode.

#### Agents that declare an ACP mode today

Each of these ships a native ACP server, so it declares `acp` and can be promoted
with `BIVY_<ID>_ACP=1` (or `BIVY_PREFER_ACP=1` for all of them at once):

| Agent | id | Launch flag | Promote with |
| --- | --- | --- | --- |
| Gemini CLI | `gemini` | `--experimental-acp` | `BIVY_GEMINI_ACP=1` |
| Qwen Code | `qwen` | `--experimental-acp` (newer builds: `--acp`) | `BIVY_QWEN_ACP=1` |
| OpenCode | `opencode` | `acp` | `BIVY_OPENCODE_ACP=1` |
| Goose | `goose` | `acp` | `BIVY_GOOSE_ACP=1` |
| Kilo Code | `kilocode` | `acp` | `BIVY_KILOCODE_ACP=1` |
| Cursor | `cursor` | `acp` | `BIVY_CURSOR_ACP=1` |
| Cline | `cline` | `--acp` | `BIVY_CLINE_ACP=1` |
| GitHub Copilot | `copilot` | `--acp` | `BIVY_COPILOT_ACP=1` |

Agents with no native ACP mode (Aider, Amp, Crush, Continue, Grok, …) stay on the
one-shot pipe — only community bridge adapters exist upstream, which Bivy doesn't
bundle. When one of them ships a first-party ACP server, promoting it is a one-line
`acp` field, no runtime code.

## Capabilities

- **Approvals:** Yes — per-tool, via `session/request_permission`.
- **Resume:** Yes — `session/load` (Bivy passes the session ref back).
- **Models:** Not part of core ACP, so no model picker is advertised.

## Known gaps / notes

- Experimental: the shim is validated against the ACP spec and a stub agent in
  CI (`test/acp-adapter.test.ts`), not yet against every shipping ACP agent —
  validate for your agent before relying on it.
- `terminal/*` client methods are declined (the agent falls back); `fs/*` reads
  and writes are serviced directly within the workspace sandbox.
