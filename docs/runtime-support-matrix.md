# Runtime support matrix

Bivy supports multiple agents, but they are not all equally production-ready. The app exposes the same tiers in the agent picker.

The agent **picker** shows the ten most-used coding agents (the rows below with a
non-italic tier). Everything else stays in the catalog and is runnable via
`BIVY_RUNTIME=<id>`, but is hidden from the picker.

For how to authenticate each picker agent specifically — install command, Bivy
vault vs. the agent's own login, the exact login step, and known gaps — see the
per-agent pages under [docs/agents/](agents/README.md).

| Runtime | id | Tier | In picker | Start web/mobile | Start CLI | Resume | Model picker | Approvals | Native discovery | Auth owner | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Pi](agents/pi.md) | `pi` | Supported | Yes | Yes | Yes | Yes | Yes | Yes | No | Bivy/Pi provider auth | Best native Bivy integration. |
| [Claude Code SDK](agents/claude-code.md) | `claude-code-sdk` | Supported | Yes | Yes | Yes | Yes | Yes | Yes | **Yes** | Claude/Pi/Bivy depending on mode | Structured SDK path; native Claude CLI login may be needed for TUI handoff. |
| [Codex (approvals)](agents/codex.md) | `codex-approvals` | Beta | Yes | Yes | Partial | Yes | No | Yes | **Yes** | Codex CLI/OpenAI | App-server shim: per-tool Approve/Deny + thread resume. The single "Codex" surfaced in the picker. |
| [OpenCode](agents/opencode.md) | `opencode` | Beta | Yes | Yes | Yes | Yes | Yes (`--model`) | Effect-level sandbox | No | OpenCode CLI | `opencode run` on the ProcessRuntime path; structured streaming, effect-level governance; resumes via `-s <id>`. |
| [Gemini CLI](agents/gemini-cli.md) | `gemini` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Native sandbox (`--approval-mode`) | No | Gemini CLI | `gemini-json` final-object parser; native auth; resumes via `-r <id>` (tier-aware `--approval-mode`). |
| [Qwen Code](agents/qwen-code.md) | `qwen` | Beta | Yes | Yes | Yes | Yes | Yes (`-m`) | Native sandbox (`--approval-mode`) | No | Qwen Code CLI | Gemini-CLI fork: reuses the `gemini-json` parser, approval-mode containment, and `--resume <id>` form. |
| [Goose](agents/goose.md) | `goose` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | No | Goose CLI | `goose-stream-json` streaming parser; resumes via `--resume --session-id <id>`. |
| [Aider](agents/aider.md) | `aider` | Beta | Yes | Yes | Yes | No | Yes (`--model`) | Effect-level (FS/MCP/net) | No | Bivy/provider or Aider config | `aider --message --yes-always`; git-native, single-turn per prompt. No native "continue session `<id>`" flag upstream — its own `--restore-chat-history` continuity is cwd-scoped, not id-based, so it can't plug into the generic primitive. |
| [Cline](agents/cline.md) | `cline` | Beta | Yes | Yes | Yes | Yes | No | Effect-level (FS/MCP/net) | No | Cline CLI | Autonomous (`-y`) single task; best-effort flags, override with `BIVY_CLINE_ARGS`; resumes via `--id <id>`. |
| [Crush](agents/crush.md) | `crush` | Beta | Yes | Yes | Yes | No | No | Effect-level (FS/MCP/net) | No | Crush CLI | `crush run -q`; best-effort flags, override with `BIVY_CRUSH_ARGS`. No resume flag upstream yet for `crush run` (tracked in charmbracelet/crush#1982, #1015). |
| [Codex (exec)](agents/codex.md) | `codex` | *Supported* | No | Yes | Yes | Yes | No | Effect-level sandbox | No | Codex CLI/OpenAI | Fast no-approval path; superseded in the picker by `codex-approvals`. Runnable via `BIVY_RUNTIME=codex`. Native discovery/adoption lives on `codex-approvals` instead, so an adopted session is governed from the moment it's imported. |
| Hermes | `hermes` | *Experimental* | No | Yes | Yes | No | No | Boundary only | No | Hermes CLI | Generic process adapter, no structured parser, no documented resume flag. |
| OpenClaw | `openclaw` | *Experimental* | No | Yes | Yes | No | No | Boundary only | No | OpenClaw CLI | Phase-1 CLI adapter only; resume needs the future Gateway RPC bridge. |
| Generic CLI | `generic-cli` | *Experimental* | No | Env-configured | Env-configured | Depends | No | Boundary only | No | External CLI | Universal escape hatch; support is best-effort; resumable when `BIVY_AGENT_RESUME_TEMPLATE` is set (same generic primitive as the built-in CLI agents). |
| Bivy Agent Protocol | `bivy-agent-protocol` | *Experimental* | No | Env-configured | Env-configured | Depends on agent | Depends on agent | Depends on agent | No | Protocol agent | Best path for third-party agents to become fully supported; resumable when the shim advertises `resume: true`. |

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

Definitions:

- **Supported** — intended for paying-user support once the rest of production gates are green.
- **Beta** — useful and visible, but has known capability gaps.
- **Experimental** — available for advanced users; not part of the paid support promise.
- **Boundary only** — Bivy can constrain workspace/sandbox/terminal channels, but cannot yet intercept every structured tool call from the agent.
