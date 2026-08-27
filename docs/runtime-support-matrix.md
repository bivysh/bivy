# Runtime support matrix

Bivy supports multiple agents, but they are not all equally production-ready. The app exposes the same tiers in the agent picker. The **Supported** rows are derived and release-gated by the machine-readable certification matrix; see the generated [Certified Supported agents](supported-agents.md) page. Static profile metadata alone cannot confer Supported status.

The agent **picker** shows the most-used coding agents (the rows below with a
non-italic tier). Everything else stays in the catalog and is runnable via
`BIVY_RUNTIME=<id>`, but is hidden from the picker.

For how to authenticate each picker agent specifically — install command, Bivy
vault vs. the agent's own login, the exact login step, and known gaps — see the
per-agent pages under [docs/agents/](agents/README.md).

| Runtime | id | Tier | In picker | Start web/mobile | Start CLI | Resume | Model picker | Approvals | Native discovery | Auth owner | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Pi](agents/pi.md) | `pi` | Supported | Yes | Yes | Yes | Yes | Yes | Yes | No | Pi | Uses the operator-installed `pi` command and Pi-owned auth/config through the richer bridge under `src/agents/pi`. |
| [Claude Code](agents/claude-code.md) | `claude-code-sdk` | Supported | Yes | Yes | Yes | Yes | Yes | Yes | **Yes** | Claude Code | SDK protocol bridge explicitly targets the operator-installed `claude` command and reuses its native auth/config/sessions. |
| [Codex (approvals)](agents/codex.md) | `codex-approvals` | Supported | Yes | Yes | Partial | Yes | Yes | Yes | **Yes** | Codex CLI/OpenAI | App-server shim: per-tool Approve/Deny, model + reasoning-effort selection, thread resume, usage reporting, native discovery. The single "Codex" surfaced in the picker. Release-tested against Codex CLI 0.150.0. |
| [OpenCode](agents/opencode.md) | `opencode` | Supported | Yes | Yes | Yes | Yes | Yes (ACP) | **Per-tool (Approve/Deny)** | No | OpenCode CLI | Driven through its native `opencode acp` server by default → the governed `ProtocolRuntime`: per-tool approvals, `session/load` resume, and a model list read from the live session. Falls back to the `opencode run` pipe (effect-level governance, `--model`, `-s <id>` resume) when the installed binary has no `acp` subcommand. Release-tested against OpenCode 1.18.23. |
| [Gemini CLI](agents/gemini-cli.md) | `gemini` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Native sandbox (`--approval-mode`) | No | Gemini CLI | `gemini-json` final-object parser; native auth; resumes via `-r <id>` (tier-aware `--approval-mode`). |
| [Qwen Code](agents/qwen-code.md) | `qwen` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Native sandbox (`--approval-mode`) | No | Qwen Code CLI | Gemini-CLI fork: reuses the `gemini-json` parser, approval-mode containment, and `--resume <id>` form. |
| [Goose](agents/goose.md) | `goose` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | No | Goose CLI | `goose-stream-json` streaming parser; resumes via `--resume --session-id <id>`. |
| [Aider](agents/aider.md) | `aider` | Beta | Yes | Yes | Yes | No | Yes (`--model`) | Effect-level (FS/MCP/net) | No | Bivy/provider or Aider config | `aider --message --yes-always`; git-native, single-turn per prompt. No native "continue session `<id>`" flag upstream — its own `--restore-chat-history` continuity is cwd-scoped, not id-based, so it can't plug into the generic primitive. |
| [Cline](agents/cline.md) | `cline` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | No | Cline CLI | Autonomous (`-y`) single task; best-effort flags, override with `BIVY_CLINE_ARGS`; resumes via `--id <id>`. |
| [Crush](agents/crush.md) | `crush` | Beta | Yes | Yes | Yes | No | No | Effect-level (FS/MCP/net) | No | Crush CLI | `crush run -q`; best-effort flags, override with `BIVY_CRUSH_ARGS`. No resume flag upstream yet for `crush run` (tracked in charmbracelet/crush#1982, #1015). |
| [Cursor](agents/cursor.md) | `cursor` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Effect-level (FS/MCP/net) | No | Cursor CLI | `cursor-agent --force -p`; resumes via `--resume=<id>`. |
| [GitHub Copilot](agents/copilot.md) | `copilot` | Beta | Yes | Yes | Yes | No | Yes (`--model`) | Effect-level (FS/MCP/net) | No | Copilot CLI/GitHub | `copilot --allow-all-tools -p`; no pinned by-id resume flag yet (`BIVY_COPILOT_RESUME_TEMPLATE`). |
| [Grok](agents/grok.md) | `grok` | Beta | Yes | Yes | Yes | Yes (`--resume`) | Yes (`-m`, default `grok-4.5`) | Effect-level (FS/MCP/net) | **Yes** | Grok CLI/xAI | Official `grok -p` / `grok --resume <id>` (install via `curl -fsSL https://x.ai/cli/install.sh \| bash`). SuperGrok/X subscription → `~/.grok/auth.json` materialization; API key → `XAI_API_KEY`/`GROK_API_KEY`. `bivy run grok` pins `--session-id` so sessions persist after the PTY exits and can be taken over as chat. |
| [Amp](agents/amp.md) | `amp` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | No | Amp CLI/Sourcegraph | `amp -x`; resumes threads via `amp threads continue <id>`. Model is Amp-managed. |
| [Auggie](agents/auggie.md) | `auggie` | Beta | Yes | Yes | Yes | No | No | Effect-level (FS/MCP/net) | No | Augment CLI | `auggie --quiet --print`; model Augment-managed; no pinned resume flag (`BIVY_AUGGIE_RESUME_TEMPLATE`). |
| [Droid](agents/droid.md) | `droid` | Beta | Yes | Yes | Yes | No | Yes (`--model`) | Effect-level (FS/MCP/net) | No | Factory CLI | `droid exec --auto high`; no pinned resume flag yet (`BIVY_DROID_RESUME_TEMPLATE`). |
| [Continue](agents/continue.md) | `continue` | Beta | Yes | Yes | Yes | No | Yes (`--model`) | Effect-level (FS/MCP/net) | No | Continue CLI | `cn --auto -p`; `--resume` is last-session-only (no by-id form), so resume stays off. |
| [Kilo Code](agents/kilocode.md) | `kilocode` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Effect-level (FS/MCP/net) | No | Kilo CLI | `kilo run --auto` (OpenCode fork); resumes via `-s <id>`. |
| [Rovo Dev](agents/rovodev.md) | `rovodev` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | No | Atlassian acli | `acli rovodev run --yolo`; resumes via `--restore <id>`. Installed out of band (no auto-install). |
| [Codebuff](agents/codebuff.md) | `codebuff` | *Experimental* | No | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | No | Codebuff CLI | Hidden: no verified non-TTY headless mode (`@codebuff/sdk` for automation). Resume `--continue <id>` wired for when a headless flag ships. |
| [Codex (exec)](agents/codex.md) | `codex` | *Supported* | No | Yes | Yes | Yes | No | Effect-level sandbox | No | Codex CLI/OpenAI | Fast no-approval path; superseded in the picker by `codex-approvals`. Runnable via `BIVY_RUNTIME=codex`. Native discovery/adoption lives on `codex-approvals` instead, so an adopted session is governed from the moment it's imported. |
| Hermes | `hermes` | *Experimental* | No | Yes | Yes | No | No | Boundary only | No | Hermes CLI | Generic process adapter, no structured parser, no documented resume flag. |
| OpenClaw | `openclaw` | *Experimental* | No | Yes | Yes | No | No | Boundary only | No | OpenClaw CLI | Phase-1 CLI adapter only; resume needs the future Gateway RPC bridge. |
| Generic CLI | `generic-cli` | *Experimental* | No | Env-configured | Env-configured | Depends | No | Boundary only | No | External CLI | Universal escape hatch; support is best-effort; resumable when `BIVY_AGENT_RESUME_TEMPLATE` is set (same generic primitive as maintained process profiles). |
| Bivy Agent Protocol | `bivy-agent-protocol` | *Experimental* | No | Env-configured | Env-configured | Depends on agent | Depends on agent | Depends on agent | No | Protocol agent | Best path for third-party agents to become fully supported; resumable when the shim advertises `resume: true`. |
| ACP Agent | `acp` | *Experimental* | No | Env-configured | Env-configured | Yes | No | **Per-tool (Approve/Deny)** | No | ACP agent | Any [Agent Client Protocol](https://agentclientprotocol.com) agent (e.g. `gemini --experimental-acp`) driven through `bin/acp-shim.mjs` → the same governed `ProtocolRuntime` as Codex. Configure with `BIVY_ACP_COMMAND` / `BIVY_ACP_ARGS`. See [agents/acp.md](agents/acp.md). |

Every picker CLI agent's launch flags are overridable per node with
`BIVY_<ID>_ARGS` (a JSON array), its resume form with `BIVY_<ID>_RESUME_TEMPLATE`
(a JSON arg array using `{id}`/`{tier}`/`{sandbox}` — `{sandbox}` expands to that
agent's own native containment flags for the tier, e.g. Gemini/Qwen's
`--approval-mode <mode>`), and its selectable model list with `BIVY_<ID>_MODELS`
(a JSON array of `{id,name?,provider?}`), so an operator can adapt to a CLI
version Bivy hasn't pinned — or expose more models — without a code change. Model
selection is wired for the agents with a clean model flag today (Gemini/Qwen
`-m`, Aider/OpenCode `--model`); the others run on their own default until a flag
is wired.

**Resume** is the same generic, data-driven primitive everywhere it's `Yes`
above: a `resume.template` arg array in `AGENT_PROFILES`
(`src/agents/profiles.ts`) or a `BIVY_<ID>_RESUME_TEMPLATE` override. Fresh
structured sessions capture native refs from validated output formats; plugin
agents that accept a caller-assigned id can declare `resume.newArgs`. There is
no per-agent runtime code, matching the ProtocolRuntime resume primitive
(`session.create.resume`) added for Codex/Bivy-agent-protocol. It's `No` only
where the underlying CLI genuinely has no native "continue session `<id>`" form
today (Aider, Crush, Hermes) or the adapter itself isn't there yet (OpenClaw).

**ACP promotion** is the same data-driven idea applied to the *approvals*
column. The `Approvals` values above describe each agent's **default** (pipe)
path, where governance is effect-level (sandbox tier / FS-MCP-network). But any
agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
can instead be driven through `bin/acp-shim.mjs` → the governed `ProtocolRuntime`
— gaining **Approve/Deny for blocking ACP permission requests**, observed tool
activity, **`session/load` resume**, and **model selection** (`session/set_model`, with the list read from the live session so it
matches the providers that node has actually authenticated) with zero per-agent
code. The picker agents that ship a native ACP server declare it as data (an
`acp` field in `AGENT_PROFILES`): **Gemini** (`--experimental-acp`), **Qwen
Code** (`--experimental-acp` / newer `--acp`), **OpenCode** (`acp`), **Goose**
(`acp`), **Kilo Code** (`acp`), **Cursor** (`acp`), **Cline** (`--acp`), and
**GitHub Copilot** (`--acp`).

**OpenCode is promoted by default** (`acp.preferred`), having been validated
end-to-end against 1.18.23 — that governed path is what earns it the Supported
tier. The rest stay opt-in with `BIVY_<ID>_ACP=1` (or `BIVY_PREFER_ACP=1` for all
at once) until they're validated the same way.

Because ACP is a hard switch — once a session opens over the protocol there is no
falling back to the pipe mid-flight — a *default-on* promotion is always gated on
the installed binary evidencing the mode (a cached `--help` probe for the
subcommand). A node whose CLI is too old keeps the pipe path and the picker
honestly reports the lower capabilities, rather than opening a session that hangs
and dies. An explicit `BIVY_<ID>_ACP=1` skips the probe (the operator knows their
binary); `BIVY_<ID>_ACP=0` forces the pipe path back. Agents with no first-party
ACP mode (Aider, Amp, Crush, Continue, Grok) stay on the pipe until one ships.
See [agents/acp.md](agents/acp.md).

Beyond start/resume/model/approvals, the shared layer also surfaces, where the
agent emits it: **token usage** (parsed from the agent's JSON — Gemini/Qwen/Goose
today — via `getUsage`/`capabilities.usageReporting`), a **reasoning/thinking
stream** (rendered as a collapsible thinking block, e.g. Codex reasoning items),
and **reasoning-effort selection** (Codex `-c model_reasoning_effort=<level>`;
enable for any agent with `BIVY_<ID>_THINKING`). Structured file diffs are already
universal (the harness snapshots the worktree each turn → `session.changes`). The
bivy-agent-protocol carries all of these too — a shim advertises models in its
`hello` and answers `model.set`, emits `usage` / `message.reasoning`, resumes its
own thread when it advertises `resume: true` (Bivy passes the ref back on
`session.create`), and receives prompt **image attachments** + the
`streamingBehavior` hint on `chat.send` for multimodal turns.

**Native discovery** (issue #156) is a separate, opt-in capability pair —
`capabilities.nativeSessionDiscovery` / `nativeSessionAdoption` — from ordinary
resume: it lets a runtime enumerate its OWN provider-native sessions on this
node that Bivy never started (a bare `claude` or `codex` run in a terminal) and
offer to import one, via the "Import existing session" sheet in the app.
Discovery returns bounded metadata only (session id, cwd, updated time, a
truncated first-prompt title, and an active/resumable flag) — never transcript
content — and a session Bivy already manages is filtered out (deduped by its
on-disk transcript path or provider session id, whichever the runtime uses).
Importing resumes the session natively through the ordinary open/resume path
without rewriting or deleting the provider's original history whenever the
runtime can (`planNativeAdoption`'s "native-resume" mode — the case for every
Claude Code / Codex session today, since both assign a stable, resumable id).
A runtime that can discover a session but not natively resume it falls back to
a "seeded" continuation — a brand-new session whose first turn is a bounded
summary of the prior conversation (never the full transcript) — and the node
refuses that fallback outright until the caller explicitly acknowledges the
disclosure it returns (`needsDisclosure`/`disclosure` on the `session.import`
response); the app's "Import existing session" sheet shows that disclosure and
requires an explicit "Import anyway" before retrying with acceptance. A live
external process for a session is detected best-effort and blocks adoption
entirely (`"follow-only"` mode) in favor of surfacing the provider's own
resume command (e.g. `claude --resume <id>` / `codex resume <id>`) so the user
can follow it themselves in a terminal, since Bivy has no safe way to take
over a process it doesn't own. Only Claude Code SDK and Codex (via the
governed `codex-approvals` shim, not the plain exec runtime) advertise
discovery today — every other runtime stays hidden from the discovery UI
until its adapter earns the capability, per the capability-driven design in
`src/runtime/native-session-discovery.ts` and `src/session/native-import.ts`.

## Getting more capability out of a CLI agent

A CLI agent's ceiling is set by the *interface* it exposes, not by the wrapper.
Four general, opt-in levers move an agent up that ladder without per-agent code:

- **MCP tool approvals** (`capabilities.mcpToolApprovals`). With `BIVY_MCP_PROXY=1`,
  Bivy rewrites the agent's MCP config so every stdio server launches through
  `bivy mcp-proxy`, which asks the daemon (`/api/mcp/decide` → the same
  `guardianInterceptor` as native approvals) before each `tools/call`. This gives
  real per-tool Approve/Deny for the agent's **MCP** tools (not its built-in
  shell/edits — a narrower, honest capability than full `toolInterception`). See
  `src/harness/mcp-*.ts`.
- **Structured transcripts** (opt-in JSON parsing). Agents with a JSON/stream-json
  mode we haven't validated against the binary carry a tolerant parser
  (`generic-stream-json` / `generic-json`) behind `spec.parserUnverified`: dumb
  pipe by default (a wrong flag can't regress them), `BIVY_AGENT_STRUCTURED=1` opts
  in. The parsers never lose output — an unrecognized shape falls back to raw text.
  Validating one is a one-field spec edit.
- **Capability probing** (`BIVY_AGENT_PROBE=1`). Runs `<cli> --help` and
  *downgrades* any advertised resume/model capability the installed binary no
  longer evidences — self-healing honesty across version drift. It never upgrades.
- **ACP** (`acp` runtime + per-agent promotion). **The preferred way to wrap any
  agent that speaks it** — a one-shot pipe can't gate a tool *before* it runs, so
  ACP is a strict fidelity upgrade. Any [Agent Client Protocol](https://agentclientprotocol.com)
  agent is driven through `bin/acp-shim.mjs` → the governed `ProtocolRuntime`
  (permission-request approvals + observed activity + streaming + resume + model
  selection) as data. Activity that may already be executing is never presented
  as an approval that can still stop it. Use the
  generic runtime (`BIVY_ACP_COMMAND` / `BIVY_ACP_ARGS`), or promote a specific
  agent that declares an `acp` field. OpenCode runs this way by default;
  `BIVY_<ID>_ACP=1` opts in another one and `BIVY_PREFER_ACP=1` promotes every
  ACP-capable agent. A promoted agent honestly gains Approvals + Resume in the
  picker. The pipe path is the fallback for agents that only offer a headless
  print mode, and for a binary too old to speak ACP. See
  [agents/acp.md](agents/acp.md).

Definitions:

- **Supported** — release-certified: the row earns the badge only while the configured execution path matches an active, pinned [agent certification](supported-agents.md), so a release ships only when those paths pass.
- **Beta** — useful and visible, but has known capability gaps.
- **Experimental** — available for advanced users; not release-gated and may change or break between versions.
- **Boundary only** — Bivy can constrain workspace/sandbox/terminal channels, but cannot yet intercept every structured tool call from the agent.
