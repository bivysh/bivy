# Runtime support matrix

Bivy supports multiple agents, but they are not all equally production-ready. The app exposes the same tiers in the agent picker.

The agent **picker** shows the ten most-used coding agents (the rows below with a
non-italic tier). Everything else stays in the catalog and is runnable via
`BIVY_RUNTIME=<id>`, but is hidden from the picker.

| Runtime | id | Tier | In picker | Start web/mobile | Start CLI | Resume | Model picker | Approvals | Auth owner | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pi | `pi` | Supported | Yes | Yes | Yes | Yes | Yes | Yes | Bivy/Pi provider auth | Best native Bivy integration. |
| Claude Code SDK | `claude-code-sdk` | Supported | Yes | Yes | Yes | Yes | Yes | Yes | Claude/Pi/Bivy depending on mode | Structured SDK path; native Claude CLI login may be needed for TUI handoff. |
| Codex (approvals) | `codex-approvals` | Beta | Yes | Yes | Partial | Yes | No | Yes | Codex CLI/OpenAI | App-server shim: per-tool Approve/Deny + thread resume. The single "Codex" surfaced in the picker. |
| OpenCode | `opencode` | Beta | Yes | Yes | Yes | Yes | Yes (`--model`) | Effect-level sandbox | OpenCode CLI | `opencode run` on the ProcessRuntime path; structured streaming, effect-level governance; resumes via `-s <id>`. |
| Gemini CLI | `gemini` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Native sandbox (`--approval-mode`) | Gemini CLI | `gemini-json` final-object parser; native auth; resumes via `-r <id>` (tier-aware `--approval-mode`). |
| Qwen Code | `qwen` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Native sandbox (`--approval-mode`) | Qwen Code CLI | Gemini-CLI fork: reuses the `gemini-json` parser, approval-mode containment, and `--resume <id>` form. |
| Goose | `goose` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | Goose CLI | `goose-stream-json` streaming parser; resumes via `--resume --session-id <id>`. |
| Aider | `aider` | Beta | Yes | Yes | Yes | No | Yes (`--model`) | Effect-level (FS/MCP/net) | Bivy/provider or Aider config | `aider --message --yes-always`; git-native, single-turn per prompt. No native "continue session `<id>`" flag upstream — its own `--restore-chat-history` continuity is cwd-scoped, not id-based, so it can't plug into the generic primitive. |
| Cline | `cline` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | Cline CLI | Autonomous (`-y`) single task; best-effort flags, override with `BIVY_CLINE_ARGS`; resumes via `--id <id>`. |
| Crush | `crush` | Beta | Yes | Yes | Yes | No | No | Effect-level (FS/MCP/net) | Crush CLI | `crush run -q`; best-effort flags, override with `BIVY_CRUSH_ARGS`. No resume flag upstream yet for `crush run` (tracked in charmbracelet/crush#1982, #1015). |
| Codex (exec) | `codex` | *Supported* | No | Yes | Yes | Yes | No | Effect-level sandbox | Codex CLI/OpenAI | Fast no-approval path; superseded in the picker by `codex-approvals`. Runnable via `BIVY_RUNTIME=codex`. |
| Hermes | `hermes` | *Experimental* | No | Yes | Yes | No | No | Boundary only | Hermes CLI | Generic process adapter, no structured parser, no documented resume flag. |
| OpenClaw | `openclaw` | *Experimental* | No | Yes | Yes | No | No | Boundary only | OpenClaw CLI | Phase-1 CLI adapter only; resume needs the future Gateway RPC bridge. |
| Generic CLI | `generic-cli` | *Experimental* | No | Env-configured | Env-configured | Depends | No | Boundary only | External CLI | Universal escape hatch; support is best-effort; resumable when `BIVY_AGENT_RESUME_TEMPLATE` is set (same generic primitive as the built-in CLI agents). |
| Bivy Agent Protocol | `bivy-agent-protocol` | *Experimental* | No | Env-configured | Env-configured | Depends on agent | Depends on agent | Depends on agent | Protocol agent | Best path for third-party agents to become fully supported; resumable when the shim advertises `resume: true`. |

Every picker CLI agent's launch flags are overridable per node with
`BIVY_<ID>_ARGS` (a JSON array), its resume form with `BIVY_<ID>_RESUME_TEMPLATE`
(a JSON arg array using `{id}`/`{tier}`/`{sandbox}` — `{sandbox}` expands to that
agent's own native containment flags for the tier, e.g. Gemini/Qwen's
`--approval-mode <mode>`), and its selectable model list with `BIVY_<ID>_MODELS`
(a JSON array of `{id,name?,provider?}`), so an operator can adapt to a CLI
version we haven't pinned — or expose more models — without a code change. Model
selection is wired for the agents with a clean model flag today (Gemini/Qwen
`-m`, Aider/OpenCode `--model`); the others run on their own default until a flag
is wired.

**Resume** is the same generic, data-driven primitive everywhere it's `Yes`
above: a `resume.template` arg array in `CLI_AGENT_SPECS`
(`src/runtime/index.ts`) or a `BIVY_<ID>_RESUME_TEMPLATE` override — no
per-agent runtime code, matching the ProtocolRuntime resume primitive
(`session.create.resume`) added for Codex/Bivy-agent-protocol. It's `No` only
where the underlying CLI genuinely has no native "continue session `<id>`" form
today (Aider, Crush, Hermes) or the adapter itself isn't there yet (OpenClaw).

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

Definitions:

- **Supported** — intended for paying-user support once the rest of production gates are green.
- **Beta** — useful and visible, but has known capability gaps.
- **Experimental** — available for advanced users; not part of the paid support promise.
- **Boundary only** — Bivy can constrain workspace/sandbox/terminal channels, but cannot yet intercept every structured tool call from the agent.
